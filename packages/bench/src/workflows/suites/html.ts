// workflows/suites/html.ts — des pages web, vérifiées en les analysant.
//
// Le juge analyse la page avec parse5 (l'analyseur HTML du navigateur, celui
// du runner) et regarde les éléments eux-mêmes : la balise title, le h1, les
// lignes d'un tableau, les rectangles d'un SVG. Jamais une recherche de texte
// dans la source, qui prendrait un commentaire pour un titre.

import { readFileSync } from 'node:fs';
import { findInRoots, readText, removeBenchFile } from '../disk';
import { fixturePath, installFixture, installed } from '../fixtures';
import { commonReasons } from '../judge-kit';
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
  version: 1,
  title: 'Write a small standalone web page',
  green: `${LANDING_REL} was written during the run: its title element names "${SHOP}", it has exactly one non-empty h1, a list of at least three items each with a price in euros, a footer element holding "${ADDRESS}", and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'html-page',
  sends: 'nothing',
  instruction:
    `Crée une page web autonome ${LANDING_REL} dans ton espace de travail pour une boulangerie ` +
    `fictive « ${SHOP} » : un titre de page (balise title) qui contient « ${SHOP} », un titre ` +
    'principal h1, une liste de trois produits avec leur prix en euros, et un pied de page (balise ' +
    `footer) avec l'adresse « ${ADDRESS} ».`,
  timeoutMs: 10 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, LANDING_REL);
  },
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
  version: 1,
  title: 'Show a CSV as an HTML table, row for row',
  green: `${WEATHER_HTML_REL} was written during the run with a table whose rows are exactly the CSV's (header first, then one row per day, same order, same values), the CSV is untouched, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'html-page',
  sends: 'nothing',
  instruction:
    `Crée une page ${WEATHER_HTML_REL} dans ton espace de travail qui affiche les données de ` +
    `${WEATHER_CSV_REL} (${SHARED.replace("de l'", "dans l'")}) dans un tableau HTML : une ligne ` +
    "d'en-tête, puis une ligne par jour, dans le même ordre.",
  timeoutMs: 10 * MIN,
  prepare(env) {
    installFixture(env.workspaceRoots, 'office/meteo.csv', WEATHER_CSV_REL);
    removeBenchFile(env.workspaceRoots, WEATHER_HTML_REL);
  },
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
  version: 1,
  title: 'Edit an existing web page: its title and a new footer',
  green: `${HOME_REL} was changed during the run: its title element reads exactly "${NEW_TITLE}", a footer element holds "${FOOTER}", the headings and paragraphs outside the footer are exactly the fixture's, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'html-page',
  sends: 'nothing',
  instruction:
    `Dans la page ${HOME_REL} ${SHARED}, change le titre de la page (balise title) en ` +
    `« ${NEW_TITLE} » et ajoute un pied de page (balise footer) qui contient « ${FOOTER} ». ` +
    'Ne change rien d’autre.',
  timeoutMs: 10 * MIN,
  prepare(env) {
    installFixture(env.workspaceRoots, 'office/accueil.html', HOME_REL);
  },
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

// ─── html-svg-chart ──────────────────────────────────────────────────────────

export const CHART_REL = 'nodal-bench/graphique-bench.html';
const SALES: ReadonlyArray<[string, number]> = [
  ['janvier', 12],
  ['février', 30],
  ['mars', 58],
];

/** Trois rectangles dont les hauteurs sont dans le rapport des ventes (à 5 % près). */
export function barsMatch(heights: readonly number[], values: readonly number[]): boolean {
  const hs = heights.filter((h) => h > 0);
  const [v0, ...rest] = values;
  for (const h0 of hs) {
    if (rest.every((v) => hs.some((h) => Math.abs(h / h0 - v / v0!) <= 0.05 * (v / v0!))))
      return true;
  }
  return false;
}

const svgChart = defineScenario<PageObservation>({
  id: 'html-svg-chart',
  version: 1,
  title: 'Draw a bar chart in inline SVG',
  green: `${CHART_REL} was written during the run, loads nothing from another site, holds an inline svg with bars (rect) whose heights are in the ratio 12 : 30 : 58 within 5 %, names janvier, février and mars, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'html-page',
  sends: 'nothing',
  instruction:
    `Crée une page ${CHART_REL} dans ton espace de travail : une page autonome (sans bibliothèque ` +
    'ni ressource externe) qui affiche en SVG un diagramme en barres des ventes : ' +
    `${SALES.map(([m, v]) => `${m} ${v}`).join(', ')}.`,
  timeoutMs: 10 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, CHART_REL);
  },
  observe: async (_facts, env) => observeCreated(env.workspaceRoots, CHART_REL, env.startedMs),
  judge(facts, o) {
    const { r, els } = pageReasons(CHART_REL, o);
    r.unshift(...commonReasons(facts));
    if (!els) return r;
    const ext = externalResources(els);
    if (ext.length > 0) r.push(`the page loads from another site: ${ext.join(', ')}`);
    if (by(els, 'svg').length === 0) return [...r, 'no inline svg element'];
    const heights = by(els, 'rect')
      .filter((e) => e.ancestors.includes('svg'))
      .map((e) => Number(e.attrs['height']))
      .filter(Number.isFinite);
    if (
      !barsMatch(
        heights,
        SALES.map(([, v]) => v),
      )
    )
      r.push(
        `no three bars in the ratio 12 : 30 : 58 (rect heights: ${heights.join(', ') || 'none'})`,
      );
    const text = lower(els.find((e) => e.tag === 'html')?.text ?? '');
    const missing = SALES.map(([m]) => m).filter((m) => !text.includes(m));
    if (missing.length > 0) r.push(`the page does not name ${missing.join(', ')}`);
    return r;
  },
});

export const HTML_SCENARIOS: AnyScenario[] = [landing, tableCsv, edit, svgChart];
