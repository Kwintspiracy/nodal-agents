// measure/job-announcement.ts — rejouer l'annonce dite de jobs finis, et la relever (#967).
//
// L'annonce est la génération que le runner fait quand un job lancé par la
// voix finit (`writeJobAnnouncement`, chat/job-announcement.ts) : la MÊME
// fonction, sur la ligne réelle de chaque job (sa demande, son résultat, son
// agent), autant de fois qu'on le demande. Chaque annonce est relevée sur ce
// que le propriétaire a fixé (04/11) : ses mots, ses phrases, si elle LIT le
// résultat au lieu de l'annoncer, si elle nomme un canal ou dit où le lire
// (« je sais où je peux les lire »), si elle porte une adresse web ou du
// markdown — et si elle sonne comme une formule : les phrases identiques
// d'un essai à l'autre, et d'un job à l'autre.
//
// CE QU'ELLE ÉCRIT DANS LA BASE : rien. `writeJobAnnouncement` ne fait que lire
// (le job, l'agent, sa clé) ; l'annonce n'est pas rangée, et aucun traceur
// d'appel n'est branché (`observe: null`). Les appels au modèle sont réels, et
// facturés sur la clé de l'agent.

import { splitSentences } from '@nodal-agents/speech';
import { CHANNELS, redactSecretsInText } from '@nodal-agents/shared';
import { agentJobs, eq, type AnyDrizzleDb } from '@nodal-agents/db';
import { writeJobAnnouncement, type JobAnnouncement } from '../chat/job-announcement.ts';

export interface AnnouncementRecord {
  jobId: string;
  run: number;
  /** null : l'annonce n'a pas pu s'écrire (`code`, `detail`). */
  text: string | null;
  code: string | null;
  detail: string | null;
  ms: number;
  words: number;
  sentences: number;
  /** Titres, gras, puces, listes numérotées, code. */
  markdown: boolean;
  url: boolean;
  /** La plus longue suite d'au moins 4 mots reprise telle quelle du résultat, ou null. */
  sharedPhrase: string | null;
  /** Les nombres du résultat (3 chiffres et plus) que l'annonce répète. */
  numbersFromResult: string[];
  /**
   * TOUT nombre que l'annonce dit, en chiffres ou en toutes lettres (« sixty
   * thousand » échappait au relevé du rejeu 5) : l'annonce d'un travail n'en
   * dit aucun.
   */
  numbers: string[];
  /** Les canaux de messagerie que l'annonce nomme (la liste des canaux de Nodal). */
  channelNames: string[];
  /** Les tournures « où le lire » que l'annonce porte. */
  whereToRead: string[];
}

const MARKDOWN = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s)|\*\*|__|`/;
const URL = /https?:\/\/|www\./i;
/**
 * « Où le lire », en anglais et en français : Nodal nommé, un « lire / read »,
 * le fil désigné comme lieu (« in the chat », « dans la conversation »), ou
 * le geste de l'y avoir mis (« written it up », « put the summary ») — le
 * rejeu 6 disait « I've put the summary in the chat for you to read » et
 * « I've written it up in the conversation ».
 */
const WHERE_TO_READ =
  /\bnodal\b|\bread (it|the|them|this|that|your)\b|\bto read\b|\breadable\b|\bin the (chat|conversation|thread)\b|\bwritten (it|them|everything) up\b|\bput (it|them|the \w+|everything)\b|\blire\b|\blis-le\b|\bconsulter\b|\bdans (le fil|la conversation|le chat)\b|\bje l'ai (mis|mise|écrit|rédigé)\b/gi;

/** Un nombre en toutes lettres, en anglais et en français. */
const NUMBER_WORDS =
  /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|vingt|trente|quarante|cinquante|soixante|cent|mille|milliard)s?\b/gi;

function normalisedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** La plus longue suite de mots (≥ `min`) de `text` qui figure dans `source`. */
export function longestSharedPhrase(text: string, source: string, min = 4): string | null {
  const words = normalisedWords(text);
  const haystack = ` ${normalisedWords(source).join(' ')} `;
  let best: string | null = null;
  for (let i = 0; i < words.length; i++) {
    for (let j = words.length; j - i >= min; j--) {
      const phrase = words.slice(i, j).join(' ');
      if (best !== null && phrase.split(' ').length <= best.split(' ').length) break;
      if (haystack.includes(` ${phrase} `)) {
        best = phrase;
        break;
      }
    }
  }
  return best;
}

function numbersOf(text: string): string[] {
  return [...new Set((text.match(/\d[\d,.  ]*\d/g) ?? []).map((n) => n.replace(/\D/g, '')))].filter(
    (n) => n.length >= 3,
  );
}

/** Le relevé d'une annonce. */
export function recordAnnouncement(
  jobId: string,
  run: number,
  out: JobAnnouncement,
  ms: number,
  result: string,
): AnnouncementRecord {
  const empty = {
    jobId,
    run,
    ms,
    words: 0,
    sentences: 0,
    markdown: false,
    url: false,
    sharedPhrase: null,
    numbersFromResult: [],
    numbers: [],
    channelNames: [],
    whereToRead: [],
  };
  if (!out.ok) {
    return {
      ...empty,
      text: null,
      code: out.code,
      detail: out.detail ? redactSecretsInText(out.detail) : null,
    };
  }
  const text = out.text;
  const resultNumbers = new Set(numbersOf(result));
  return {
    ...empty,
    text,
    code: null,
    detail: null,
    words: text.split(/\s+/).filter((w) => w !== '').length,
    sentences: splitSentences(text).length,
    markdown: MARKDOWN.test(text),
    url: URL.test(text),
    sharedPhrase: longestSharedPhrase(text, result),
    numbersFromResult: numbersOf(text).filter((n) => resultNumbers.has(n)),
    numbers: [
      ...new Set([
        ...(text.match(/\d[\d,.]*/g) ?? []),
        ...(text.match(NUMBER_WORDS) ?? []).map((w) => w.toLowerCase()),
      ]),
    ],
    channelNames: CHANNELS.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(text)),
    whereToRead: [...new Set((text.match(WHERE_TO_READ) ?? []).map((m) => m.toLowerCase()))],
  };
}

/** Une phrase, comparée sans casse ni ponctuation. */
function sentenceKey(sentence: string): string {
  return normalisedWords(sentence).join(' ');
}

export interface Sameness {
  /** Les phrases dites dans PLUS d'un essai d'un même job, avec le nombre d'essais. */
  withinJobs: Array<{ jobId: string; sentence: string; runs: number }>;
  /** Les phrases dites par PLUS d'un job, avec les jobs. */
  acrossJobs: Array<{ sentence: string; jobs: string[] }>;
}

/** Ce qui se répète : la même phrase d'un essai à l'autre, et d'un job à l'autre. */
export function sameness(records: readonly AnnouncementRecord[]): Sameness {
  const runsOf = new Map<string, Map<string, Set<number>>>();
  const jobsOf = new Map<string, Set<string>>();
  const shown = new Map<string, string>();
  for (const r of records) {
    if (r.text === null) continue;
    for (const s of splitSentences(r.text)) {
      const key = sentenceKey(s);
      if (key === '') continue;
      shown.set(key, shown.get(key) ?? s.trim());
      const byJob = runsOf.get(r.jobId) ?? new Map<string, Set<number>>();
      runsOf.set(r.jobId, byJob);
      byJob.set(key, (byJob.get(key) ?? new Set()).add(r.run));
      jobsOf.set(key, (jobsOf.get(key) ?? new Set()).add(r.jobId));
    }
  }
  const withinJobs: Sameness['withinJobs'] = [];
  for (const [jobId, byJob] of runsOf) {
    for (const [key, runs] of byJob) {
      if (runs.size > 1) withinJobs.push({ jobId, sentence: shown.get(key)!, runs: runs.size });
    }
  }
  const acrossJobs: Sameness['acrossJobs'] = [];
  for (const [key, jobs] of jobsOf) {
    if (jobs.size > 1) acrossJobs.push({ sentence: shown.get(key)!, jobs: [...jobs] });
  }
  return { withinJobs, acrossJobs };
}

export interface AnnouncementMeasure {
  jobs: Array<{ id: string; agentId: string; resultChars: number }>;
  records: AnnouncementRecord[];
  sameness: Sameness;
}

/**
 * Rejoue `runs` fois l'annonce de chacun des jobs `jobIds`. `announce` : la
 * génération ; par défaut celle du runner, sans traceur (rien n'est écrit en
 * base).
 */
export async function measureJobAnnouncements(
  db: AnyDrizzleDb,
  opts: {
    jobIds: readonly string[];
    runs: number;
    announce?: (db: AnyDrizzleDb, jobId: string) => Promise<JobAnnouncement>;
    onRecord?: (r: AnnouncementRecord) => void;
  },
): Promise<AnnouncementMeasure> {
  const announce = opts.announce ?? ((d, id) => writeJobAnnouncement(d, id, { observe: null }));
  const jobs: AnnouncementMeasure['jobs'] = [];
  const records: AnnouncementRecord[] = [];
  for (const jobId of opts.jobIds) {
    const [job] = await db
      .select({ agentId: agentJobs.agentId, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .limit(1);
    if (!job?.agentId) throw new Error(`no job ${jobId} with an agent`);
    const result = job.result ?? '';
    jobs.push({ id: jobId, agentId: job.agentId, resultChars: result.length });
    for (let run = 1; run <= opts.runs; run++) {
      const startedAt = Date.now();
      let out: JobAnnouncement;
      try {
        out = await announce(db, jobId);
      } catch (err) {
        out = {
          ok: false,
          code: 'announcement_threw',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      const r = recordAnnouncement(jobId, run, out, Date.now() - startedAt, result);
      records.push(r);
      opts.onRecord?.(r);
    }
  }
  return { jobs, records, sameness: sameness(records) };
}

/** Le résumé d'un job : combien d'annonces sur combien font chaque chose. */
export function summarizeAnnouncements(records: readonly AnnouncementRecord[]): string {
  const ok = records.filter((r) => r.text !== null);
  const count = (f: (r: AnnouncementRecord) => boolean) => `${ok.filter(f).length}/${ok.length}`;
  const words = ok.map((r) => r.words).sort((a, b) => a - b);
  return [
    `written ${ok.length}/${records.length}` +
      (records.length > ok.length
        ? ` (failed: ${records
            .filter((r) => r.text === null)
            .map((r) => r.code)
            .join(', ')})`
        : ''),
    `words ${words.join(', ') || '-'} (median ${words[Math.floor(words.length / 2)] ?? '-'})`,
    `reads the result (a 4+ word phrase of it) ${count((r) => r.sharedPhrase !== null)}`,
    `repeats numbers of the result ${count((r) => r.numbersFromResult.length > 0)}`,
    `says a number (digits or words) ${count((r) => r.numbers.length > 0)}`,
    `names a channel ${count((r) => r.channelNames.length > 0)}`,
    `says where to read it ${count((r) => r.whereToRead.length > 0)}`,
    `markdown ${count((r) => r.markdown)}, url ${count((r) => r.url)}`,
  ].join('\n');
}

/** Le résumé de ce qui se répète. */
export function summarizeSameness(s: Sameness): string {
  const lines = [
    `sentences repeated across runs of one job: ${s.withinJobs.length}`,
    ...s.withinJobs.map((w) => `  ${w.jobId.slice(0, 8)} ×${w.runs}: "${w.sentence}"`),
    `sentences repeated across jobs: ${s.acrossJobs.length}`,
    ...s.acrossJobs.map((a) => `  ${a.jobs.map((j) => j.slice(0, 8)).join(', ')}: "${a.sentence}"`),
  ];
  return lines.join('\n');
}
