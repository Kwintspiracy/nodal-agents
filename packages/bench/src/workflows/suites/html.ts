// workflows/suites/html.ts — des pages web, vérifiées en les analysant.
//
// Le juge analyse la page avec parse5 (l'analyseur HTML du navigateur, celui
// du runner) et regarde les éléments eux-mêmes : la balise title, le h1, les
// lignes d'un tableau, les rectangles d'un SVG. Jamais une recherche de texte
// dans la source, qui prendrait un commentaire pour un titre.
//
// Pas d'outil dédié aux pages : file_write et file_edit sont les outils du
// produit, qu'un script ne doit pas remplacer (décision 1 du 17/10).

import { readFileSync } from 'node:fs';
import { findInRoots, readText } from '../disk';
import { fixturePath, installed } from '../fixtures';
import { JUDGED_COMMON, commonReasons } from '../judge-kit';
import { normalizeSpace, readHtml, type HtmlElement } from '../office';
import { defineScenario, type AnyScenario } from '../types';

const MIN = 60_000;
const SHARED = "de l'espace de travail partagé";

interface PageObservation {
  readonly found: { path: string; fresh: boolean; source: string } | null;
}

function observeCreated(roots: readonly string[], rel: string, sinceMs: number): PageObservation {
  const [hit] = findInRoots(roots, rel, sinceMs);
  return { found: hit ? { path: hit.path, fresh: hit.fresh, source: readText(hit.path) } : null };
}

function pageReasons(rel: string, o: PageObservation): { r: string[]; els: HtmlElement[] | null } {
  if (!o.found) return { r: [`no file ${rel} in any workspace folder`], els: null };
  const r: string[] = [];
  if (!o.found.fresh) r.push(`${rel} was not written during the run`);
  return { r, els: readHtml(o.found.source) };
}

const by = (els: readonly HtmlElement[], tag: string): HtmlElement[] =>
  els.filter((e) => e.tag === tag);
const lower = (s: string): string => normalizeSpace(s).toLowerCase();

/** Une ressource chargée d'ailleurs : la page n'est plus autonome. */
function externalResources(els: readonly HtmlElement[]): string[] {
  return els
    .filter(
      (e) =>
        (e.tag === 'script' && /^(https?:)?\/\//i.test(e.attrs['src'] ?? '')) ||
        (e.tag === 'link' && /^(https?:)?\/\//i.test(e.attrs['href'] ?? '')) ||
        (e.tag === 'img' && /^(https?:)?\/\//i.test(e.attrs['src'] ?? '')),
    )
    .map((e) => e.attrs['src'] ?? e.attrs['href'] ?? e.tag);
}

// ─── html-landing ────────────────────────────────────────────────────────────

export const LANDING_REL = 'nodal-bench/boulangerie-bench.html';
const SHOP = 'Au Pain Bench';
const ADDRESS = '12 rue des Lilas, Lyon';
const PRICE = /\d+(?:[.,]\d{1,2})?\s?(?:€|eur\b|euros?\b)/i;

const landing = defineScenario<PageObservation>({
  id: 'html-landing',
  judgedBy: [
    ...JUDGED_COMMON,
    `parses ${LANDING_REL} with parse5 (elements, never a text search), written during the trial`,
    `the title element names "${SHOP}"; exactly one non-empty h1; a list with three items priced in euros; a footer element holding "${ADDRESS}"`,
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (file_write) s'applique.
  version: 2,
  title: 'Create a structured standalone page',
  path: 'file_write. A script in its place is red.',
  deliverable: LANDING_REL,
  productTools: { tools: ['file_write'], writes: [LANDING_REL], reads: [] },
  green: `${LANDING_REL} was written during the run through file_write (no command in its place): its title element names "${SHOP}", it has exactly one non-empty h1, a list of at least three items each with a price in euros, a footer element holding "${ADDRESS}", and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'html-page',
  sends: 'nothing',
  instruction:
    `Crée une page web autonome ${LANDING_REL} dans ton espace de travail pour une boulangerie ` +
    `fictive « ${SHOP} » : un titre de page (balise title) qui contient « ${SHOP} », un titre ` +
    'principal h1, une liste de trois produits avec leur prix en euros, et un pied de page (balise ' +
    `footer) avec l'adresse « ${ADDRESS} ».`,
  timeoutMs: 10 * MIN,
  outputs: [LANDING_REL],
  observe: async (_facts, env) => observeCreated(env.workspaceRoots, LANDING_REL, env.startedMs),
  judge(facts, o) {
    const { r, els } = pageReasons(LANDING_REL, o);
    r.unshift(...commonReasons(facts));
    if (!els) return r;
    const title = by(els, 'title')[0]?.text ?? '';
    if (!lower(title).includes(lower(SHOP)))
      r.push(`the title element reads ${JSON.stringify(title)}, not "${SHOP}"`);
    const h1 = by(els, 'h1').filter((h) => h.text !== '');
    if (h1.length !== 1) r.push(`${h1.length} non-empty h1, expected 1`);
    const lists = [...by(els, 'ul'), ...by(els, 'ol')].map((l) =>
      l.children.filter((c) => c.tag === 'li'),
    );
    const priced = Math.max(
      0,
      ...lists.map((items) => items.filter((li) => PRICE.test(li.text)).length),
    );
    if (priced < 3) r.push(`no list holds three items with a price in euros (best: ${priced})`);
    const footer = by(els, 'footer')
      .map((f) => lower(f.text))
      .join(' ');
    if (!footer.includes(lower(ADDRESS))) r.push(`no footer element holds "${ADDRESS}"`);
    return r;
  },
});

// ─── html-table-csv ──────────────────────────────────────────────────────────

export const WEATHER_CSV_REL = 'nodal-bench/meteo.csv';
export const WEATHER_HTML_REL = 'nodal-bench/meteo-bench.html';
/** La colonne du CSV que le graphique dessine. */
const CHART_COLUMN = 'max';

/** Deux cellules égales : même texte, ou même nombre quelle que soit la virgule. */
function sameCell(got: string, want: string): boolean {
  const g = normalizeSpace(got);
  if (g.toLowerCase() === want.toLowerCase()) return true;
  const n = (s: string): number => Number(s.replace(',', '.').replace(/\s?°c?$/i, ''));
  return Number.isFinite(n(want)) && n(g) === n(want);
}

interface TableObservation extends PageObservation {
  /** Le CSV tel qu'il était à la fin de l'essai. */
  readonly csv: string | null;
}

const tableCsv = defineScenario<TableObservation>({
  id: 'html-table-csv',
  judgedBy: [
    ...JUDGED_COMMON,
    `parses ${WEATHER_HTML_REL} with parse5, written during the trial`,
    `a table whose rows equal ${WEATHER_CSV_REL} (header first, same order; 12,5 equals 12.5); the CSV untouched`,
    `an inline svg whose rect heights are in the ratio of the CSV's ${CHART_COLUMN} column (± 5 %)`,
    'no script, stylesheet or image loaded from another site',
  ],
  // v2 (catalogue du 17/10) : fusion de html-svg-chart (le graphique SVG des
  // mêmes données, sans ressource externe), et la règle des outils du produit.
  version: 2,
  title: 'Lay out data: a table and a chart',
  green: `${WEATHER_HTML_REL} was written during the run through file_write (no command in its place) with a table whose rows are exactly the CSV's (header first, then one row per day, same order, same values) and an inline SVG bar chart of the ${CHART_COLUMN} temperatures in the right proportions (± 5 %); it loads nothing from another site, the CSV is untouched, and nobody was asked anything.`,
  path: 'Read the CSV, then file_write. A script in its place is red.',
  deliverable: WEATHER_HTML_REL,
  productTools: { tools: ['file_write'], writes: [WEATHER_HTML_REL], reads: [] },
  set: 'on-demand',
  activity: 'html-page',
  sends: 'nothing',
  instruction:
    `Crée une page ${WEATHER_HTML_REL} dans ton espace de travail qui affiche les données de ` +
    `${WEATHER_CSV_REL} (${SHARED.replace("de l'", "dans l'")}) dans un tableau HTML : une ligne ` +
    "d'en-tête, puis une ligne par jour, dans le même ordre. Sous le tableau, dessine en SVG un " +
    'diagramme en barres des températures maximales (colonne max). La page doit être autonome, ' +
    'sans bibliothèque ni ressource externe.',
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/meteo.csv', to: WEATHER_CSV_REL }],
  outputs: [WEATHER_HTML_REL],
  async observe(_facts, env) {
    const csv = installed(env.workspaceRoots, WEATHER_CSV_REL, env.startedMs);
    return {
      ...observeCreated(env.workspaceRoots, WEATHER_HTML_REL, env.startedMs),
      csv: csv.exists ? readFileSync(csv.path, 'utf8') : null,
    };
  },
  judge(facts, o) {
    const { r, els } = pageReasons(WEATHER_HTML_REL, o);
    r.unshift(...commonReasons(facts));
    const fixture = readFileSync(fixturePath('office/meteo.csv'), 'utf8');
    if (o.csv !== fixture) r.push(`${WEATHER_CSV_REL} was changed or removed`);
    if (!els) return r;
    const want = fixture
      .trim()
      .split(/\r?\n/)
      .map((l) => l.split(','));
    const tables = by(els, 'table');
    if (tables.length === 0) return [...r, 'no table element'];
    const rowsOf = (t: HtmlElement): string[][] =>
      els
        .filter((e) => e.tag === 'tr' && isInside(e, t))
        .map((tr) =>
          tr.children.filter((c) => c.tag === 'td' || c.tag === 'th').map((c) => c.text),
        );
    const best =
      tables.map(rowsOf).find((rows) => rows.length === want.length) ?? rowsOf(tables[0]!);
    if (best.length !== want.length)
      r.push(`the table has ${best.length} row(s), expected ${want.length}`);
    want.forEach((row, i) => {
      const got = best[i] ?? [];
      if (got.length !== row.length || row.some((cell, c) => !sameCell(got[c] ?? '', cell)))
        r.push(`row ${i + 1} reads ${JSON.stringify(got)}, expected ${JSON.stringify(row)}`);
    });
    const ext = externalResources(els);
    if (ext.length > 0) r.push(`the page loads from another site: ${ext.join(', ')}`);
    if (by(els, 'svg').length === 0) return [...r, 'no inline svg element'];
    const col = want[0]!.indexOf(CHART_COLUMN);
    const values = want.slice(1).map((row) => Number(row[col]));
    const heights = by(els, 'rect')
      .filter((e) => e.ancestors.includes('svg'))
      .map((e) => Number(e.attrs['height']))
      .filter(Number.isFinite);
    if (!barsMatch(heights, values))
      r.push(
        `no ${values.length} bars in the ratio of the ${CHART_COLUMN} column ${values.join(' : ')} (rect heights: ${heights.join(', ') || 'none'})`,
      );
    return r;
  },
});

/** Un élément est-il dans le sous-arbre d'un autre ? (par identité, via les enfants) */
function isInside(el: HtmlElement, root: HtmlElement): boolean {
  const stack = [...root.children];
  while (stack.length > 0) {
    const e = stack.pop()!;
    if (e === el) return true;
    stack.push(...e.children);
  }
  return false;
}

// ─── html-edit ───────────────────────────────────────────────────────────────

export const HOME_REL = 'nodal-bench/accueil.html';
const NEW_TITLE = 'Accueil Bench 2026';
const FOOTER = '© 2026 Nodal Bench';

/** Le texte visible du corps, pied de page exclu. */
function bodyTextOutsideFooter(els: readonly HtmlElement[]): string {
  return els
    .filter((e) => ['h1', 'h2', 'h3', 'p', 'li'].includes(e.tag) && !e.ancestors.includes('footer'))
    .map((e) => e.text)
    .join(' | ');
}

const edit = defineScenario<PageObservation>({
  id: 'html-edit',
  judgedBy: [
    ...JUDGED_COMMON,
    `parses ${HOME_REL}; it must be changed during the trial`,
    `the title element reads exactly "${NEW_TITLE}"; a footer element holds "${FOOTER}"; headings and paragraphs outside the footer are the fixture's`,
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (file_edit, file_write) s'applique.
  version: 2,
  title: 'Edit a page without breaking the rest',
  path: 'file_read, then file_edit. A script in their place is red.',
  deliverable: `${HOME_REL}, changed`,
  productTools: { tools: ['file_edit', 'file_write'], writes: [HOME_REL], reads: [] },
  green: `${HOME_REL} was changed during the run through the product's file tools (no command in their place): its title element reads exactly "${NEW_TITLE}", a footer element holds "${FOOTER}", the headings and paragraphs outside the footer are exactly the fixture's, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'html-page',
  sends: 'nothing',
  instruction:
    `Dans la page ${HOME_REL} ${SHARED}, change le titre de la page (balise title) en ` +
    `« ${NEW_TITLE} » et ajoute un pied de page (balise footer) qui contient « ${FOOTER} ». ` +
    'Ne change rien d’autre.',
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/accueil.html', to: HOME_REL }],
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, HOME_REL, env.startedMs);
    return { found: f.exists ? { path: f.path, fresh: f.fresh, source: readText(f.path) } : null };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    if (!o.found) return [...r, `${HOME_REL} is gone`];
    if (!o.found.fresh) r.push(`${HOME_REL} was not changed during the run`);
    const els = readHtml(o.found.source);
    const title = by(els, 'title')[0]?.text ?? '';
    if (title !== NEW_TITLE)
      r.push(`the title element reads ${JSON.stringify(title)}, expected "${NEW_TITLE}"`);
    if (!by(els, 'footer').some((f) => f.text.includes(FOOTER)))
      r.push(`no footer element holds "${FOOTER}"`);
    const original = bodyTextOutsideFooter(
      readHtml(readFileSync(fixturePath('office/accueil.html'), 'utf8')),
    );
    if (bodyTextOutsideFooter(els) !== original)
      r.push('the headings and paragraphs outside the footer changed');
    return r;
  },
});

// ─── le graphique ────────────────────────────────────────────────────────────

/** Des rectangles dont les hauteurs sont dans le rapport des valeurs (à 5 % près). */
export function barsMatch(heights: readonly number[], values: readonly number[]): boolean {
  const hs = heights.filter((h) => h > 0);
  const [v0, ...rest] = values;
  for (const h0 of hs) {
    if (rest.every((v) => hs.some((h) => Math.abs(h / h0 - v / v0!) <= 0.05 * (v / v0!))))
      return true;
  }
  return false;
}

export const HTML_SCENARIOS: AnyScenario[] = [landing, tableCsv, edit];
