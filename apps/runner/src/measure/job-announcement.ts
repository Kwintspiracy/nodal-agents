// measure/job-announcement.ts — rejouer l'annonce dite d'un job fini, et la relever (#967).
//
// L'annonce est la génération que le runner fait quand un job lancé par la
// voix finit (`writeJobAnnouncement`, chat/job-announcement.ts) : la MÊME
// fonction, sur la ligne réelle d'un job (sa demande, son résultat, son agent,
// ses canaux), autant de fois qu'on le demande. Chaque annonce est relevée sur
// ce que le propriétaire a fixé (04/11) : ses mots, ses phrases, si elle LIT
// le résultat au lieu de l'annoncer, si elle dit où le lire, si elle propose
// un canal, et si elle porte une adresse web ou du markdown.
//
// CE QU'ELLE ÉCRIT DANS LA BASE : rien. `writeJobAnnouncement` ne fait que lire
// (le job, l'agent, ses liaisons, sa clé) ; l'annonce n'est pas rangée, et
// aucun traceur d'appel n'est branché (`observe: null`). Les appels au modèle
// sont réels, et facturés sur la clé de l'agent.

import { splitSentences } from '@nodal-agents/speech';
import { redactSecretsInText } from '@nodal-agents/shared';
import { agentJobs, eq, type AnyDrizzleDb } from '@nodal-agents/db';
import { reachableChannels } from '@nodal-agents/orchestration';
import { writeJobAnnouncement, type JobAnnouncement } from '../chat/job-announcement.ts';

export interface AnnouncementRecord {
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
  /** La plus longue suite d'au moins 5 mots reprise telle quelle du résultat, ou null. */
  sharedPhrase: string | null;
  /** Les nombres du résultat (3 chiffres et plus) que l'annonce répète. */
  numbersFromResult: string[];
  /** L'annonce dit où lire le résultat (« Nodal »). */
  saysWhere: boolean;
  /** Les canaux joignables que l'annonce nomme. */
  offersChannels: string[];
}

const MARKDOWN = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s)|\*\*|__|`/;
const URL = /https?:\/\/|www\./i;

function normalisedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** La plus longue suite de mots (≥ `min`) de `text` qui figure dans `source`. */
export function longestSharedPhrase(text: string, source: string, min = 5): string | null {
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
  run: number,
  out: JobAnnouncement,
  ms: number,
  result: string,
  channels: readonly string[],
): AnnouncementRecord {
  if (!out.ok) {
    return {
      run,
      text: null,
      code: out.code,
      detail: out.detail ? redactSecretsInText(out.detail) : null,
      ms,
      words: 0,
      sentences: 0,
      markdown: false,
      url: false,
      sharedPhrase: null,
      numbersFromResult: [],
      saysWhere: false,
      offersChannels: [],
    };
  }
  const text = out.text;
  const resultNumbers = new Set(numbersOf(result));
  return {
    run,
    text,
    code: null,
    detail: null,
    ms,
    words: text.split(/\s+/).filter((w) => w !== '').length,
    sentences: splitSentences(text).length,
    markdown: MARKDOWN.test(text),
    url: URL.test(text),
    sharedPhrase: longestSharedPhrase(text, result),
    numbersFromResult: numbersOf(text).filter((n) => resultNumbers.has(n)),
    saysWhere: /\bnodal\b/i.test(text),
    offersChannels: channels.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(text)),
  };
}

export interface AnnouncementMeasure {
  job: { id: string; agentId: string; resultChars: number; channels: string[] };
  records: AnnouncementRecord[];
}

/**
 * Rejoue `runs` fois l'annonce du job `jobId`. `announce` : la génération ; par
 * défaut celle du runner, sans traceur (rien n'est écrit en base).
 */
export async function measureJobAnnouncement(
  db: AnyDrizzleDb,
  opts: {
    jobId: string;
    runs: number;
    announce?: (db: AnyDrizzleDb, jobId: string) => Promise<JobAnnouncement>;
    onRecord?: (r: AnnouncementRecord) => void;
  },
): Promise<AnnouncementMeasure> {
  const [job] = await db
    .select({ agentId: agentJobs.agentId, result: agentJobs.result })
    .from(agentJobs)
    .where(eq(agentJobs.id, opts.jobId))
    .limit(1);
  if (!job?.agentId) throw new Error(`no job ${opts.jobId} with an agent`);
  const result = job.result ?? '';
  const channels = await reachableChannels(db, job.agentId);
  const announce = opts.announce ?? ((d, id) => writeJobAnnouncement(d, id, { observe: null }));
  const records: AnnouncementRecord[] = [];
  for (let run = 1; run <= opts.runs; run++) {
    const startedAt = Date.now();
    let out: JobAnnouncement;
    try {
      out = await announce(db, opts.jobId);
    } catch (err) {
      out = {
        ok: false,
        code: 'announcement_threw',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const r = recordAnnouncement(run, out, Date.now() - startedAt, result, channels);
    records.push(r);
    opts.onRecord?.(r);
  }
  return {
    job: { id: opts.jobId, agentId: job.agentId, resultChars: result.length, channels },
    records,
  };
}

/** Le résumé : combien d'annonces sur combien font chaque chose. */
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
    `reads the result (a 5+ word phrase of it) ${count((r) => r.sharedPhrase !== null)}`,
    `repeats numbers of the result ${count((r) => r.numbersFromResult.length > 0)}`,
    `says where to read it ${count((r) => r.saysWhere)}`,
    `offers a channel ${count((r) => r.offersChannels.length > 0)}`,
    `markdown ${count((r) => r.markdown)}, url ${count((r) => r.url)}`,
  ].join('\n');
}
