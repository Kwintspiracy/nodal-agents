/**
 * scan-server-uses-client-value.ts — un module SERVEUR ne peut pas se SERVIR
 * de ce qu'un module `'use client'` exporte, il peut seulement le RENDRE.
 *
 * Pourquoi cette garde existe (PR #237, 19/09). `dockedFormId` vivait dans
 * `DockedFormCta.tsx`, qui porte `'use client'` pour son contexte React, et la
 * page serveur `/settings` l'appelait pour donner son `id` à chaque
 * formulaire. Vu du serveur, tout ce qu'un module client exporte est une
 * RÉFÉRENCE : un objet que le serveur sait rendre comme composant, jamais
 * appeler. La page tombait donc à l'exécution, et `/settings` répondait 500
 * sur une stack fraîche.
 *
 * Rien ne l'avait vu, et rien ne pouvait : les types sont identiques des deux
 * côtés de la frontière, `tsc` est muet, et les tests unitaires rendent les
 * composants sans frontière serveur / client. Seule la CI l'a attrapé, par un
 * parcours de fumée, après une poussée.
 *
 * ─── Ce qu'il a fallu comprendre pour que la garde soit juste ──────────────
 *
 * Un fichier SANS `'use client'` n'est pas pour autant un fichier serveur. La
 * directive marque une FRONTIÈRE, pas un camp : un module neutre importé
 * uniquement par des composants client vit entièrement côté client, et il peut
 * appeler ce qu'il veut. Une première version de ce scanner l'ignorait et
 * rendait 34 violations, toutes fausses — les fichiers `*.figma.tsx` passent
 * leurs composants à `figma.connect()`, ce qui est leur métier.
 *
 * La garde part donc des ENTRÉES serveur — `page.tsx`, `layout.tsx`,
 * `route.ts` sans directive — et descend leurs imports locaux SANS jamais
 * franchir une frontière `'use client'`. Ce qu'elle atteint est le vrai graphe
 * serveur, et c'est là, et seulement là, qu'un binding client doit rester une
 * balise.
 *
 * Elle vit ici et non dans `@nodal-agents/test-kit` parce que cette frontière
 * n'existe que dans l'application Next : les scanners partagés portent des
 * invariants que TOUS les paquets doivent tenir.
 *
 * ─── Pourquoi elle refuse aussi les LECTURES (#240, 20/09) ────────────────
 *
 * La première version s'arrêtait à l'APPEL, parce que c'est la forme qui casse
 * bruyamment, et elle disait ne rien savoir d'une CONSTANTE lue par le serveur
 * (`DOT[outcome]` dans le fil). La question a été tranchée par l'expérience, et
 * la réponse est : c'est cassé, et silencieusement.
 *
 * Ce que le chargeur de Next met à la place d'un module `'use client'` vu du
 * graphe serveur, c'est UNE RÉFÉRENCE PAR EXPORT
 * (`next/dist/build/webpack/loaders/next-flight-loader/index.js`, branche
 * `assumedSourceType === 'module'`) :
 *
 *     export const DOT = registerClientReference(
 *       function () { throw new Error('Attempted to call DOT() …'); },
 *       cleDuModule, "DOT",
 *     );
 *
 * et `registerClientReference` ne fait que poser `$$typeof`, `$$id` et
 * `$$async` sur cette fonction. Y entrer par une clé ne jette donc RIEN : ça
 * rend `undefined`. `DOT[outcome] ?? 'bg-ink-4'` prenait le repli, et toutes
 * les pastilles du fil étaient grises sans que personne le voie — l'appel
 * tombe, la lecture ment. (Seul le proxy CommonJS, `createClientModuleProxy`,
 * jette « You cannot dot into a client module » ; un `.tsx` à exports nommés ne
 * passe pas par là.)
 *
 * La preuve est exécutable et vit à côté du fil :
 * `app/(dashboard)/spaces/__tests__/feed-dots-server-boundary.test.tsx` fait
 * tourner le vrai `registerClientReference` dans un node lancé avec la
 * condition `react-server`, puis rend le fil avec les constantes remplacées par
 * des références. Les couleurs ont été réparées en sortant les deux tables dans
 * `spaces/feed-dots.ts`, un module SANS directive.
 *
 * D'où la règle d'aujourd'hui : un binding client ne peut être ni APPELÉ
 * (`X(…)`) ni LU (`X.y`, `X[y]`) depuis le graphe serveur. Il peut être rendu
 * (`<X />`) ou passé tel quel en prop — et rien d'autre.
 *
 * ─── Ce qu'elle NE voit pas, et c'est écrit exprès ─────────────────────────
 *
 * Une garde qui prétend tout voir se fait croire sur parole. Celle-ci lit du
 * TEXTE, pas un arbre syntaxique, et elle laisse passer :
 *
 *   - les CHAÎNES de ré-exports. Un conduit (`export { X } from './Client'`)
 *     est suivi sur UN niveau ; un conduit de conduit ne l'est pas. Et
 *     `export * from './Client'` ne nomme rien, donc rien n'est suivi ;
 *   - l'import DYNAMIQUE. `await import('./Client.tsx')` n'est pas une clause
 *     `import … from`, donc il n'entre ni dans le graphe ni dans les bindings ;
 *   - les entrées serveur que Next ajoute et que `SERVER_ENTRY` ne nomme pas —
 *     `loading.tsx`, `global-error.tsx`, `proxy.ts`. Un module atteint
 *     UNIQUEMENT par l'une d'elles reste hors du graphe ;
 *   - l'ordre. Elle regarde le texte APRÈS la ligne d'import, donc un appel
 *     placé avant son propre import (une déclaration de fonction remontée) lui
 *     échappe ;
 *   - les CHAÎNES de caractères. `'appelle dockedFormId(x)'` ressemble encore à
 *     un appel : faux ROUGE possible. Les COMMENTAIRES, eux, ne comptent plus —
 *     `retirerCommentaires` les efface avant la recherche. Sans lui, élargir
 *     aux lectures rendait un faux rouge sur l'arbre réel : `agents/page.tsx`
 *     écrit « the view used by AgentsList. Active jobs… » dans un commentaire,
 *     et le point d'une phrase se lit comme un accès à un champ. L'issue #240
 *     en annonçait six, comptés sur un élargissement plus large (tout USAGE) ;
 *     mesuré sur celui-ci, il y en a un. Un seul suffit : une garde qui rougit
 *     sur du code qui marche se fait désactiver le lendemain.
 *
 * Couvrir tout cela demanderait un vrai parcours de l'arbre syntaxique. Les
 * deux défauts qu'elle attrape — l'appel qui a fait tomber /settings, la
 * lecture qui a éteint les pastilles du fil — valent déjà leur coût ; les
 * autres formes sont ici pour que personne ne prenne son silence pour une
 * preuve.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Même forme que les scanners partagés, pour passer dans `assertNoViolations`. */
export type Violation = { file: string; line: number; rule: string; text: string };

const CLIENT_DIRECTIVE = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/;

/** Le séparateur de lignes, nommé plutôt qu'écrit en littéral. */
const NEWLINE = String.fromCharCode(10);

/** Les fichiers par lesquels Next entre côté serveur. */
const SERVER_ENTRY = /(^|[\\/])(page|layout|route|template|error|not-found)\.tsx?$/;

const IMPORT_RE = /import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g;

/** `export { X, Y as Z } from './Autre.tsx'` — un conduit, pas un import. */
const REEXPORT_RE = /export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/** Les caractères après lesquels un `/` ouvre une expression régulière. */
const AVANT_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n']);

/**
 * Le même texte, commentaires effacés, LONGUEUR ET LIGNES INCHANGÉES — les
 * décalages d'import et les numéros de ligne restent valables.
 *
 * Elle ne remplace que les commentaires. Les chaînes, gabarits et expressions
 * régulières sont seulement TRAVERSÉS, pour qu'un `//` d'une URL ou d'un motif
 * ne passe pas pour un commentaire. Se tromper en les traversant ne peut donc
 * que LAISSER un commentaire en place — un faux rouge, jamais un faux vert.
 */
export function retirerCommentaires(texte: string): string {
  const out = texte.split('');
  // Borne explicite : sans elle, un commentaire de bloc non fermé écrirait
  // au-delà du tableau et RALLONGERAIT le texte rendu.
  const effacer = (i: number): void => {
    if (i < out.length && out[i] !== NEWLINE && out[i] !== '\r') out[i] = ' ';
  };
  /** Le dernier caractère de code rencontré, pour reconnaître `/` en tête de motif. */
  let precedent = NEWLINE;
  let i = 0;
  while (i < texte.length) {
    const c = texte[i]!;
    const suivant = texte[i + 1] ?? '';
    if (c === '/' && suivant === '/') {
      while (i < texte.length && texte[i] !== NEWLINE) effacer(i++);
      continue;
    }
    if (c === '/' && suivant === '*') {
      effacer(i++);
      while (i < texte.length && !(texte[i] === '*' && texte[i + 1] === '/')) effacer(i++);
      effacer(i++);
      if (i < texte.length) effacer(i++);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < texte.length && texte[i] !== c) i += texte[i] === '\\' ? 2 : 1;
      i++;
      precedent = c;
      continue;
    }
    if (c === '/' && AVANT_REGEX.has(precedent)) {
      i++;
      let crochets = false;
      while (i < texte.length && (crochets || texte[i] !== '/')) {
        if (texte[i] === '\\') i++;
        else if (texte[i] === '[') crochets = true;
        else if (texte[i] === ']') crochets = false;
        else if (texte[i] === NEWLINE) break;
        i++;
      }
      i++;
      precedent = '/';
      continue;
    }
    if (c.trim() !== '') precedent = c;
    else if (c === NEWLINE) precedent = NEWLINE;
    i++;
  }
  return out.join('');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'tests') continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** Les bindings d'une clause d'import, sans les types (ils s'effacent à la compilation). */
function bindings(clause: string): string[] {
  if (/^\s*type\s/.test(clause)) return [];
  const names: string[] = [];
  const braced = /\{([^}]*)\}/.exec(clause);
  if (braced) {
    for (const part of braced[1]!.split(',')) {
      const n = part.trim();
      if (n === '' || /^type\s/.test(n)) continue;
      names.push(
        n
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      );
    }
  }
  const dflt = clause
    .replace(/\{[^}]*\}/, '')
    .replace(/,/g, '')
    .trim();
  if (dflt !== '' && !dflt.startsWith('*')) names.push(dflt);
  return names;
}

export function scanForServerUsesOfClientValues(opts: { srcDir: string }): Violation[] {
  const files = walk(opts.srcDir);

  const source = new Map<string, string>();
  const isClient = new Map<string, boolean>();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    source.set(f, text);
    isClient.set(f, CLIENT_DIRECTIVE.test(text.slice(0, 400)));
  }

  /** Le fichier local visé par un spécificateur, ou `null` (paquet externe). */
  function target(fromFile: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = resolve(opts.srcDir, spec.slice(2));
    else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
    else return null;
    const stem = base.replace(/\.tsx?$/, '');
    for (const cand of [
      base,
      stem + '.tsx',
      stem + '.ts',
      join(stem, 'index.tsx'),
      join(stem, 'index.ts'),
    ]) {
      if (source.has(cand)) return cand;
    }
    return null;
  }

  // Le graphe serveur : les entrées, puis tout ce qu'elles atteignent sans
  // franchir une frontière `'use client'`.
  const serverGraph = new Set<string>();
  const queue = files.filter((f) => SERVER_ENTRY.test(f) && isClient.get(f) !== true);
  for (const f of queue) serverGraph.add(f);
  while (queue.length > 0) {
    const f = queue.pop()!;
    const text = source.get(f)!;
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(text)) !== null) {
      const dest = target(f, m[2]!);
      // Une frontière client ne se franchit pas : au-delà, tout est client.
      if (dest === null || isClient.get(dest) === true || serverGraph.has(dest)) continue;
      serverGraph.add(dest);
      queue.push(dest);
    }
  }

  // Les CONDUITS : un module neutre qui ré-exporte des noms d'un module
  // client. `export { X } from './Client.tsx'` ne rend pas `X` appelable pour
  // autant — le serveur reçoit toujours une référence — mais le fichier qui
  // l'importe depuis le conduit ne mentionne plus le module client, et la
  // garde le manquerait. Un niveau de conduit suffit : le produit n'en fait
  // pas de chaîne, et le prouver coûterait un parcours d'arbre syntaxique.
  const conduits = new Map<string, Set<string>>();
  for (const f of files) {
    const text = source.get(f)!;
    REEXPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REEXPORT_RE.exec(text)) !== null) {
      const dest = target(f, m[2]!);
      if (dest === null || isClient.get(dest) !== true) continue;
      const noms = conduits.get(f) ?? new Set<string>();
      for (const n of bindings(`{${m[1]!}}`)) noms.add(n);
      conduits.set(f, noms);
    }
  }

  const violations: Violation[] = [];
  for (const f of serverGraph) {
    const text = source.get(f)!;
    const code = retirerCommentaires(text);
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(text)) !== null) {
      const dest = target(f, m[2]!);
      if (dest === null) continue;
      const relayes = conduits.get(dest);
      const direct = isClient.get(dest) === true;
      if (!direct && relayes === undefined) continue;
      // La recherche se fait sur le texte SANS commentaires : élargir aux
      // lectures sans cela rendait six faux rouges (#240).
      const after = code.slice(m.index + m[0].length);
      for (const name of bindings(m[1]!)) {
        if (!direct && !relayes!.has(name)) continue;
        // Deux formes, deux dégâts. L'APPEL casse bruyamment — Next lève
        // « Attempted to call X() from the server but X is on the client » —
        // et c'est lui qui a fait tomber `/settings` (#237). La LECTURE
        // (`X.y`, `X[y]`) ne casse rien du tout : elle rend `undefined`, et le
        // repli derrière passe pour une valeur (#240). Le RENDU (`<X />`) et le
        // passage en prop restent les seuls usages permis.
        const appel = new RegExp(`(?<![<./\\w$])${name}\\s*\\(`).test(after);
        const lecture = new RegExp(`(?<![<./\\w$])${name}\\s*(?:\\??\\.|\\[)`).test(after);
        if (!appel && !lecture) continue;
        const geste = appel ? `${name}() est APPELÉ` : `${name} est LU`;
        const degat = appel
          ? `le serveur ne peut que le RENDRE, pas l'appeler`
          : `le serveur n'en reçoit qu'une référence : la lecture rend ` +
            `\`undefined\` sans rien dire`;
        violations.push({
          file: f.slice(opts.srcDir.length + 1),
          line: text.slice(0, m.index).split(NEWLINE).length,
          rule: 'server-uses-client-value',
          text: direct
            ? `${geste} depuis le graphe serveur alors que ${m[2]} porte ` +
              `'use client' — ${degat}`
            : `${geste} depuis le graphe serveur ; ${m[2]} le ré-exporte ` +
              `d'un module 'use client' — ${degat}`,
        });
      }
    }
  }
  return violations;
}
