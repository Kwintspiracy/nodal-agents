// workflows/suites/word.ts — créer et modifier un document Word, vérifié en le relisant.
//
// Le texte est lu par mammoth (l'outil `docx_read` du produit) ; la structure
// (titres, tableaux, ordre des paragraphes) dans le XML du document. Une
// modification est jugée sur ce qui a changé ET sur ce qui devait rester : le
// texte d'origine de la fixture, à l'identique.

import { findInRoots } from '../disk';
import { fileHash, fixturePath, installed } from '../fixtures';
import { CONTRACT, MINUTES, ORDER } from '../fixture-data';
import { JUDGED_COMMON, answerOf, commonReasons, hasNumber, missingFacts } from '../judge-kit';
import { isHeading, readDocx, normalizeSpace, type DocxView } from '../office';
import { defineScenario, type AnyScenario } from '../types';
import { BASE, DOCX, FILES, TEAM, toolList } from '../scenario-tools';

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

// ─── word-create (avec le tableau de word-table) ─────────────────────────────

export const CONVOCATION_REL = 'nodal-bench/convocation-bench.docx';
const AGENDA_COLUMNS = ['Heure', 'Sujet', 'Responsable'];
const AGENDA_ROWS = 3;

const create = defineScenario<DocObservation>({
  id: 'word-create',
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${CONVOCATION_REL}, written during the trial: text with mammoth, paragraphs and styles from the OOXML`,
    'a heading paragraph (Heading/Titre/Title style or an outline level) reads "Convocation", followed by at least three body paragraphs',
    'the text names 12 novembre 2026, 14 h and salle B',
    `a table whose header row is ${AGENDA_COLUMNS.join(' / ')}, followed by at least ${AGENDA_ROWS} rows with every cell filled`,
  ],
  // v2 (catalogue du 17/10) : fusion de word-table (le tableau de l'ordre du
  // jour), et la règle des outils du produit (docx_create) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, DOCX),
  title: 'Create a structured document',
  green: `${CONVOCATION_REL} was written during the run through docx_create (no command in its place), opens as a Word document, has a heading paragraph reading "Convocation" followed by at least three body paragraphs, names 12 novembre 2026, 14 h and salle B, holds a table headed ${AGENDA_COLUMNS.join(' / ')} with ${AGENDA_ROWS} filled rows, and nobody was asked anything.`,
  path: 'docx_create. A script in its place is red.',
  deliverable: CONVOCATION_REL,
  productTools: { tools: ['docx_create'], writes: [CONVOCATION_REL], reads: [] },
  set: 'on-demand',
  activity: 'word',
  sends: 'nothing',
  instruction:
    `Crée un document Word ${CONVOCATION_REL} dans ton espace de travail : un titre « Convocation » ` +
    '(en style de titre), puis trois paragraphes qui convoquent l’équipe à une réunion le ' +
    '12 novembre 2026 à 14 h en salle B, puis l’ordre du jour dans un tableau de trois colonnes ' +
    `(${AGENDA_COLUMNS.join(', ')}) avec ${AGENDA_ROWS} lignes remplies.`,
  timeoutMs: 10 * MIN,
  outputs: [CONVOCATION_REL],
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
    const agenda = doc.tables.find(
      (x) => x[0] && AGENDA_COLUMNS.every((c, i) => lower(x[0]![i] ?? '') === c.toLowerCase()),
    );
    if (!agenda) {
      r.push(
        `no table with the header ${AGENDA_COLUMNS.join(' / ')} (${doc.tables.length} table(s))`,
      );
      return r;
    }
    const filled = agenda
      .slice(1)
      .filter((row) => row.length >= 3 && row.slice(0, 3).every((c) => c.trim() !== ''));
    if (filled.length < AGENDA_ROWS)
      r.push(`the agenda table has ${filled.length} filled row(s), fewer than ${AGENDA_ROWS}`);
    return r;
  },
});

// ─── word-replace ────────────────────────────────────────────────────────────

export const CONTRACT_REL = 'nodal-bench/contrat.docx';

const replace = defineScenario<DocObservation>({
  id: 'word-replace',
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${CONTRACT_REL} (mammoth); it must be changed during the trial`,
    `"${CONTRACT.from}" appears nowhere and "${CONTRACT.to}" exactly ${CONTRACT.occurrences} times, the table included`,
    "every other character of the text is the fixture's",
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (docx_replace_text) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, DOCX),
  title: 'Replace a text everywhere, changing nothing else',
  path: 'docx_replace_text. A script in its place is red.',
  deliverable: `${CONTRACT_REL}, changed`,
  productTools: { tools: ['docx_replace_text'], writes: [CONTRACT_REL], reads: [] },
  green: `${CONTRACT_REL} was changed during the run through docx_replace_text (no command in its place): "${CONTRACT.from}" appears nowhere, "${CONTRACT.to}" appears exactly ${CONTRACT.occurrences} times (the table included), every other character of the text is the fixture's, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'word',
  sends: 'nothing',
  instruction:
    `Dans le document ${CONTRACT_REL} ${SHARED}, remplace partout « ${CONTRACT.from} » par ` +
    `« ${CONTRACT.to} », sans rien changer d’autre.`,
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/contrat.docx', to: CONTRACT_REL }],
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
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${MINUTES_REL}; it must be changed during the trial`,
    'it starts with the fixture\'s paragraphs in order, then a heading reading "Décisions" and at least three non-empty paragraphs or list items',
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (docx_append_paragraphs) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, DOCX),
  title: 'Add a section without touching the rest',
  path: 'docx_append_paragraphs. A script in its place is red.',
  deliverable: `${MINUTES_REL}, changed`,
  productTools: { tools: ['docx_append_paragraphs'], writes: [MINUTES_REL], reads: [] },
  green: `${MINUTES_REL} was changed during the run through docx_append_paragraphs (no command in its place): it still starts with the fixture's ${MINUTES.paragraphs.length + 1} paragraphs, in order, then has a heading reading "Décisions" followed by at least three non-empty paragraphs or list items, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'word',
  sends: 'nothing',
  instruction:
    `Ajoute à la fin du document ${MINUTES_REL} ${SHARED} une section « Décisions » (un titre), ` +
    'suivie d’au moins trois décisions, une par paragraphe ou en liste à puces. Ne change pas le reste.',
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/compte-rendu.docx', to: MINUTES_REL }],
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

// ─── word-read-answer ────────────────────────────────────────────────────────

export const ORDER_REL = 'nodal-bench/bon-commande.docx';

const readAnswer = defineScenario<{ hash: string | null }>({
  id: 'word-read-answer',
  judgedBy: [
    ...JUDGED_COMMON,
    `the final answer gives ${ORDER.totalHt.toFixed(2)} (any writing): the value is written only in the last row of the document's table`,
    `${ORDER_REL} is byte for byte the fixture (sha-256)`,
  ],
  // v2 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 2,
  tools: toolList(BASE, FILES, TEAM, DOCX),
  title: 'Read a document and answer',
  green: `The answer gives the order's total before tax, ${ORDER.totalHt.toFixed(2)} €, read through docx_read (no command in its place); ${ORDER_REL} is byte for byte the fixture; nobody was asked anything.`,
  path: 'docx_read. A script in its place is red.',
  deliverable: 'The answer, in the conversation',
  productTools: { tools: ['docx_read'], writes: [], reads: [ORDER_REL] },
  set: 'on-demand',
  activity: 'word',
  sends: 'nothing',
  instruction: `Quel est le montant total HT du bon de commande ${ORDER_REL} ${SHARED} ?`,
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/bon-commande.docx', to: ORDER_REL }],
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, ORDER_REL, env.startedMs);
    return { hash: f.exists ? fileHash(f.path) : null };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    r.push(
      ...missingFacts(
        answerOf(facts),
        [hasNumber(ORDER.totalHt, 2, `give ${ORDER.totalHt.toFixed(2)}`)],
        'the answer',
      ),
    );
    if (o.hash !== fileHash(fixturePath('office/bon-commande.docx')))
      r.push(`${ORDER_REL} was changed or removed`);
    return r;
  },
});

export const WORD_SCENARIOS: AnyScenario[] = [create, replace, append, readAnswer];
