// verification/document.ts — le vérificateur d'un DOCUMENT : un fichier qui
// n'appartient à aucun projet de code, et qui se vérifie SANS POUVOIR.
//
// POURQUOI CE FICHIER EXISTE (plan « Créer, c'est prouver », point 4). Un
// skill écrit par un agent — `SKILL.md`, `base.css`, `base.html` — affichait
// « non configuré » : tout ce qu'un outil de fichiers écrivait était typé
// « projet de code », Nodal cherchait les commandes de test du dossier, n'en
// trouvait pas, et le disait. Le travail n'avait aucun test à lancer ; il
// avait trois fichiers à CONSTATER.
//
// Ce que « vérifier un document » veut dire, et rien d'autre : il existe à
// l'endroit annoncé, il n'est pas vide, il se décode en UTF-8, et il est bien
// formé pour ce qu'il est — un markdown a un titre, un CSS et un HTML se
// referment, un JSON et un SVG se parsent. Rien de tout cela n'exécute quoi
// que ce soit du dépôt : aucune approbation, aucune configuration, aucune
// commande. `loadConfig` rend donc TOUJOURS `ready`, avec une séquence vide.
//
// Chaque constat est rendu comme une « commande » de preuve — `exists`,
// `not-empty`, `utf8`, `well-formed:<type>` — parce que c'est la forme que
// `verification_runs` et l'écran connaissent déjà : une ligne par constat, la
// raison dans `stderrTail`, et l'arrêt au premier rouge. Un score n'aurait
// rien dit ; quatre lignes disent lequel a échoué et pourquoi.
//
// Une extension inconnue s'arrête aux trois constats communs et l'ÉCRIT dans
// le dernier — jamais une règle inventée pour un type qu'on ne connaît pas
// (invariant #4).

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { Tokenizer, TokenizerMode, type Token } from 'parse5';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';
import type {
  DeliverableVerifier,
  LoadedConfig,
  OnCommandDone,
  ProofCommandRecord,
  ProofResult,
  ReadyConfig,
  VerifierTarget,
} from './types.ts';

const documentDeliverableType = 'document' as const;

/**
 * Le « manifeste » d'un document est la version de ces règles, et il n'est que
 * la MOITIÉ de ce que `loadConfig` renvoie : l'empreinte complète y est suivie
 * de celle du CONTENU du fichier (constat C1). La primitive compare cette
 * empreinte avant et après la preuve pour savoir si la configuration a bougé ;
 * pour un document, elle bouge donc de deux façons — une nouvelle version de
 * ces règles, ou une écriture dans le fichier pendant la preuve. Ce commentaire
 * n'en disait qu'une (passe 8, constat R3).
 */
// v2 (#487) : les règles binaires (WAV) ont rejoint les règles texte.
export const DOCUMENT_MANIFEST_HASH = 'document-rules/v2';

/**
 * L'empreinte du CONTENU du fichier au moment où la configuration est lue —
 * un sha256, ou `absent` / `not-a-file`.
 *
 * Pourquoi elle entre dans le `manifestHash` (revue Codex post-merge de la
 * PR #66, constat C1, BLOQUANT). La primitive relit la configuration après la
 * preuve et compare `epoch` et `manifestHash` : différents ⇒ ce qui vient
 * d'être prouvé n'est plus l'arbre courant, l'état reste sale. Pour un projet
 * de code, l'intention d'un AUTRE job avance l'epoch partagé de
 * `code_projects`, et la garde joue. Pour un document, les deux étaient
 * CONSTANTS : un autre job pouvait remplacer le fichier pendant la preuve, et
 * la garde de génération — qui ne voit que les écritures de CE job — laissait
 * passer un VERT sur un contenu qui n'était plus sur le disque.
 *
 * Le fichier EST la configuration d'un document : son empreinte est donc son
 * manifeste.
 *
 * C'est le CONTENU qui est haché, pas ses métadonnées. La première version
 * prenait taille et mtime, et laissait passer une réécriture de même taille
 * dans la même granularité de mtime — un résidu nommé dans le commit, que la
 * passe 2 a refusé de considérer comme fermé, à raison : « annoncé » n'est pas
 * « absent ». Un document tient dans quelques kilo-octets et la primitive le
 * lit déjà pour le prouver ; le hacher coûte une lecture de plus et ne laisse
 * rien passer.
 */
async function fileStamp(path: string): Promise<string> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return 'not-a-file';
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    return 'absent';
  }
}

/** Un constat : sa ligne dans `verification_runs`. */
type Constat = Omit<ProofCommandRecord, 'rank'>;

const ok = (command: string, note = '', durationMs = 0): Constat => ({
  command,
  outcomeKind: 'exit',
  exitCode: 0,
  stdoutTail: note,
  stderrTail: '',
  durationMs,
  verdict: 'green',
});

const ko = (command: string, reason: string, durationMs = 0): Constat => ({
  command,
  outcomeKind: 'exit',
  exitCode: 1,
  stdoutTail: '',
  stderrTail: reason,
  durationMs,
  verdict: 'red',
});

// ─── Bien formé, par type ───────────────────────────────────────────────────

/** `null` = bien formé ; sinon la raison, avec sa ligne quand on la connaît. */
type FormCheck = (text: string) => string | null;

/**
 * Les en-têtes de métadonnées, tels qu'ils s'écrivent vraiment : ouverts par
 * `---` (YAML) ou `+++` (TOML, employé par Hugo), et fermés par le même filet —
 * sauf le YAML, qui admet aussi `...` comme fin de document, la forme que
 * Pandoc accepte.
 *
 * Une boucle de lignes, et non une expression régulière : celle qu'elle
 * remplace ne connaissait qu'une seule des trois clôtures, et sa recherche
 * paresseuse manquait l'en-tête VIDE — elle allait chercher la fermeture au
 * filet suivant et emportait le vrai titre avec (passe 7, constats R1 et R2 :
 * un faux vert et un faux rouge dans la même ligne).
 *
 * Un en-tête jamais refermé n'en est pas un : le texte est rendu tel quel, et
 * `---` redevient ce que CommonMark en dit, un filet.
 */
const FRONT_MATTER: ReadonlyArray<{ open: string; close: readonly string[] }> = [
  { open: '---', close: ['---', '...'] },
  { open: '+++', close: ['+++'] },
];

function stripFrontMatter(lf: string): string {
  const lines = lf.split('\n');
  const trimEnd = (line: string): string => line.replace(/[ \t]+$/, '');
  const fence = FRONT_MATTER.find((candidate) => candidate.open === trimEnd(lines[0] ?? ''));
  if (fence === undefined) return lf;
  for (let i = 1; i < lines.length; i += 1) {
    if (fence.close.includes(trimEnd(lines[i] ?? ''))) return lines.slice(i + 1).join('\n');
  }
  return lf;
}

/**
 * Un markdown a un titre : un `heading` de profondeur 1 dans l'arbre.
 *
 * POURQUOI UN VRAI PARSEUR. Cette règle a eu CINQ formes en cinq passes de
 * revue, et j'ai réécrit CommonMark à la main quatre fois. Chaque approximation
 * fermait un cas et en ouvrait un autre, jusqu'à une régression : un `- ~~~`
 * situé À L'INTÉRIEUR d'un bloc de code lu comme une clôture, donc un document
 * sans titre déclaré vert. La liste de ce qui s'est cassé en route — fin
 * d'entrée sous le drapeau `m`, longueur et caractère de la clôture, backtick
 * dans la ligne d'info, tabulation valant quatre colonnes, lignes recollées
 * fabriquant un titre souligné, conteneurs invisibles à une boucle de lignes —
 * dit assez que le problème n'était pas la qualité des expressions régulières.
 *
 * `remark-parse` répond à la question sans en inventer une autre. Il est déjà
 * épinglé dans ce dépôt, à la même version, pour le même travail côté écran.
 *
 * Profondeur 1 : c'est le TITRE du document qui est demandé, pas une section.
 * Un fichier qui commence par `## Détails` n'a pas de titre, et c'est voulu —
 * c'est exactement ce qu'un skill mal écrit produit.
 *
 * L'EN-TÊTE YAML est retiré AVANT de parser, et il faut qu'il le soit :
 * `remark-parse` ne connaît pas le front matter, donc il lit `---` comme un
 * filet et son contenu comme de la prose — un COMMENTAIRE YAML `# titre` y
 * devient un vrai `heading` de profondeur 1, et un document sans titre repasse
 * au vert. C'est le constat C5 de la passe 1, que ce remplacement avait
 * réintroduit sans le vouloir (passe 6, constat R1). Les fins de ligne sont
 * ramenées au LF d'abord : une convention d'éditeur n'est pas une propriété du
 * document.
 *
 * UNE SEULE LECTURE, celle du document sans son en-tête. La passe 8 m'avait
 * fait exiger le titre des DEUX côtés du retrait, pour refuser un document dont
 * la clôture d'en-tête vivait dans un bloc de code. C'était une règle inventée
 * de plus, et la passe 9 l'a défaite en une ligne : deux TÉMOINS DIFFÉRENTS
 * suffisaient à la satisfaire. Mesuré depuis, hors dépôt, contre
 * `remark-frontmatter` 5.0.0, la mise en œuvre de référence de cette
 * convention : elle lit l'en-tête exactement comme cette boucle — première
 * ligne délimiteur, puis jusqu'au délimiteur suivant, où qu'il soit — et rend
 * le même verdict sur les dix cas sondés — configurée `['yaml', 'toml']`, elle
 * connaît `+++` comme ici — sauf sur UN point où cette règle est plus stricte :
 * la clôture `...`, qu'elle ignore. Le document dont l'en-tête recouvre une
 * ouverture de bloc n'est donc pas un faux vert : son titre est dans le corps
 * pour la référence de cette convention, et c'est la seule autorité invoquée
 * ici — un sondage n'est pas une preuve d'universalité (passe 10). La
 * conjonction, elle, rendait rouge un en-tête parfaitement valide dont un
 * scalaire contenait trois backticks (passe 9, constat R2).
 */
const markdownHasTitle: FormCheck = (text) => {
  const lf = text.replace(/\r\n?/g, '\n');
  const tree = unified().use(remarkParse).parse(stripFrontMatter(lf));
  const hasTitle = (tree.children ?? []).some(
    (node) => node.type === 'heading' && (node as { depth?: number }).depth === 1,
  );
  return hasTitle ? null : 'no title: expected a top-level heading (`# Title`)';
};

/**
 * Un CSS se referme : chaque `{`, `(` et `[` trouve sa fermeture, dans l'ordre,
 * et aucune chaîne ni aucun commentaire ne reste ouvert.
 *
 * Pourquoi pas un parseur CSS : sondé, `css-tree` en mode tolérant acceptait
 * `.a { color: red` (bloc jamais refermé) et refusait `.a { .b {} }` (la
 * syntaxe d'imbrication moderne). Trop laxiste là où ça compte, trop strict là
 * où ça ne compte pas : la structure qui se referme est ce que « s'analyse »
 * veut dire pour un document, et elle se vérifie sans grammaire.
 */
const cssCloses: FormCheck = (text) => {
  const CLOSE: Readonly<Record<string, string>> = { '{': '}', '(': ')', '[': ']' };
  const stack: Array<{ ch: string; line: number }> = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n') {
      line += 1;
      continue;
    }
    // Un ANTISLASH échappe le caractère suivant, y compris une accolade dans
    // un nom de classe (`.foo\{`). Constat C7 de la revue Codex de la PR #66 :
    // sans ça, `.foo\{ { color: red; }` était rapporté comme un bloc jamais
    // refermé — un rouge sur un fichier valide, le pire des verdicts.
    if (c === '\\') {
      if (text[i + 1] === '\n') line += 1;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return `comment opened at line ${line} is never closed`;
      line += (text.slice(i, end).match(/\n/g) ?? []).length;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < text.length && text[j] !== c; j++) {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '\n') return `string opened at line ${line} is never closed`;
      }
      if (j >= text.length) return `string opened at line ${line} is never closed`;
      i = j;
      continue;
    }
    if (c in CLOSE) {
      stack.push({ ch: c, line });
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      const top = stack.pop();
      if (top === undefined) return `'${c}' at line ${line} closes nothing`;
      if (CLOSE[top.ch] !== c) {
        return `'${top.ch}' opened at line ${top.line} is closed by '${c}' at line ${line}`;
      }
    }
  }
  const left = stack[stack.length - 1];
  return left === undefined ? null : `'${left.ch}' opened at line ${left.line} is never closed`;
};

/**
 * Un HTML se referme.
 *
 * Le parseur HTML5 complet ne le dit PAS : la norme referme d'elle-même un
 * `<div>` resté ouvert à `</body>`, et `parse5` ne signale rien. On lit donc
 * les balises une à une (son tokenizer) et on tient la pile des éléments dont
 * la balise fermante est OBLIGATOIRE — ni les vides (`<br>`, `<img>`…), ni
 * ceux dont la norme permet d'omettre la fin (`<p>`, `<li>`, `<td>`…). Un
 * élément de cette pile qui n'est pas refermé avant `</body>`, avant son
 * parent, ou avant la fin du fichier, est une faute ; un `</x>` sans `<x>`
 * ouvert aussi.
 *
 * Tolérances assumées, parce qu'elles ne cassent aucun navigateur : pas de
 * doctype, et `<div/>` (la norme ignore la barre — l'élément reste ouvert et
 * doit se refermer, exactement comme `<div>`). Dans un `<svg>` ou un `<math>`
 * la barre referme bel et bien l'élément (contenu étranger).
 */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const OPTIONAL_END_TAG = new Set([
  'html',
  'head',
  'body',
  'p',
  'li',
  'dt',
  'dd',
  'option',
  'optgroup',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'colgroup',
  'caption',
  'rb',
  'rt',
  'rtc',
  'rp',
]);
/** Ce que le PARSEUR fait après ces balises : sans ça, `<script>` serait lu comme du HTML. */
const RAW_TEXT_MODE: Readonly<Record<string, number>> = {
  script: TokenizerMode.SCRIPT_DATA,
  style: TokenizerMode.RAWTEXT,
  xmp: TokenizerMode.RAWTEXT,
  iframe: TokenizerMode.RAWTEXT,
  noembed: TokenizerMode.RAWTEXT,
  noframes: TokenizerMode.RAWTEXT,
  textarea: TokenizerMode.RCDATA,
  title: TokenizerMode.RCDATA,
  plaintext: TokenizerMode.PLAINTEXT,
};

const htmlCloses: FormCheck = (text) => {
  const open: Array<{ name: string; line: number }> = [];
  let foreign = 0;
  let fault: string | null = null;
  const lineOf = (t: Token.TagToken): number => t.location?.startLine ?? 0;

  const tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onStartTag(token) {
        const name = token.tagName;
        if (name === 'svg' || name === 'math') foreign += 1;
        const mode = RAW_TEXT_MODE[name];
        // `<script>` et `<style>` portent du JS et du CSS DANS un `<svg>` comme
        // hors de lui : leur contenu n'est jamais du balisage. Constat C8 de la
        // revue Codex de la PR #66 — le mode n'était posé que hors contenu
        // étranger, donc une chaîne CSS contenant `<div>` à l'intérieur d'un
        // `<svg>` faisait rougir un fichier valide. Les autres modes restent
        // réservés au HTML : ces éléments-là n'existent pas en contenu étranger.
        const rawInForeign = name === 'script' || name === 'style';
        if (mode !== undefined && (foreign === 0 || (rawInForeign && !token.selfClosing))) {
          tokenizer.state = mode;
        }
        if (VOID_ELEMENTS.has(name) || OPTIONAL_END_TAG.has(name)) return;
        if (foreign > 0 && token.selfClosing) {
          if (name === 'svg' || name === 'math') foreign -= 1;
          return;
        }
        open.push({ name, line: lineOf(token) });
      },
      onEndTag(token) {
        const name = token.tagName;
        if (fault !== null) return;
        if (name === 'svg' || name === 'math') foreign = Math.max(0, foreign - 1);
        if (VOID_ELEMENTS.has(name) || OPTIONAL_END_TAG.has(name)) {
          // `</body>` et `</html>` referment le document : ce qui reste ouvert
          // au-dessus est une faute, dite sur l'élément le plus profond.
          if ((name === 'body' || name === 'html') && open.length > 0) {
            const top = open[open.length - 1]!;
            fault = `<${top.name}> opened at line ${top.line} is never closed (reached </${name}> at line ${lineOf(token)})`;
          }
          return;
        }
        const top = open[open.length - 1];
        if (top?.name === name) {
          open.pop();
          return;
        }
        const known = open.some((e) => e.name === name);
        fault = !known
          ? `</${name}> at line ${lineOf(token)} closes nothing`
          : `<${top!.name}> opened at line ${top!.line} is never closed (reached </${name}> at line ${lineOf(token)})`;
      },
      onEof() {
        if (fault === null && open.length > 0) {
          const top = open[open.length - 1]!;
          fault = `<${top.name}> opened at line ${top.line} is never closed (end of file)`;
        }
      },
      onCharacter() {},
      onWhitespaceCharacter() {},
      onNullCharacter() {},
      onComment() {},
      onDoctype() {},
      onParseError() {},
    },
  );
  tokenizer.write(text, true);
  return fault;
};

const jsonParses: FormCheck = (text) => {
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * Cette plainte du parseur porte-t-elle sur une entité que le document DÉCLARE
 * lui-même ?
 *
 * `@xmldom/xmldom` ne lit pas le sous-ensemble interne d'un DOCTYPE : il
 * rapporte `entity not found` pour une entité parfaitement déclarée, et retenir
 * ce niveau faisait rougir du XML valide (dette #66, passe 2, R3).
 *
 * La première version cherchait un DOCTYPE à crochet ouvrant, et se trompait
 * DANS LES DEUX SENS (passe 3, R4 et R5) : un sous-ensemble vide ou un simple
 * commentaire suffisait à éteindre TOUS les `error`, rouvrant le trou d'origine,
 * tandis qu'un `>` à l'intérieur d'un identifiant système — permis par la
 * grammaire XML — faisait manquer un vrai sous-ensemble.
 *
 * On ne regarde donc plus le DOCTYPE du tout. Le message du parseur NOMME
 * l'entité ; on ne fait taire la plainte que si CETTE entité-là est déclarée.
 * Deux limites restent, et se disent plutôt que de se corriger de travers :
 *
 * - une entité dont le NOM porte un point (`&a.b;`) est illisible par ce
 *   parseur, qui rend `EntityRef: expecting ;` — le MÊME message qu'elle soit
 *   déclarée ou non, mesuré. On ne peut donc pas les séparer, et faire taire ce
 *   message ferait passer un `&foo` sans point-virgule, lui bien malformé. Le
 *   document valide est donc dit ROUGE : c'est le côté sûr, et c'est une gêne ;
 * - la recherche de déclaration est textuelle. Elle retire d'abord les
 *   commentaires et les sections CDATA, mais ne parse pas le sous-ensemble
 *   interne.
 */
function isDeclaredEntityComplaint(text: string, message: string): boolean {
  const named = /entity not found\s*:?\s*&?([A-Za-z_:][\w.:-]*)/i.exec(message);
  const name = named?.[1];
  if (name === undefined) return false;
  // Un nom d'entité XML PEUT contenir un point, qui est un métacaractère
  // d'expression régulière — c'est même le cas dont parle la première limite
  // ci-dessus. Il est donc échappé, comme tout le reste du nom.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Les noms XML sont SENSIBLES À LA CASSE : `&X;` n'est pas déclaré par
  // `<!ENTITY x …>`, et le drapeau `i` les confondait. Les commentaires et les
  // sections CDATA sont retirés d'abord : une déclaration écrite à l'intérieur
  // n'en est pas une, et les laisser faisait taire la plainte — les trois trous
  // de la passe 4, constat R4.
  const declarations = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  return new RegExp(`<!ENTITY\\s+${escaped}\\s`).test(declarations);
}

/**
 * Un SVG est du XML : `@xmldom/xmldom` lève à la première faute fatale.
 *
 * Mais toutes les fautes ne sont pas fatales, et c'est le constat C6 de la
 * revue Codex de la PR #66 : une entité inconnue (`&undefined;`) est rapportée
 * au niveau `error`, le parseur rend quand même un document, et le fichier
 * passait au vert. Un document qui référence une entité qui n'existe pas n'est
 * pas bien formé. On retient donc `error` autant que `fatalError`.
 *
 * SAUF quand le document déclare ses entités lui-même. `@xmldom/xmldom` ne lit
 * pas le sous-ensemble INTERNE d'un DOCTYPE : il rapporte `entity not found`
 * pour une entité parfaitement déclarée, et retenir `error` faisait alors
 * rougir du XML valide — un faux rouge sur du travail correct, le pire des
 * verdicts (passe 2 de la dette, constat R3, mesuré sur `runProof`). La plainte
 * NOMME l'entité, et on ne la fait taire que si CETTE entité-là est déclarée
 * dans le document — voir `isDeclaredEntityComplaint`. La première forme de ce
 * correctif retombait sur `fatalError` seul dès qu'un sous-ensemble interne
 * existait, ce qui rendait muettes les entités vraiment inconnues du même
 * document ; ce commentaire décrivait encore cette forme-là (passe 7, R3).
 */
const xmlParses: FormCheck = (text) => {
  try {
    let reported: string | null = null;
    new DOMParser({
      onError: (level, message) => {
        const counts =
          level === 'fatalError' ||
          (level === 'error' && !isDeclaredEntityComplaint(text, message));
        if (counts && reported === null) reported = message;
      },
    }).parseFromString(text, 'text/xml');
    return reported;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** Les règles par extension. Une extension absente ici = « pas de règle », dit tel quel. */
const FORM_RULES: Readonly<Record<string, { readonly name: string; readonly check: FormCheck }>> = {
  '.md': { name: 'markdown', check: markdownHasTitle },
  '.markdown': { name: 'markdown', check: markdownHasTitle },
  '.css': { name: 'css', check: cssCloses },
  '.html': { name: 'html', check: htmlCloses },
  '.htm': { name: 'html', check: htmlCloses },
  '.json': { name: 'json', check: jsonParses },
  '.svg': { name: 'svg', check: xmlParses },
  '.xml': { name: 'xml', check: xmlParses },
};

/**
 * Les fichiers BINAIRES : leur preuve lit leur en-tête, jamais un décodage
 * texte. Run 4078068d (25/09) : `generate_speech` avait écrit un WAV valide,
 * et la preuve le disait rouge sur « the file is not valid UTF-8 » — aucun
 * fichier audio ne peut l'être (#487). `null` = bien formé, sinon ce qui manque.
 *
 * Même profondeur que les règles texte : l'en-tête dit la forme, pas le
 * contenu. Un WAV à l'en-tête juste mais au corps tronqué passe cette preuve
 * (revue de la PR #489) ; `generate_speech` refuse déjà un flux coupé avant
 * d'écrire.
 */
const BINARY_FORM_RULES: Readonly<
  Record<string, { readonly name: string; readonly check: (bytes: Buffer) => string | null }>
> = {
  '.wav': {
    name: 'wav',
    check: (bytes) =>
      bytes.length >= 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE'
        ? null
        : 'no RIFF/WAVE header: this is not a WAV file',
  },
};

// ─── Le vérificateur ────────────────────────────────────────────────────────

export const documentVerifier: DeliverableVerifier = {
  deliverableType: documentDeliverableType,

  /** La même règle d'identité que partout : `projectKey`, une seule copie dans le dépôt. */
  canonicalize(raw: string): string {
    return projectKey(raw);
  },

  /**
   * Toujours prêt : constater n'est pas un pouvoir, il n'y a rien à approuver
   * ni à configurer. Aucune lecture en base, donc aucun verrou — `tx` fait
   * partie du contrat, pas de ce vérificateur. `epoch` vaut 0 : un document
   * n'a pas de configuration qui vieillit dans le TEMPS (`verificationEpoch:
   * null` côté intention). Il en a une, en revanche, et elle peut bouger : le
   * manifeste porte l'empreinte du CONTENU, donc une écriture pendant la preuve
   * fait bien dire « la configuration a bougé » à la primitive. Ce commentaire
   * affirmait le contraire, et c'était faux depuis le constat C1 (passe 7, R3).
   */
  async loadConfig(_tx: AnyDrizzleDb, target: VerifierTarget): Promise<LoadedConfig> {
    const path = target.displayPath ?? target.canonicalKey;
    return {
      kind: 'ready',
      // L'adresse vient-elle d'un chemin écrit, ou de la clé repliée ? La
      // preuve en a besoin pour nommer le repli si elle ne trouve rien.
      ...(target.displayPath ? {} : { subjectIsCanonicalKey: true }),
      // Les règles ET l'état du fichier : c'est lui, la configuration d'un
      // document (constat C1). Une écriture pendant la preuve change cette
      // empreinte, et la primitive refuse alors le vert.
      manifestHash: `${DOCUMENT_MANIFEST_HASH}:${await fileStamp(path)}`,
      cwd: dirname(path),
      subject: path,
      commands: [],
      epoch: 0,
    };
  },

  /**
   * Les constats, dans l'ordre, arrêt au premier rouge. Le chemin lu est le
   * chemin d'AFFICHAGE quand la cible en porte un, et la clé canonique sinon —
   * la même règle que `loadConfig`, et pour la même raison : la clé est repliée
   * en casse, ce qui n'ouvre pas un fichier là où la casse compte (constat C2).
   */
  async runProof(config: ReadyConfig, onCommandDone: OnCommandDone): Promise<ProofResult> {
    const path = config.subject;
    if (path === undefined) throw new Error(`DOCUMENT_CONFIG_WITHOUT_SUBJECT: ${config.cwd}`);
    // Ce que le premier rouge doit ajouter quand l'adresse est un repli : sans
    // ça, « not found » accuse le fichier alors que c'est l'ADRESSE qui est
    // approximative (issue #211, constat mineur 3 de la revue C de la PR #66).
    const repli = config.subjectIsCanonicalKey
      ? ' — this address is the case-folded key, not a path anyone wrote: the state row carries no display path, and on a case-sensitive volume the key misses a file that exists'
      : '';
    const records: ProofCommandRecord[] = [];
    const emit = async (c: Constat): Promise<void> => {
      const record: ProofCommandRecord = { rank: records.length + 1, ...c };
      records.push(record);
      try {
        await onCommandDone(record);
      } catch (error) {
        console.warn(
          `[verification] DOCUMENT_RECORD_CALLBACK_FAILED rank=${record.rank} ` +
            `error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    // L'empreinte de ce que la preuve a RÉELLEMENT lu. La finalisation compare
    // à ELLE, pas à la configuration relue : sans ça, une séquence A → B → A
    // passe — la transaction 1 voit A, la preuve trouve B vert, un autre job
    // remet A avant la transaction 2, et les deux configurations coïncident
    // (dette #66, passe 3, constat R1).
    let provedManifestHash: string | undefined;
    const done = (): ProofResult => ({
      verdict: records.some((r) => r.verdict === 'red') ? 'red' : 'green',
      records,
      ...(provedManifestHash === undefined ? {} : { provedManifestHash }),
    });

    // UNE seule lecture, et tous les constats en découlent.
    //
    // `exists` et `not-empty` s'appuyaient sur un `stat` fait AVANT la lecture :
    // un autre job pouvait vider le fichier entre les deux, et les quatre
    // constats ressortaient verts alors que deux d'entre eux décrivaient un
    // contenu et deux un autre (passe 4, constat R1). L'empreinte prouvée ne
    // vaut que si TOUS les constats portent sur les octets qu'elle couvre.
    const t0 = Date.now();
    let bytes: Buffer;
    try {
      const s = await stat(path);
      if (!s.isFile()) {
        await emit(ko('exists', `${path} is not a file${repli}`, Date.now() - t0));
        return done();
      }
      bytes = await readFile(path);
      provedManifestHash = `${DOCUMENT_MANIFEST_HASH}:${createHash('sha256').update(bytes).digest('hex')}`;
    } catch {
      await emit(ko('exists', `${path} not found${repli}`, Date.now() - t0));
      return done();
    }
    const size = bytes.byteLength;
    await emit(ok('exists', `${size} bytes`, Date.now() - t0));

    // 2 · il n'est pas vide — la taille de CE qui a été lu
    if (size === 0) {
      await emit(ko('not-empty', 'the file is empty (0 bytes)'));
      return done();
    }
    await emit(ok('not-empty'));

    // 3 bis · un fichier binaire est prouvé par son en-tête, puis s'arrête là
    const binary = BINARY_FORM_RULES[extname(path).toLowerCase()];
    if (binary !== undefined) {
      const tb = Date.now();
      const fault = binary.check(bytes);
      await emit(
        fault === null
          ? ok(`well-formed:${binary.name}`, '', Date.now() - tb)
          : ko(`well-formed:${binary.name}`, fault, Date.now() - tb),
      );
      return done();
    }

    // 3 · il se décode en UTF-8
    const t1 = Date.now();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      await emit(ko('utf8', 'the file is not valid UTF-8', Date.now() - t1));
      return done();
    }
    const ext = extname(path).toLowerCase();
    const rule = FORM_RULES[ext];
    if (rule === undefined) {
      // Dit, pas tu : l'écran verra que la vérification s'est arrêtée ici et pourquoi.
      await emit(
        ok(
          'utf8',
          `decoded; no well-formedness rule for ${ext || 'a file without extension'}`,
          Date.now() - t1,
        ),
      );
      return done();
    }
    await emit(ok('utf8', 'decoded', Date.now() - t1));

    // 4 · il est bien formé pour ce qu'il est
    const t2 = Date.now();
    const fault = rule.check(text);
    await emit(
      fault === null
        ? ok(`well-formed:${rule.name}`, '', Date.now() - t2)
        : ko(`well-formed:${rule.name}`, fault, Date.now() - t2),
    );
    return done();
  },
};
