// workflows/suites/powerpoint.ts — créer et modifier une présentation, vérifiée en la relisant.
//
// Les diapositives sont lues dans le XML de la présentation, dans l'ordre de la
// PRÉSENTATION (pas celui des fichiers). Une modification est jugée sur ce qui
// a changé et sur ce qui devait rester : les diapositives de la fixture,
// paragraphe par paragraphe.

import { findInRoots } from '../disk';
import { fileHash, fixturePath, installed } from '../fixtures';
import { OFFER_DECK, OFFER_PRO_PRICE, PROJECT_DECK, REVIEW_DECK } from '../fixture-data';
import {
  JUDGED_COMMON,
  answerOf,
  commonReasons,
  hasNumber,
  matches,
  missingFacts,
} from '../judge-kit';
import { normalizeSpace, readPptx, type PptxSlide } from '../office';
import { defineScenario, type AnyScenario } from '../types';
import { BASE, FILES, PPTX, TEAM, toolList } from '../scenario-tools';

const MIN = 60_000;
const SHARED = "de l'espace de travail partagé";

interface DeckObservation {
  readonly found: { path: string; fresh: boolean } | null;
  readonly slides: PptxSlide[] | null;
  readonly readError: string | null;
}

async function observeDeck(path: string | null, fresh: boolean): Promise<DeckObservation> {
  if (path === null) return { found: null, slides: null, readError: null };
  try {
    return { found: { path, fresh }, slides: await readPptx(path), readError: null };
  } catch (e) {
    return {
      found: { path, fresh },
      slides: null,
      readError: String(e instanceof Error ? e.message : e),
    };
  }
}

function deckReasons(rel: string, o: DeckObservation): { r: string[]; slides: PptxSlide[] | null } {
  if (!o.found) return { r: [`no file ${rel} in any workspace folder`], slides: null };
  const r: string[] = [];
  if (!o.found.fresh) r.push(`${rel} was not written during the run`);
  if (!o.slides)
    return { r: [...r, `${rel} cannot be read as a presentation: ${o.readError}`], slides: null };
  return { r, slides: o.slides };
}

const slideText = (s: PptxSlide | undefined): string =>
  normalizeSpace((s?.paragraphs ?? []).join(' '));

/** Les diapositives de la fixture, telles qu'elles doivent encore être lues. */
function sameSlides(
  got: readonly PptxSlide[],
  want: ReadonlyArray<readonly string[]>,
  map = (t: string) => t,
): string[] {
  const r: string[] = [];
  want.forEach((paras, i) => {
    const g = got[i]?.paragraphs.map((p) => normalizeSpace(map(p))) ?? [];
    const w = paras.map((p) => normalizeSpace(p));
    if (JSON.stringify(g) !== JSON.stringify(w))
      r.push(
        `slide ${i + 1} reads ${JSON.stringify(g)}, expected the fixture's ${JSON.stringify(w)}`,
      );
  });
  return r;
}

// ─── ppt-create ──────────────────────────────────────────────────────────────

export const GLASS_REL = 'nodal-bench/presentation-bench.pptx';

const create = defineScenario<DeckObservation>({
  id: 'ppt-create',
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${GLASS_REL}, written during the trial; slides in presentation order (p:sldIdLst)`,
    'exactly 5 slides; the first reads "Le recyclage du verre"; each of the next four holds a title and at least two other paragraphs',
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (pptx_create) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, PPTX),
  title: 'Create a presentation',
  path: 'pptx_create. A script in its place is red.',
  deliverable: GLASS_REL,
  productTools: { tools: ['pptx_create'], writes: [GLASS_REL], reads: [] },
  green: `${GLASS_REL} was written during the run through pptx_create (no command in its place) and opens as a presentation of exactly 5 slides, the first reads "Le recyclage du verre", each of the next four holds a title and at least two other paragraphs, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'powerpoint',
  sends: 'nothing',
  instruction:
    `Crée une présentation PowerPoint ${GLASS_REL} dans ton espace de travail, de 5 diapositives sur ` +
    'le recyclage du verre : une diapositive de titre « Le recyclage du verre », puis quatre ' +
    'diapositives de contenu, chacune avec un titre et des puces.',
  timeoutMs: 10 * MIN,
  outputs: [GLASS_REL],
  async observe(_facts, env) {
    const [hit] = findInRoots(env.workspaceRoots, GLASS_REL, env.startedMs);
    return observeDeck(hit?.path ?? null, hit?.fresh ?? false);
  },
  judge(facts, o) {
    const { r, slides } = deckReasons(GLASS_REL, o);
    r.unshift(...commonReasons(facts));
    if (!slides) return r;
    if (slides.length !== 5) r.push(`${slides.length} slide(s), expected 5`);
    if (!/le recyclage du verre/i.test(slideText(slides[0])))
      r.push(
        `the first slide reads ${JSON.stringify(slideText(slides[0]))}, not "Le recyclage du verre"`,
      );
    slides.slice(1, 5).forEach((s, i) => {
      if (s.paragraphs.length < 3)
        r.push(
          `slide ${i + 2} holds ${s.paragraphs.length} paragraph(s), fewer than a title and two bullets`,
        );
    });
    return r;
  },
});

// ─── ppt-append ──────────────────────────────────────────────────────────────

export const PROJECT_REL = 'nodal-bench/projet.pptx';

const append = defineScenario<DeckObservation>({
  id: 'ppt-append',
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${PROJECT_REL}; it must be changed during the trial`,
    '4 slides; the first three read exactly as the fixture\'s, paragraph by paragraph; the fourth reads "Prochaines étapes" and at least three more paragraphs',
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (pptx_append_slides) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, PPTX),
  title: 'Add a slide without touching the others',
  path: 'pptx_append_slides. A script in its place is red.',
  deliverable: `${PROJECT_REL}, changed`,
  productTools: { tools: ['pptx_append_slides'], writes: [PROJECT_REL], reads: [] },
  green: `${PROJECT_REL} was changed during the run through pptx_append_slides (no command in its place): it has 4 slides, the first three read exactly as the fixture's, the fourth reads "Prochaines étapes" and at least three more paragraphs, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'powerpoint',
  sends: 'nothing',
  instruction:
    `Ajoute à la fin de la présentation ${PROJECT_REL} ${SHARED} une quatrième diapositive ` +
    '« Prochaines étapes » avec trois puces. Ne change pas les autres diapositives.',
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/projet.pptx', to: PROJECT_REL }],
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, PROJECT_REL, env.startedMs);
    return observeDeck(f.exists ? f.path : null, f.fresh);
  },
  judge(facts, o) {
    const { r, slides } = deckReasons(PROJECT_REL, o);
    r.unshift(...commonReasons(facts));
    if (!slides) return r;
    if (slides.length !== 4) r.push(`${slides.length} slide(s), expected 4`);
    r.push(...sameSlides(slides, PROJECT_DECK));
    const last = slides[3];
    if (!/prochaines [ée]tapes/i.test(slideText(last)))
      r.push('the fourth slide does not read "Prochaines étapes"');
    else if ((last?.paragraphs.length ?? 0) < 4)
      r.push(
        `the fourth slide holds ${last?.paragraphs.length ?? 0} paragraph(s), fewer than a title and three bullets`,
      );
    return r;
  },
});

// ─── ppt-replace ─────────────────────────────────────────────────────────────

export const REVIEW_REL = 'nodal-bench/bilan-2025.pptx';

const replace = defineScenario<DeckObservation>({
  id: 'ppt-replace',
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${REVIEW_REL}; it must be changed during the trial`,
    "2025 appears nowhere; with 2026 read back as 2025, every slide reads exactly as the fixture's",
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (pptx_replace_text) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, PPTX),
  title: 'Replace a text everywhere',
  path: 'pptx_replace_text. A script in its place is red.',
  deliverable: `${REVIEW_REL}, changed`,
  productTools: { tools: ['pptx_replace_text'], writes: [REVIEW_REL], reads: [] },
  green: `${REVIEW_REL} was changed during the run through pptx_replace_text (no command in its place): 2025 appears nowhere, its ${REVIEW_DECK.length} slides read exactly as the fixture's with 2026 in place of 2025, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'powerpoint',
  sends: 'nothing',
  instruction:
    `Dans la présentation ${REVIEW_REL} ${SHARED}, remplace partout l'année 2025 par 2026, ` +
    'sans rien changer d’autre. Garde le même nom de fichier.',
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/bilan-2025.pptx', to: REVIEW_REL }],
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, REVIEW_REL, env.startedMs);
    return observeDeck(f.exists ? f.path : null, f.fresh);
  },
  judge(facts, o) {
    const { r, slides } = deckReasons(REVIEW_REL, o);
    r.unshift(...commonReasons(facts));
    if (!slides) return r;
    const all = slides.map(slideText).join(' ');
    if (/2025/.test(all)) r.push('2025 still appears');
    if (slides.length !== REVIEW_DECK.length)
      r.push(`${slides.length} slide(s), expected ${REVIEW_DECK.length}`);
    r.push(...sameSlides(slides, REVIEW_DECK, (t) => t.replace(/2026/g, '2025')));
    return r;
  },
});

// ─── ppt-read-answer ─────────────────────────────────────────────────────────

export const OFFER_REL = 'nodal-bench/offre.pptx';

const readAnswer = defineScenario<{ hash: string | null }>({
  id: 'ppt-read-answer',
  judgedBy: [
    ...JUDGED_COMMON,
    `the final answer says ${OFFER_DECK.length} slides and gives ${OFFER_PRO_PRICE}`,
    `${OFFER_REL} is byte for byte the fixture (sha-256)`,
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (pptx_read) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, PPTX),
  title: 'Read a presentation and answer',
  path: 'pptx_read. A script in its place is red.',
  deliverable: 'The answer, in the conversation',
  productTools: { tools: ['pptx_read'], writes: [], reads: [OFFER_REL] },
  green: `The answer says the presentation has ${OFFER_DECK.length} slides and gives ${OFFER_PRO_PRICE} € for the Pro plan, read through pptx_read (no command in its place), ${OFFER_REL} is byte for byte the fixture, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'powerpoint',
  sends: 'nothing',
  instruction: `Combien de diapositives contient la présentation ${OFFER_REL} ${SHARED}, et quel est le prix de la formule Pro ?`,
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/offre.pptx', to: OFFER_REL }],
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, OFFER_REL, env.startedMs);
    return { hash: f.exists ? fileHash(f.path) : null };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    r.push(
      ...missingFacts(
        answerOf(facts),
        [
          matches(
            /\b(4|quatre)\s+diapositives?\b|\b4\s+slides?\b/i,
            `say it has ${OFFER_DECK.length} slides`,
          ),
          hasNumber(OFFER_PRO_PRICE, 0, `give ${OFFER_PRO_PRICE}`),
        ],
        'the answer',
      ),
    );
    if (o.hash !== fileHash(fixturePath('office/offre.pptx')))
      r.push(`${OFFER_REL} was changed or removed`);
    return r;
  },
});

export const POWERPOINT_SCENARIOS: AnyScenario[] = [create, append, replace, readAnswer];
