// workflows/suites/answers.ts — questions, recherches et recherches approfondies.
//
// Ce qui est jugé ici est un TEXTE produit par l'équipe : la réponse finale
// (question, recherche) ou le rapport écrit sur le disque (recherche
// approfondie). Le juge y cherche des faits précis et vérifiables, choisis pour
// ne pas bouger avec le temps (une date historique, un nom), jamais « une bonne
// réponse » au jugé. Pour une recherche, il exige aussi un APPEL d'outil web
// dans l'arbre (une ligne `tool_calls`) et des liens ; que ces liens aient été
// lus n'est pas vérifié (#648), et la ligne le dit.

import { findInRoots, readText, removeBenchFile } from '../disk';
import type { TreeFacts } from '../facts';
import {
  SOURCES_READ,
  answerOf,
  commonReasons,
  hasNumber,
  hostsIn,
  matches,
  missingFacts,
  noDelegation,
  treeCalledTheWeb,
  urlsIn,
  type ExpectedFact,
} from '../judge-kit';
import { defineScenario, type AnyScenario } from '../types';

const MIN = 60_000;

// ─── question ────────────────────────────────────────────────────────────────

function question(o: {
  id: string;
  title: string;
  green: string;
  instruction: string;
  facts: ExpectedFact[];
  /** Ce que la réponse ne doit PAS contenir (une seconde réponse qui la contredirait). */
  not?: ExpectedFact[];
}): AnyScenario {
  return defineScenario<null>({
    id: o.id,
    version: 1,
    title: o.title,
    green: o.green,
    set: 'on-demand',
    activity: 'question',
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
    id: 'question-percent',
    title: 'A percentage, computed exactly',
    green:
      'The answer gives 397.8 (17 % of 2,340), the root answered itself, and nobody was asked anything.',
    instruction: 'Combien font 17 % de 2 340 ? Donne le résultat exact.',
    facts: [hasNumber(397.8, 1, 'give 397.8')],
  }),
  question({
    id: 'question-weekday',
    title: 'The weekday of a historical date',
    green:
      'The answer says Tuesday (mardi) and names no other weekday, the root answered itself, and nobody was asked anything.',
    instruction: 'Quel jour de la semaine était le 14 juillet 1789 ?',
    facts: [matches(/\b(mardi|tuesday)\b/i, 'say Tuesday (mardi)')],
    not: [matches(OTHER_WEEKDAYS, 'names another weekday')],
  }),
  question({
    id: 'question-seconds',
    title: 'A unit conversion',
    green:
      'The answer gives 604,800 seconds, the root answered itself, and nobody was asked anything.',
    instruction: 'Combien y a-t-il de secondes dans une semaine ?',
    facts: [hasNumber(604_800, 0, 'give 604800')],
  }),
  question({
    id: 'question-river',
    title: 'A geography fact',
    green: 'The answer names the Loire, the root answered itself, and nobody was asked anything.',
    instruction: 'Quel est le plus long fleuve de France ?',
    facts: [matches(/\bloire\b/i, 'name the Loire')],
  }),
];

// ─── research ────────────────────────────────────────────────────────────────

const RESEARCH_MIN_HOSTS = 2;

function research(o: {
  id: string;
  title: string;
  subject: string;
  instruction: string;
  facts: ExpectedFact[];
}): AnyScenario {
  return defineScenario<null>({
    id: o.id,
    version: 1,
    title: o.title,
    green: `A job of the run called a web search or page-read tool, the answer ${o.subject} and links sources on at least ${RESEARCH_MIN_HOSTS} different sites, and nobody was asked anything. Whether those sources were really read is not verified yet (#648).`,
    set: 'on-demand',
    activity: 'research',
    instruction: o.instruction,
    timeoutMs: 20 * MIN,
    unverified: [SOURCES_READ],
    observe: async () => null,
    judge(facts) {
      const r = commonReasons(facts);
      if (!treeCalledTheWeb(facts)) r.push('no job of the run called a web tool');
      const a = answerOf(facts);
      r.push(...missingFacts(a, o.facts, 'the answer'));
      const hosts = hostsIn(a);
      if (hosts.length < RESEARCH_MIN_HOSTS)
        r.push(`the answer links ${hosts.length} site(s), fewer than ${RESEARCH_MIN_HOSTS}`);
      return r;
    },
  });
}

const SOURCES = 'Donne tes sources avec leurs liens.';

export const RESEARCH_SCENARIOS: AnyScenario[] = [
  research({
    id: 'research-penicillin',
    title: 'Who discovered penicillin, when and how',
    subject: 'names Fleming and 1928',
    instruction: `Qui a découvert la pénicilline, en quelle année, et dans quelles circonstances ? ${SOURCES}`,
    facts: [matches(/\bfleming\b/i, 'name Fleming'), matches(/\b1928\b/, 'give 1928')],
  }),
  research({
    id: 'research-transistor',
    title: 'Who invented the transistor, where and when',
    subject: 'names Bardeen, Brattain, Bell Labs and 1947',
    instruction: `Qui a inventé le transistor, dans quel laboratoire et en quelle année ? ${SOURCES}`,
    facts: [
      matches(/\bbardeen\b/i, 'name Bardeen'),
      matches(/\bbrattain\b/i, 'name Brattain'),
      matches(/\bbell\b/i, 'name Bell Labs'),
      matches(/\b1947\b/, 'give 1947'),
    ],
  }),
  research({
    id: 'research-rabies',
    title: 'The first rabies vaccination of a human',
    subject: 'names Pasteur, Joseph Meister and 1885',
    instruction: `Quand et par qui le vaccin contre la rage a-t-il été administré pour la première fois à un être humain, et à qui ? ${SOURCES}`,
    facts: [
      matches(/\bpasteur\b/i, 'name Pasteur'),
      matches(/\bmeister\b/i, 'name Joseph Meister'),
      matches(/\b1885\b/, 'give 1885'),
    ],
  }),
  research({
    id: 'research-voyager',
    title: 'When Voyager 1 left the heliosphere, and how it was known',
    subject: 'gives 2012 and the plasma measurement',
    instruction: `Quand la sonde Voyager 1 a-t-elle franchi l'héliopause, et comment les scientifiques l'ont-ils établi ? ${SOURCES}`,
    facts: [
      matches(/\b2012\b/, 'give 2012'),
      matches(
        /plasma|densit[ée]|density|[ée]lectron/i,
        'name the plasma (electron density) measurement',
      ),
    ],
  }),
];

// ─── deep research ───────────────────────────────────────────────────────────

const REPORT_MIN_CHARS = 3000;
const REPORT_MIN_HOSTS = 4;
const REPORT_MIN_HEADINGS = 3;

interface ReportObservation {
  readonly found: { path: string; fresh: boolean; text: string } | null;
}

function deepResearch(o: {
  id: string;
  title: string;
  topic: string;
  rel: string;
  facts: ExpectedFact[];
  subject: string;
}): AnyScenario {
  return defineScenario<ReportObservation>({
    id: o.id,
    version: 1,
    title: o.title,
    green: `A job of the run called a web tool, the report ${o.rel} was written during the run with at least ${REPORT_MIN_HEADINGS} section headings, ${REPORT_MIN_CHARS} characters and links to ${REPORT_MIN_HOSTS} different sites, it ${o.subject}, and nobody was asked anything. Whether those sources were really read is not verified yet (#648).`,
    set: 'on-demand',
    activity: 'deep-research',
    instruction:
      `Fais une recherche approfondie sur ${o.topic}. Écris un rapport complet en Markdown dans ` +
      `${o.rel} de ton espace de travail, organisé en sections avec des titres, et cite au moins ` +
      'quatre sources différentes avec leurs liens.',
    timeoutMs: 30 * MIN,
    unverified: [SOURCES_READ],
    prepare(env) {
      removeBenchFile(env.workspaceRoots, o.rel);
    },
    async observe(_facts, env) {
      const [hit] = findInRoots(env.workspaceRoots, o.rel, env.startedMs);
      return { found: hit ? { path: hit.path, fresh: hit.fresh, text: readText(hit.path) } : null };
    },
    judge(facts: TreeFacts, ob) {
      const r = commonReasons(facts);
      if (!treeCalledTheWeb(facts)) r.push('no job of the run called a web tool');
      if (!ob.found) {
        r.push(`no report ${o.rel} in any workspace folder`);
        return r;
      }
      if (!ob.found.fresh) r.push(`${o.rel} exists but was not written during the run`);
      const text = ob.found.text;
      if (text.length < REPORT_MIN_CHARS)
        r.push(`the report holds ${text.length} characters, fewer than ${REPORT_MIN_CHARS}`);
      const headings = text.match(/^#{1,6}[ \t]+\S/gm)?.length ?? 0;
      if (headings < REPORT_MIN_HEADINGS)
        r.push(`the report has ${headings} section heading(s), fewer than ${REPORT_MIN_HEADINGS}`);
      const hosts = hostsIn(text);
      if (hosts.length < REPORT_MIN_HOSTS)
        r.push(
          `the report links ${hosts.length} site(s) (${urlsIn(text).length} link(s)), fewer than ${REPORT_MIN_HOSTS}`,
        );
      r.push(...missingFacts(text, o.facts, 'the report'));
      return r;
    },
  });
}

export const DEEP_RESEARCH_SCENARIOS: AnyScenario[] = [
  deepResearch({
    id: 'deep-research-dna',
    title: 'An in-depth report on the discovery of the DNA double helix',
    topic:
      "la découverte de la structure en double hélice de l'ADN (les équipes, les données, le rôle de Rosalind Franklin)",
    rel: 'nodal-bench/rapport-adn.md',
    subject: 'names Watson, Crick, Franklin, Photo 51 and 1953',
    facts: [
      matches(/\bwatson\b/i, 'name Watson'),
      matches(/\bcrick\b/i, 'name Crick'),
      matches(/\bfranklin\b/i, 'name Rosalind Franklin'),
      matches(/photo\s*(n[°o]\s*)?51|photograph\s*51/i, 'name Photo 51'),
      matches(/\b1953\b/, 'give 1953'),
    ],
  }),
  deepResearch({
    id: 'deep-research-gps',
    title: 'An in-depth report on the history of GPS',
    topic:
      "l'histoire du système GPS (son origine militaire, les premiers satellites, l'ouverture au public)",
    rel: 'nodal-bench/rapport-gps.md',
    subject: 'names NAVSTAR and 1978',
    facts: [
      matches(/\bnavstar\b/i, 'name NAVSTAR'),
      matches(/\b1978\b/, 'give 1978 (first satellite)'),
    ],
  }),
  deepResearch({
    id: 'deep-research-gutenberg',
    title: "An in-depth report on Gutenberg's printing press",
    topic:
      "l'invention de l'imprimerie à caractères mobiles par Gutenberg (le lieu, la technique, la Bible)",
    rel: 'nodal-bench/rapport-gutenberg.md',
    subject: 'names Mainz, the Bible and a year of the 1450s',
    facts: [
      matches(/\b(mayence|mainz)\b/i, 'name Mainz (Mayence)'),
      matches(/\bbible\b/i, 'name the Bible'),
      matches(/\b145\d\b/, 'give a year of the 1450s'),
    ],
  }),
  deepResearch({
    id: 'deep-research-apollo',
    title: 'An in-depth report on the Apollo 11 mission',
    topic: "la mission Apollo 11 (l'équipage, le déroulement, l'alunissage)",
    rel: 'nodal-bench/rapport-apollo11.md',
    subject: 'names Armstrong, Aldrin, Collins and 1969',
    facts: [
      matches(/\barmstrong\b/i, 'name Armstrong'),
      matches(/\baldrin\b/i, 'name Aldrin'),
      matches(/\bcollins\b/i, 'name Collins'),
      matches(/\b1969\b/, 'give 1969'),
    ],
  }),
];
