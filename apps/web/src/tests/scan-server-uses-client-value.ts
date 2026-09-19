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
 *   - les commentaires et les chaînes. `// dockedFormId(x)` ou
 *     `'appelle dockedFormId(x)'` ressemblent à un appel : faux ROUGE possible.
 *     C'est le sens le moins dangereux — quelqu'un regarde — mais il faut le
 *     savoir avant d'accuser la garde.
 *
 * Couvrir tout cela demanderait un vrai parcours de l'arbre syntaxique. Le
 * défaut qu'elle attrape — l'appel direct, celui qui a fait tomber /settings —
 * vaut déjà son coût ; les autres formes sont ici pour que personne ne prenne
 * son silence pour une preuve.
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
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(text)) !== null) {
      const dest = target(f, m[2]!);
      if (dest === null) continue;
      const relayes = conduits.get(dest);
      const direct = isClient.get(dest) === true;
      if (!direct && relayes === undefined) continue;
      const after = text.slice(m.index + m[0].length);
      for (const name of bindings(m[1]!)) {
        if (!direct && !relayes!.has(name)) continue;
        // Ce que la garde retient : l'APPEL. C'est la forme qui casse à coup
        // sûr et bruyamment — Next lève « Attempted to call X() from the
        // server but X is on the client » — et c'est celle qui a fait tomber
        // `/settings`.
        //
        // Elle ne dit rien d'une CONSTANTE d'un module client lue par le
        // serveur (`DOT[outcome]` dans le fil, par exemple). Le cas est voisin
        // et mériterait d'être regardé, mais il ne se prouve pas d'ici, et une
        // garde qui rougit sur du code qui marche se fait désactiver.
        if (new RegExp(`(?<![<./\\w$])${name}\\s*\\(`).test(after)) {
          violations.push({
            file: f.slice(opts.srcDir.length + 1),
            line: text.slice(0, m.index).split(NEWLINE).length,
            rule: 'server-uses-client-value',
            text: direct
              ? `${name}() est APPELÉ depuis le graphe serveur alors que ${m[2]} porte ` +
                `'use client' — le serveur ne peut que le RENDRE, pas l'appeler`
              : `${name}() est APPELÉ depuis le graphe serveur ; ${m[2]} le ré-exporte ` +
                `d'un module 'use client', ce qui ne le rend pas appelable`,
          });
        }
      }
    }
  }
  return violations;
}
