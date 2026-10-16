// workflows/suites/word.ts — créer et modifier un document Word, vérifié en le relisant.
//
// Le texte est lu par mammoth (l'outil `docx_read` du produit) ; la structure
// (titres, tableaux, ordre des paragraphes) dans le XML du document. Une
// modification est jugée sur ce qui a changé ET sur ce qui devait rester : le
// texte d'origine de la fixture, à l'identique.

import { findInRoots, removeBenchFile } from '../disk';
import { fixturePath, installFixture, installed } from '../fixtures';
import { CONTRACT, MINUTES } from '../fixture-data';
import { commonReasons } from '../judge-kit';
import { isHeading, readDocx, normalizeSpace, type DocxView } from '../office';
import { defineScenario, type AnyScenario } from '../types';

const MIN = 60_000;
const SHARED = "de l'espace de travail partagé";

interface DocObservation {
  readonly found: { path: string; fresh: boolean } | null;
  readonly doc: DocxView | null;
  readonly readError: string | null;
  /** Le texte de la fixture d'origine, quand le scénario modifie un document posé par le banc. */
  readonly original?: string;
}

async function observeDoc(path: string | null, fresh: boolean): Promise<DocObservation> {
  if (path === null) return { found: null, doc: null, readError: null };
  try {
    return { found: { path, fresh }, doc: await readDocx(path), readError: null };
  } catch (e) {
    return {
      found: { path, fresh },
      doc: null,
      readError: String(e instanceof Error ? e.message : e),
    };
  }
}

/** Les raisons communes : le fichier existe, a été écrit pendant l'essai, se lit. */
function docReasons(rel: string, o: DocObservation): { r: string[]; doc: DocxView | null } {
  if (!o.found) return { r: [`no file ${rel} in any workspace folder`], doc: null };
  const r: string[] = [];
  if (!o.found.fresh) r.push(`${rel} was not written during the run`);
  if (!o.doc)
    return { r: [...r, `${rel} cannot be read as a Word document: ${o.readError}`], doc: null };
  return { r, doc: o.doc };
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const lower = (s: string): string => normalizeSpace(s).toLowerCase();

// ─── word-create ─────────────────────────────────────────────────────────────

export const CONVOCATION_REL = 'nodal-bench/convocation-bench.docx';

const create = defineScenario<DocObservation>({
  id: 'word-create',
  version: 1,
  title: 'Write a Word document with a heading and body paragraphs',
  green: `${CONVOCATION_REL} was written during the run, opens as a Word document, has a heading paragraph reading "Convocation" followed by at least three body paragraphs, names 12 novembre 2026, 14 h and salle B, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'word',
  sends: 'nothing',
  instruction:
    `Crée un document Word ${CONVOCATION_REL} dans ton espace de travail : un titre « Convocation » ` +
    '(en style de titre), puis trois paragraphes qui convoquent l’équipe à une réunion le ' +
    '12 novembre 2026 à 14 h en salle B.',
  timeoutMs: 10 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, CONVOCATION_REL);
  },
  async observe(_facts, env) {
    const [hit] = findInRoots(env.workspaceRoots, CONVOCATION_REL, env.startedMs);
    return observeDoc(hit?.path ?? null, hit?.fresh ?? false);
  },
  judge(facts, o) {
    const { r, doc } = docReasons(CONVOCATION_REL, o);
    r.unshift(...commonReasons(facts));
    if (!doc) return r;
    const h = doc.paragraphs.findIndex((p) => isHeading(p) && /convocation/i.test(p.text));
    if (h === -1) r.push('no heading paragraph reads "Convocation"');
    else {
      const body = doc.paragraphs.slice(h + 1).filter((p) => !isHeading(p) && p.text.trim() !== '');
      if (body.length < 3)
        r.push(`${body.length} body paragraph(s) after the heading, fewer than 3`);
    }
    const t = lower(doc.text);
    if (!t.includes('12 novembre 2026')) r.push('the document does not name 12 novembre 2026');
    if (!/\b14\s?h/.test(t)) r.push('the document does not name 14 h');
    if (!/salle b\b/.test(t)) r.push('the document does not name salle B');
    return r;
  },
});

// ─── word-replace ────────────────────────────────────────────────────────────

export const CONTRACT_REL = 'nodal-bench/contrat.docx';

const replace = defineScenario<DocObservation>({
  id: 'word-replace',
  version: 1,
  title: 'Replace a name everywhere in an existing Word document, changing nothing else',
  green: `${CONTRACT_REL} was changed during the run: "${CONTRACT.from}" appears nowhere, "${CONTRACT.to}" appears exactly ${CONTRACT.occurrences} times (the table included), every other character of the text is the fixture's, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'word',
  sends: 'nothing',
  instruction:
    `Dans le document ${CONTRACT_REL} ${SHARED}, remplace partout « ${CONTRACT.from} » par ` +
    `« ${CONTRACT.to} », sans rien changer d’autre.`,
  timeoutMs: 10 * MIN,
  prepare(env) {
    installFixture(env.workspaceRoots, 'office/contrat.docx', CONTRACT_REL);
  },
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, CONTRACT_REL, env.startedMs);
    const original = (await readDocx(fixturePath('office/contrat.docx'))).text;
    return { ...(await observeDoc(f.exists ? f.path : null, f.fresh)), original };
  },
  judge(facts, o) {
    const { r, doc } = docReasons(CONTRACT_REL, o);
    r.unshift(...commonReasons(facts));
    if (!doc) return r;
    const left = count(doc.text, CONTRACT.from);
    if (left > 0) r.push(`"${CONTRACT.from}" still appears ${left} time(s)`);
    const put = count(doc.text, CONTRACT.to);
    if (put !== CONTRACT.occurrences)
      r.push(`"${CONTRACT.to}" appears ${put} time(s), expected ${CONTRACT.occurrences}`);
    if (
      normalizeSpace(doc.text.split(CONTRACT.to).join(CONTRACT.from)) !==
      normalizeSpace(o.original ?? '')
    )
      r.push('the rest of the text is not the fixture’s: something else changed');
    return r;
  },
});

// ─── word-append ─────────────────────────────────────────────────────────────

export const MINUTES_REL = 'nodal-bench/compte-rendu.docx';

const append = defineScenario<DocObservation>({
  id: 'word-append',
  version: 1,
  title: 'Append a section at the end of an existing Word document',
  green: `${MINUTES_REL} was changed during the run: it still starts with the fixture's ${MINUTES.paragraphs.length + 1} paragraphs, in order, then has a heading reading "Décisions" followed by at least three non-empty paragraphs or list items, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'word',
  sends: 'nothing',
  instruction:
    `Ajoute à la fin du document ${MINUTES_REL} ${SHARED} une section « Décisions » (un titre), ` +
    'suivie d’au moins trois décisions, une par paragraphe ou en liste à puces. Ne change pas le reste.',
  timeoutMs: 10 * MIN,
  prepare(env) {
    installFixture(env.workspaceRoots, 'office/compte-rendu.docx', MINUTES_REL);
  },
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, MINUTES_REL, env.startedMs);
    return observeDoc(f.exists ? f.path : null, f.fresh);
  },
  judge(facts, o) {
    const { r, doc } = docReasons(MINUTES_REL, o);
    r.unshift(...commonReasons(facts));
    if (!doc) return r;
    const paras = doc.paragraphs.filter((p) => p.text.trim() !== '');
    const before = [MINUTES.title, ...MINUTES.paragraphs];
    before.forEach((want, i) => {
      if (normalizeSpace(paras[i]?.text ?? '') !== normalizeSpace(want))
        r.push(
          `paragraph ${i + 1} is ${JSON.stringify(paras[i]?.text ?? null)}, expected the fixture's`,
        );
    });
    const rest = paras.slice(before.length);
    const h = rest.findIndex((p) => isHeading(p) && /d[ée]cisions/i.test(p.text));
    if (h === -1) r.push('no heading reading "Décisions" after the original text');
    else {
      const items = rest.slice(h + 1).filter((p) => !isHeading(p));
      if (items.length < 3) r.push(`${items.length} decision(s) under "Décisions", fewer than 3`);
    }
    return r;
  },
});

// ─── word-table ──────────────────────────────────────────────────────────────

export const PLANNING_REL = 'nodal-bench/planning-bench.docx';
const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi'];
const COLUMNS = ['Jour', 'Tâche', 'Responsable'];

const table = defineScenario<DocObservation>({
  id: 'word-table',
  version: 1,
  title: 'Write a Word document holding a table',
  green: `${PLANNING_REL} was written during the run with a table whose header row is ${COLUMNS.join(' / ')} and whose next five rows start with lundi to vendredi, in order, every cell filled, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'word',
  sends: 'nothing',
  instruction:
    `Crée un document Word ${PLANNING_REL} dans ton espace de travail avec un tableau de trois ` +
    `colonnes (${COLUMNS.join(', ')}) et une ligne par jour, du lundi au vendredi.`,
  timeoutMs: 10 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, PLANNING_REL);
  },
  async observe(_facts, env) {
    const [hit] = findInRoots(env.workspaceRoots, PLANNING_REL, env.startedMs);
    return observeDoc(hit?.path ?? null, hit?.fresh ?? false);
  },
  judge(facts, o) {
    const { r, doc } = docReasons(PLANNING_REL, o);
    r.unshift(...commonReasons(facts));
    if (!doc) return r;
    const t = doc.tables.find(
      (x) => x[0] && COLUMNS.every((c, i) => lower(x[0]![i] ?? '') === c.toLowerCase()),
    );
    if (!t) {
      r.push(`no table with the header ${COLUMNS.join(' / ')} (${doc.tables.length} table(s))`);
      return r;
    }
    DAYS.forEach((day, i) => {
      const row = t[i + 1];
      if (!row) r.push(`no row for ${day}`);
      else {
        if (lower(row[0] ?? '') !== day)
          r.push(`row ${i + 2} starts with ${JSON.stringify(row[0] ?? '')}, expected ${day}`);
        if (row.length < 3 || row.slice(0, 3).some((c) => c.trim() === ''))
          r.push(`row ${i + 2} (${day}) has an empty cell`);
      }
    });
    return r;
  },
});

export const WORD_SCENARIOS: AnyScenario[] = [create, replace, append, table];
