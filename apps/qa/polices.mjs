// apps/qa/polices.mjs — les polices du portail, embarquées dans la page (#688).
//
// Le portail est un document autonome : un seul `index.html`, servi sous
// `/qa/` par GitHub Pages, par `serve.mjs`, ou ouvert en `file://`. Aucun
// chemin relatif ne tient pour les trois. Les polices sont donc écrites DANS le
// document, en `data:` URI : la page ne demande jamais rien à un tiers, et ne
// dépend d'aucun fichier voisin.
//
// Les fichiers sont ceux du site de docs (`apps/docs/app/fonts/`), la seule
// copie du dépôt : changer une police là change aussi le portail, et la licence
// OFL de chaque famille est déjà à côté. On ne garde que le sous-ensemble
// `latin` de chaque famille utilisée par le portail (le portail est rédigé en
// anglais et en français : U+0000-00FF couvre les accents). Le `unicode-range`
// est lu dans `fonts.css`, jamais recopié ici.
//
// Un fichier absent ou une famille introuvable lève : une page sans polices
// serait un repli silencieux (invariant #4).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
export const DOSSIER_POLICES = join(ICI, '..', 'docs', 'app', 'fonts');

/** Les familles que la feuille du portail nomme dans ses `font-family`. */
export const FAMILLES_DU_PORTAIL = ['Archivo', 'Public Sans', 'JetBrains Mono'];

/**
 * Les `@font-face` du portail, prêts à être posés dans un `<style>`.
 *
 * @param {string} [dossier] où lire `fonts.css` et les woff2 (le bac des tests
 *   de rendu en pose une copie à côté du module).
 */
export function fontFacesDuPortail(dossier = DOSSIER_POLICES) {
  const css = readFileSync(join(dossier, 'fonts.css'), 'utf8');
  const blocs = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
  const retenus = [];
  for (const famille of FAMILLES_DU_PORTAIL) {
    const dEntre = blocs.filter(
      (b) =>
        b.includes(`font-family: '${famille}';`) &&
        /url\(\s*'\.\/[\w.-]+-latin-wght-normal\.woff2'\s*\)/.test(b),
    );
    if (dEntre.length !== 1) {
      throw new Error(
        `polices du portail : ${dEntre.length} @font-face latin pour « ${famille} » dans ${join(dossier, 'fonts.css')} (1 attendu)`,
      );
    }
    retenus.push(dEntre[0]);
  }
  return retenus
    .map((bloc) =>
      bloc.replace(/url\(\s*'\.\/([\w.-]+\.woff2)'\s*\)/, (_, fichier) => {
        const octets = readFileSync(join(dossier, fichier));
        return `url(data:font/woff2;base64,${octets.toString('base64')})`;
      }),
    )
    .join('\n');
}
