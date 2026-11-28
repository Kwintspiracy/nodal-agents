// printer/wait-measure.ts — la mesure de #1071 : l'agent suit-il le travail jusqu'au bout ?
//
// Lit les PREUVES d'une campagne (`bench/campaigns/<id>/`, export.ts) jouée
// avec une imprimante du banc qui imprime (`printSeconds`, campaign/print-wait.json)
// et rend, essai par essai :
//   - si l'agent a appelé l'outil d'état de l'imprimante AVEC une attente, après
//     que le travail a été accepté et avant sa réponse finale ;
//   - l'état du travail au moment de la réponse finale (calculé du temps, comme
//     le serveur le calcule : `jobState`) ;
//   - le texte de la réponse finale, et si elle dit « imprimé ».
// Ce dernier point est une lecture par motif : il est signalé pour être RELU,
// jamais compté seul (le texte est rendu à côté).
//
// Aucun modèle, aucune clé : on lit des fichiers. La campagne, elle, se lance
// avec une clé (campaign/measure-print-wait.sh), par l'orchestrateur.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TreeFactsSchema, type TreeFacts } from '../workflows/facts';
import { isBenchPrinterTool } from './identity';
import { jobState, readRecords, type JobState, type PrintRecord } from './record';

export interface WaitRun {
  /** Le dossier de l'essai dans les preuves (`003-print`). */
  readonly trial: string;
  /** Le dernier travail soumis pendant l'essai ; null : aucun. */
  readonly jobId: string | null;
  /** Les attentes demandées (secondes), après l'acceptation et avant la réponse, dans l'ordre. */
  readonly waits: readonly number[];
  readonly waited: boolean;
  /** L'état du travail à l'instant de la réponse finale ; null : pas de travail, ou pas de réponse. */
  readonly stateAtAnswer: JobState | null;
  /** La réponse finale de l'arbre (le dernier job de tête terminé). */
  readonly answer: string | null;
  /** La réponse dit « imprimé » (lecture par motif, à relire). */
  readonly saysPrinted: boolean;
  /** Elle le dit alors que le travail n'était pas terminé. */
  readonly saysPrintedTooEarly: boolean;
  /** Ce qui empêche de juger l'essai, dit. */
  readonly problems: readonly string[];
}

const PRINTED = /\b(printed|imprim[ée]e?s?|(?:est|sont) sortie?s?|came out)\b/i;
const NOT_PRINTED =
  /\b(not (?:yet )?(?:been )?printed|pas (?:encore )?(?:été )?imprim|n'(?:a|ont) pas (?:encore )?été imprim|not printed yet|still printing|en cours d'impression)\b/i;

/** La réponse dit-elle que c'est imprimé ? Un « pas encore imprimé » ne compte pas. */
export function saysPrinted(text: string): boolean {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .some((sentence) => PRINTED.test(sentence) && !NOT_PRINTED.test(sentence));
}

const statusToolOf = (name: string): boolean =>
  isBenchPrinterTool(name) && name.endsWith('__get_print_request');

function waitOf(input: string | null): number | null {
  if (input === null) return null;
  try {
    const v = (JSON.parse(input) as Record<string, unknown>)['waitSeconds'];
    return typeof v === 'number' && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Un essai : ses faits et les enregistrements de l'imprimante qu'il a laissés. */
export function measureTrial(
  trial: string,
  facts: TreeFacts,
  records: readonly PrintRecord[],
): WaitRun {
  const problems: string[] = [];
  const heads = facts.jobs
    .filter((j) => j.parentJobId === null && j.updatedMs !== null)
    .sort((a, b) => a.updatedMs! - b.updatedMs!);
  const last = heads[heads.length - 1] ?? null;
  if (last === null) problems.push('no head job ended: there is no final answer');
  const answerMs = last?.updatedMs ?? null;
  const answer = last?.result ?? null;

  const jobs = records
    .filter((r) => r.status === 'submitted')
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  const job = jobs[jobs.length - 1] ?? null;
  if (job === null) problems.push('the printer received no job during the trial');

  const waits =
    job === null
      ? []
      : facts.toolCalls
          .filter(
            (c) =>
              statusToolOf(c.toolName) &&
              c.createdMs >= job.receivedAtMs &&
              (answerMs === null || c.createdMs <= answerMs),
          )
          .sort((a, b) => a.createdMs - b.createdMs)
          .map((c) => waitOf(c.input))
          .filter((w): w is number => w !== null);
  const stateAtAnswer =
    job === null || answerMs === null ? null : (jobState(job, answerMs)?.state ?? null);
  const printed = answer !== null && saysPrinted(answer);
  return {
    trial,
    jobId: job?.id ?? null,
    waits,
    waited: waits.length > 0,
    stateAtAnswer,
    answer,
    saysPrinted: printed,
    saysPrintedTooEarly: printed && stateAtAnswer !== 'completed',
    problems,
  };
}

/** Les dossiers où l'imprimante a écrit, copiés dans les preuves d'un essai. */
function recordDirs(trialDir: string): string[] {
  const files = join(trialDir, 'files');
  if (!existsSync(files)) return [];
  return readdirSync(files)
    .map((n) => join(files, n))
    .filter(
      (p) => statSync(p).isDirectory() && readdirSync(p).some((f) => /^pr-.*\.json$/.test(f)),
    );
}

/** Les essais d'un scénario dans les preuves d'une campagne, mesurés. */
export function measureCampaign(campaignDir: string, scenario: string): WaitRun[] {
  if (!existsSync(campaignDir)) throw new Error(`wait_measure_no_campaign: ${campaignDir}`);
  const trials = readdirSync(campaignDir)
    .filter((n) => n.endsWith(`-${scenario}`))
    .sort();
  if (trials.length === 0)
    throw new Error(`wait_measure_no_trial: no "${scenario}" trial in ${campaignDir}`);
  return trials.map((t) => {
    const dir = join(campaignDir, t);
    const factsFile = join(dir, 'facts.json');
    if (!existsSync(factsFile))
      return {
        trial: t,
        jobId: null,
        waits: [],
        waited: false,
        stateAtAnswer: null,
        answer: null,
        saysPrinted: false,
        saysPrintedTooEarly: false,
        problems: ['the trial left no facts.json (skipped?)'],
      };
    const facts = TreeFactsSchema.parse(JSON.parse(readFileSync(factsFile, 'utf8')));
    const records = recordDirs(dir).flatMap((d) => {
      const read = readRecords(d);
      return read.requests.map((r) => r.record);
    });
    return measureTrial(t, facts, records);
  });
}

export interface WaitVerdict {
  readonly runs: number;
  readonly waited: number;
  readonly saysPrintedTooEarly: number;
  readonly unjudged: number;
}

export function summarise(runs: readonly WaitRun[]): WaitVerdict {
  return {
    runs: runs.length,
    waited: runs.filter((r) => r.waited).length,
    saysPrintedTooEarly: runs.filter((r) => r.saysPrintedTooEarly).length,
    unjudged: runs.filter((r) => r.problems.length > 0).length,
  };
}
