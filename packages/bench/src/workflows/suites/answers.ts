// workflows/suites/answers.ts — questions, recherches et recherches approfondies.
//
// Ce qui est jugé ici est un TEXTE produit par l'équipe : la réponse finale
// (question, recherche) ou le rapport écrit sur le disque (recherche
// approfondie, dans le dossier du banc ou dans le coffre Obsidian). Le juge y
// cherche des faits précis et vérifiables, jamais « une bonne réponse » au
// jugé.
//
// Une recherche, depuis le catalogue du 17/10 :
//   - son sujet est CALIBRÉ (décision 3) : un fait que les modèles comparés
//     ignorent sans outil, lu dans le fichier des sujets (subjects.ts). Sans
//     sujet calibré, l'essai est sauté (#776) ; il n'y a pas de sujet par défaut ;
//   - son chemin est jugé (décision 2) : une recherche simple est faite par la
//     racine seule avec un outil web, une délégation est rouge ; une recherche
//     approfondie est confiée à un coéquipier, et un job délégué doit appeler
//     un outil web ;
//   - le fait attendu doit figurer dans une SORTIE d'outil web de l'arbre (il
//     vient du web, pas de la mémoire), et chaque lien cité doit y avoir été
//     vu (#648, la partie mesurable). Qu'une page ait été LUE reste non
//     vérifié, et la ligne le dit (`SOURCES_READ`).

import { findInRoots, freshFilesUnder, readText } from '../disk';
import type { TreeFacts } from '../facts';
import {
  JUDGED_COMMON,
  SOURCES_READ,
  answerOf,
  citedLinks,
  commonReasons,
  delegateCalledTheWeb,
  delegatedJobs,
  factsNotSeenOnTheWeb,
  hostsIn,
  matches,
  missingFacts,
  noDelegation,
  rootCalledTheWeb,
  unseenLinkReasons,
  urlsIn,
  type ExpectedFact,
} from '../judge-kit';
import { NO_VAULT, obsidianVaults } from '../needs';
import { subjectFacts, subjectOf, type ResearchSubject } from '../subjects';
import { defineScenario, type AnyScenario } from '../types';

const MIN = 60_000;

// ─── question ────────────────────────────────────────────────────────────────

function question(o: {
  id: string;
  title: string;
  green: string;
  path: string;
  set: 'nightly' | 'on-demand';
  instruction: string;
  facts: ExpectedFact[];
  /** Ce que la réponse ne doit PAS contenir (une seconde réponse qui la contredirait). */
  not?: ExpectedFact[];
}): AnyScenario {
  return defineScenario<null>({
    id: o.id,
    judgedBy: [
      ...JUDGED_COMMON,
      'agent_jobs: no delegated job (the root answered itself)',
      ...o.facts.map((f) => `the root's final answer must ${f.says}`),
      ...(o.not ?? []).map((n) => `red if the final answer ${n.says}`),
    ],
    version: 1,
    title: o.title,
    green: o.green,
    path: o.path,
    deliverable: 'The answer, in the conversation',
    set: o.set,
    activity: 'question',
    sends: 'nothing',
    instruction: o.instruction,
    timeoutMs: 5 * MIN,
    observe: async () => null,
    judge(facts) {
      const r = commonReasons(facts);
      const a = answerOf(facts);
      r.push(...missingFacts(a, o.facts, 'the answer'));
      for (const n of o.not ?? []) if (n.holds(a)) r.push(`the answer ${n.says}`);
      r.push(...noDelegation(facts));
      return r;
    },
  });
}

const OTHER_WEEKDAYS =
  /\b(lundi|mercredi|jeudi|vendredi|samedi|dimanche|monday|wednesday|thursday|friday|saturday|sunday)\b/i;

export const QUESTION_SCENARIOS: AnyScenario[] = [
  question({
    id: 'question',
    title: 'Answer from memory, without a detour',
    green:
      'The answer names Canberra, the root answered itself (no delegation), and nobody was asked anything.',
    path: 'The root answers alone. No tool is needed.',
    set: 'nightly',
    instruction: "Quelle est la capitale de l'Australie ?",
    facts: [matches(/canberra/i, 'name Canberra')],
  }),
  question({
    id: 'question-weekday',
    title: 'Exact calculation: computed or guessed?',
    green:
      'The answer says Tuesday (mardi) and names no other weekday, the root answered itself, and nobody was asked anything.',
    path: 'The root answers alone. A calculation by a tool (run_command) is expected but not required: the tools it called are measured.',
    set: 'on-demand',
    instruction: 'Quel jour de la semaine était le 14 juillet 1789 ?',
    facts: [matches(/\b(mardi|tuesday)\b/i, 'say Tuesday (mardi)')],
    not: [matches(OTHER_WEEKDAYS, 'names another weekday')],
  }),
];

// ─── research : la racine seule, avec un outil web ───────────────────────────

const RESEARCH_MIN_HOSTS = 2;

const SEEN_LINKS =
  'tool_calls: every link cited is seen in the output of a web tool of the tree that did not receive it as input (#648, the measurable part)';
const SEEN_FACTS =
  "tool_calls: every expected fact of the calibrated subject is held by a web tool output of the tree (it comes from the web, not the model's memory)";

/** Ce qu'un essai de recherche observe : le sujet joué, ses faits gardés tels quels. */
interface ResearchObservation {
  readonly subject: ResearchSubject;
}

const research = defineScenario<ResearchObservation>({
  id: 'research',
  judgedBy: [
    ...JUDGED_COMMON,
    'the subject is the first calibrated subject of kind research (packages/bench/subjects/research-subjects.json); none: skipped (#776)',
    'agent_jobs: no delegated job (decision of 2026-10-17: a simple research is done by the root)',
    'tool_calls: the root job called a web tool itself (web_search, tavily_*, firecrawl_*, fetch*, cli:WebSearch…)',
    "the root's final answer holds every expected fact of the subject",
    SEEN_FACTS,
    `the final answer links sources on at least ${RESEARCH_MIN_HOSTS} different sites (distinct hosts)`,
    SEEN_LINKS,
  ],
  // v4 (catalogue du 17/10) : un sujet calibré au lieu du fond diffus
  // cosmologique, la racine seule (une délégation est rouge), le fait et chaque
  // lien vus dans une sortie d'outil web. v3 exigeait la délégation.
  version: 4,
  title: 'Find on the web a fact the model does not know',
  green: `The root answered itself after calling a web tool, with no delegation; the answer holds the calibrated subject's facts and a web tool output of the run holds them too; it links at least ${RESEARCH_MIN_HOSTS} sites and every link it cites was seen in a web tool output; nobody was asked anything. Whether the pages were really read is not verified yet (#648).`,
  path: 'The root alone, with web_search. A delegation is red (decision of 2026-10-17: the specialist is for in-depth research only).',
  deliverable: 'A sourced answer, with links, in the conversation',
  subject: 'research',
  set: 'nightly',
  activity: 'research',
  sends: 'nothing',
  instruction:
    'Trouve sur le web la réponse à cette question, et donne tes sources avec leurs liens : {subject}',
  timeoutMs: 20 * MIN,
  unverified: [SOURCES_READ],
  observe: async (_facts, env) => ({ subject: subjectOf(env) }),
  judge(facts, o) {
    const r = commonReasons(facts);
    r.push(...noDelegation(facts, 'a simple research'));
    if (!rootCalledTheWeb(facts)) r.push('the root called no web tool');
    const a = answerOf(facts);
    const expected = subjectFacts(o.subject);
    r.push(...missingFacts(a, expected, 'the answer'));
    r.push(...factsNotSeenOnTheWeb(facts, expected));
    const hosts = hostsIn(a);
    if (hosts.length < RESEARCH_MIN_HOSTS)
      r.push(`the answer links ${hosts.length} site(s), fewer than ${RESEARCH_MIN_HOSTS}`);
    r.push(...unseenLinkReasons(citedLinks(facts, a), 'the answer'));
    return r;
  },
});

// ─── deep research : confiée au spécialiste, livrée en rapport ───────────────

const REPORT_MIN_HOSTS = 4;
const REPORT_MIN_HEADINGS = 3;

const DELEGATED_WEB =
  'agent_jobs + tool_calls: the research was handed to a teammate (a delegated job), and a delegated job called a web tool; the root doing it alone is red (decision of 2026-10-17)';

/** La recherche approfondie a été confiée, et le délégué est allé sur le web. */
function handedToTheSpecialist(facts: TreeFacts): string[] {
  if (delegatedJobs(facts).length === 0)
    return ['the in-depth research was not handed to a teammate: the root did it alone'];
  return delegateCalledTheWeb(facts) ? [] : ['no delegated job called a web tool'];
}

/**
 * Les règles d'un rapport de recherche approfondie, les mêmes pour le rapport
 * Markdown et la note du coffre : des sections, des sites cités et vus, les
 * faits du sujet présents et vus sur le web.
 */
function reportReasons(
  facts: TreeFacts,
  text: string,
  subject: ResearchSubject,
  where: string,
): string[] {
  const r: string[] = [];
  const headings = text.match(/^#{1,6}[ \t]+\S/gm)?.length ?? 0;
  if (headings < REPORT_MIN_HEADINGS)
    r.push(`${where} has ${headings} section heading(s), fewer than ${REPORT_MIN_HEADINGS}`);
  const hosts = hostsIn(text);
  if (hosts.length < REPORT_MIN_HOSTS)
    r.push(
      `${where} links ${hosts.length} site(s) (${urlsIn(text).length} link(s)), fewer than ${REPORT_MIN_HOSTS}`,
    );
  r.push(...unseenLinkReasons(citedLinks(facts, text), where));
  const expected = subjectFacts(subject);
  r.push(...missingFacts(text, expected, where));
  r.push(...factsNotSeenOnTheWeb(facts, expected));
  return r;
}

const REPORT_JUDGED = [
  `at least ${REPORT_MIN_HEADINGS} Markdown headings and links on ${REPORT_MIN_HOSTS} different sites`,
  SEEN_LINKS,
  'it holds every expected fact of the calibrated subject',
  SEEN_FACTS,
];

export const REPORT_REL = 'nodal-bench/rapport.md';

interface ReportObservation {
  readonly subject: ResearchSubject;
  readonly found: { path: string; fresh: boolean; text: string } | null;
}

const deepResearchReport = defineScenario<ReportObservation>({
  // Fusion des quatre deep-research-dna, -gps, -gutenberg, -apollo. Renommé
  // d'après ce qu'il teste (un rapport) : son sujet n'est plus l'ADN, il est
  // calibré. Les lignes de deep-research-dna restent une série close
  // (`RENAMED_IDS`, catalog.ts).
  id: 'deep-research-report',
  judgedBy: [
    ...JUDGED_COMMON,
    'the subject is the first calibrated subject of kind deep-research; none: skipped (#776)',
    DELEGATED_WEB,
    `opens ${REPORT_REL} in the workspace folders: it must exist and be written during the trial`,
    ...REPORT_JUDGED,
  ],
  // v1 de ce nouvel identifiant (catalogue du 17/10) : un sujet calibré, confié
  // au spécialiste, le rapport dans nodal-bench/rapport.md, chaque lien et
  // chaque fait vus dans une sortie d'outil web. Le minimum de 3 000 caractères
  // de deep-research-dna disparaît : la spécification juge des sections, des
  // sites et des faits, pas une longueur.
  version: 1,
  title: 'In-depth research delivered as a Markdown report',
  green: `The research was handed to a teammate who called a web tool; ${REPORT_REL} was written during the run with at least ${REPORT_MIN_HEADINGS} section headings and links to ${REPORT_MIN_HOSTS} different sites, every link seen in a web tool output; it holds the calibrated subject's facts and a web tool output holds them too; nobody was asked anything. Whether the pages were really read is not verified yet (#648).`,
  path: 'Handed to the research specialist, who has the web tools (Firecrawl, Tavily…): the root doing it alone is red. The searches and pages opened are measured.',
  deliverable: REPORT_REL,
  subject: 'deep-research',
  set: 'on-demand',
  activity: 'deep-research',
  sends: 'nothing',
  instruction:
    'Fais une recherche approfondie sur {subject}. Écris un rapport complet en Markdown dans ' +
    `${REPORT_REL} de ton espace de travail, organisé en sections avec des titres, et cite au moins ` +
    'quatre sources différentes avec leurs liens.',
  timeoutMs: 30 * MIN,
  unverified: [SOURCES_READ],
  outputs: [REPORT_REL],
  async observe(_facts, env) {
    const [hit] = findInRoots(env.workspaceRoots, REPORT_REL, env.startedMs);
    return {
      subject: subjectOf(env),
      found: hit ? { path: hit.path, fresh: hit.fresh, text: readText(hit.path) } : null,
    };
  },
  cites: (_facts, o) => o.found?.text ?? null,
  judge(facts, o) {
    const r = commonReasons(facts);
    r.push(...handedToTheSpecialist(facts));
    if (!o.found) return [...r, `no report ${REPORT_REL} in any workspace folder`];
    if (!o.found.fresh) r.push(`${REPORT_REL} exists but was not written during the run`);
    r.push(...reportReasons(facts, o.found.text, o.subject, 'the report'));
    return r;
  },
});

// ─── deep-research-obsidian : la même recherche, livrée dans le coffre ───────

/** Le dossier et l'étiquette que la demande impose, pour retrouver et nettoyer les notes du banc. */
export const BENCH_NOTE_FOLDER = 'Nodal Bench';
export const BENCH_NOTE_TAG = 'nodal-bench';

interface VaultNote {
  readonly vault: string;
  readonly rel: string;
  readonly chars: number;
  readonly urls: string[];
  readonly marked: boolean;
  readonly text: string;
}
interface VaultObservation {
  readonly subject: ResearchSubject;
  readonly vaults: string[];
  readonly notes: VaultNote[];
  readonly truncated: boolean;
}

function isMarkedNote(rel: string, text: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.includes(BENCH_NOTE_FOLDER)) return true;
  return new RegExp(`(^|[\\s#\\[,'"-])#?${BENCH_NOTE_TAG}\\b`, 'im').test(text);
}

/** La note retenue : celle qui porte le plus de liens, puis la plus longue. */
function bestNote(notes: readonly VaultNote[]): VaultNote | undefined {
  return [...notes].sort((a, b) => b.urls.length - a.urls.length || b.chars - a.chars)[0];
}

const deepResearchObsidian = defineScenario<VaultObservation>({
  id: 'deep-research-obsidian',
  judgedBy: [
    ...JUDGED_COMMON,
    'the subject is the first calibrated subject of kind deep-research, the same as the Markdown report; none: skipped (#776)',
    DELEGATED_WEB,
    'lists the .md files written during the trial in every workspace folder holding .obsidian/',
    `the best note (most links, then longest) is in "${BENCH_NOTE_FOLDER}" or tagged #${BENCH_NOTE_TAG}`,
    ...REPORT_JUDGED.map((j) => `the note: ${j}`),
  ],
  // v4 (catalogue du 17/10) : le sujet calibré du rapport Markdown au lieu de
  // Champollion, et les règles du rapport appliquées à la note (sections,
  // 4 sites vus, faits vus sur le web). v3 jugeait 1 500 caractères et 3 liens.
  version: 4,
  title: 'The same in-depth research, delivered in Obsidian',
  green: `The research was handed to a teammate who called a web tool; a note was written in the vault during the run (in the "${BENCH_NOTE_FOLDER}" folder or tagged #${BENCH_NOTE_TAG}) with at least ${REPORT_MIN_HEADINGS} section headings and links to ${REPORT_MIN_HOSTS} different sites, every link seen in a web tool output; it holds the calibrated subject's facts and a web tool output holds them too; nobody was asked anything. Whether the pages were really read is not verified yet (#648).`,
  path: 'The same as the Markdown report (handed to the specialist, the root alone is red), then written in the vault.',
  deliverable: `A note in the "${BENCH_NOTE_FOLDER}" folder of the Obsidian vault`,
  subject: 'deep-research',
  set: 'nightly',
  activity: 'deep-research',
  sends: 'nothing',
  needs: ['obsidian-vault'],
  instruction:
    'Fais une recherche approfondie sur {subject}. Écris le rapport complet comme une note dans ' +
    `mon coffre Obsidian, dans le dossier « ${BENCH_NOTE_FOLDER} », avec le tag #${BENCH_NOTE_TAG}, ` +
    'organisé en sections avec des titres, et cite au moins quatre sources différentes avec leurs liens.',
  timeoutMs: 30 * MIN,
  unverified: [SOURCES_READ],
  async observe(_facts, env) {
    const subject = subjectOf(env);
    const vaults = obsidianVaults(env.workspaceRoots);
    const notes: VaultNote[] = [];
    let truncated = false;
    for (const vault of vaults) {
      const found = freshFilesUnder(vault, ['.md'], env.startedMs);
      truncated ||= found.truncated;
      for (const f of found.files) {
        const text = readText(f.path);
        notes.push({
          vault,
          rel: f.rel,
          chars: text.length,
          urls: urlsIn(text),
          marked: isMarkedNote(f.rel, text),
          text,
        });
      }
    }
    return { subject, vaults, notes, truncated };
  },
  cites: (_facts, o) => bestNote(o.notes)?.text ?? null,
  judge(facts, o) {
    const r = commonReasons(facts);
    r.push(...handedToTheSpecialist(facts));
    if (o.vaults.length === 0) {
      // Le coffre a pu disparaître pendant l'essai : le juge le dit encore.
      r.push(NO_VAULT);
      return r;
    }
    const best = bestNote(o.notes);
    if (!best) {
      r.push(
        `no note was written or updated in the vault during the run${o.truncated ? ' (vault scan truncated)' : ''}`,
      );
      return r;
    }
    if (!best.marked)
      r.push(
        `the note ${best.rel} is neither in "${BENCH_NOTE_FOLDER}" nor tagged #${BENCH_NOTE_TAG}`,
      );
    r.push(...reportReasons(facts, best.text, o.subject, 'the note'));
    return r;
  },
});

export const RESEARCH_SCENARIOS: AnyScenario[] = [research];
export const DEEP_RESEARCH_SCENARIOS: AnyScenario[] = [deepResearchReport, deepResearchObsidian];
