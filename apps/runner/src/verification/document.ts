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
 * Le « manifeste » d'un document est la version de ces règles : elles ne se
 * configurent pas, donc elles ne peuvent pas diverger de ce qui a été
 * approuvé. La primitive compare cette empreinte avant et après la preuve
 * pour savoir si la configuration a bougé — pour un document, elle ne bouge
 * que si CE fichier change, et c'est alors une nouvelle version des règles.
 */
export const DOCUMENT_MANIFEST_HASH = 'document-rules/v1';

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
 * Les lignes des blocs de code CLÔTURÉS, remplacées par des lignes VIDES.
 *
 * Deux raisons de ne plus le faire avec une expression régulière, chacune payée
 * par un verdict faux mesuré :
 *
 * - elle s'est trompée deux fois de suite (dette #66, passes 2 et 3) sur des
 *   règles que CommonMark énonce pourtant simplement — fin d'entrée, longueur
 *   et caractère de la clôture, backtick dans la ligne d'info, tabulation
 *   initiale. Une boucle de lignes dit ces règles telles quelles et se relit ;
 * - SUPPRIMER les lignes recolle leurs voisines, et deux lignes recollées
 *   fabriquent un titre souligné qui n'existait pas : `texte`, un bloc, puis
 *   `---` devenait « texte / --- », donc un titre setext (passe 3, constat R3).
 *   Les blanchir garde la structure du document intacte.
 *
 * Les règles appliquées, dans l'ordre où CommonMark les pose : une ouverture
 * est au plus trois espaces d'indentation puis au moins trois backticks ou
 * tildes ; une ouverture en backticks ne peut pas porter de backtick dans sa
 * ligne d'info ; une clôture porte le MÊME caractère, est au moins aussi
 * longue, et ne contient rien d'autre que des espaces ; une tabulation vaut
 * quatre colonnes, donc ne peut pas servir d'indentation ici. Un bloc jamais
 * clôturé court jusqu'à la fin du document.
 */
function blankFencedBlocks(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    const startsWithTab = line.startsWith('\t');
    const indent = /^ {0,3}/.exec(line)?.[0].length ?? 0;
    const rest = line.slice(indent);
    const run = /^(`+|~+)/.exec(rest)?.[1] ?? '';
    const isFence = !startsWithTab && run.length >= 3;

    if (fence === null) {
      const info = rest.slice(run.length);
      // Une ouverture en backticks dont l'info contient un backtick n'ouvre rien.
      const infoAllowed = run.startsWith('~') || !info.includes('`');
      if (isFence && infoAllowed) {
        fence = { char: run[0]!, length: run.length };
        out.push('');
        continue;
      }
      out.push(line);
      continue;
    }

    const closes =
      isFence &&
      run[0] === fence.char &&
      run.length >= fence.length &&
      rest.slice(run.length).trim() === '';
    out.push('');
    if (closes) fence = null;
  }
  return out.join('\n');
}

/**
 * Un markdown a un titre : `# …` (ATX), ou une ligne de texte soulignée de
 * `=`/`-` (setext).
 *
 * Deux faux titres que la première version acceptait, trouvés en sondant :
 * un en-tête YAML (`---` / `title: x` / `---`), dont la deuxième ligne passait
 * pour un titre souligné ; et une liste suivie d'un filet (`- item` / `---`),
 * qui est une liste puis une règle horizontale, jamais un titre. L'en-tête est
 * retiré avant de chercher ; la ligne soulignée ne peut pas commencer par un
 * marqueur de liste, de citation ou de titre.
 *
 * Deux autres trouvés par la revue Codex de la PR #66 (constat C5) :
 *
 * - la FIN DE LIGNE décidait. L'en-tête n'était retiré qu'en LF, donc le même
 *   fichier écrit par un éditeur Windows passait au vert, sa deuxième ligne
 *   lue comme un titre souligné. Le texte est ramené au LF avant toute chose :
 *   une convention de fin de ligne n'est pas une propriété du document.
 * - un `#` dans un BLOC DE CODE clôturé comptait comme titre. Un bloc clôturé
 *   est un exemple — son contenu n'est pas le document, et un fichier qui ne
 *   contient qu'un exemple n'a pas de titre. Les blocs sont retirés avant de
 *   chercher ; un vrai titre hors du bloc compte toujours.
 */
const markdownHasTitle: FormCheck = (text) => {
  const lf = text.replace(/\r\n?/g, '\n');
  const body = lf.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(\n|$)/, '');
  const prose = blankFencedBlocks(body);
  if (/^[ \t]{0,3}#{1,6}[ \t]+\S/m.test(prose)) return null;
  if (/^[ \t]{0,3}(?![-*+>#\s]|\d+[.)][ \t])\S[^\n]*\n[ \t]{0,3}(=+|-+)[ \t]*$/m.test(prose)) {
    return null;
  }
  return 'no title: expected a heading (`# Title` or an underlined line)';
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
 * Ce qui reste hors de portée, et se dit : une déclaration écrite à l'intérieur
 * d'un commentaire ou d'une section CDATA compte encore comme une déclaration.
 */
function isDeclaredEntityComplaint(text: string, message: string): boolean {
  const named = /entity not found\s*:?\s*&?([A-Za-z_:][\w.:-]*)/i.exec(message);
  const name = named?.[1];
  if (name === undefined) return false;
  // Un nom d'entité XML ne peut contenir aucun métacaractère d'expression
  // régulière, mais on l'échappe quand même : le message vient du parseur.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<!ENTITY\\s+${escaped}\\s`, 'i').test(text);
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
 * verdicts (passe 2 de la dette, constat R3, mesuré sur `runProof`). Devant un
 * sous-ensemble interne, on retombe donc sur `fatalError` seul : la limite est
 * celle du parseur, pas celle du document, et elle ne doit pas coûter un rouge.
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
   * n'a pas de configuration qui vieillit (`verificationEpoch: null` côté
   * intention), et la primitive ne verra jamais « la configuration a bougé »
   * pour lui — ce qui a bougé, c'est le fichier, et c'est la génération sale
   * qui le dit.
   */
  async loadConfig(_tx: AnyDrizzleDb, target: VerifierTarget): Promise<LoadedConfig> {
    const path = target.displayPath ?? target.canonicalKey;
    return {
      kind: 'ready',
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
   * Les constats, dans l'ordre, arrêt au premier rouge. Le chemin est la clé
   * canonique elle-même : pour un document, l'identité EST le chemin (replié
   * en casse sur Windows, où le système de fichiers l'est aussi).
   */
  async runProof(config: ReadyConfig, onCommandDone: OnCommandDone): Promise<ProofResult> {
    const path = config.subject;
    if (path === undefined) throw new Error(`DOCUMENT_CONFIG_WITHOUT_SUBJECT: ${config.cwd}`);
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

    // 1 · il existe, et c'est un fichier
    const t0 = Date.now();
    let size = 0;
    try {
      const s = await stat(path);
      if (!s.isFile()) {
        await emit(ko('exists', `${path} is not a file`, Date.now() - t0));
        return done();
      }
      size = s.size;
    } catch {
      await emit(ko('exists', `${path} not found`, Date.now() - t0));
      return done();
    }
    await emit(ok('exists', `${size} bytes`, Date.now() - t0));

    // 2 · il n'est pas vide
    if (size === 0) {
      await emit(ko('not-empty', 'the file is empty (0 bytes)'));
      return done();
    }
    await emit(ok('not-empty'));

    // 3 · il se décode en UTF-8
    const t1 = Date.now();
    let text: string;
    try {
      const bytes = await readFile(path);
      // Haché AVANT le décodage : c'est l'octet lu qui fait foi, et c'est la
      // même règle que `fileStamp`, pour que les deux valeurs se comparent.
      provedManifestHash = `${DOCUMENT_MANIFEST_HASH}:${createHash('sha256').update(bytes).digest('hex')}`;
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
