// reviewer-runs.ts — les vérifications D'UN RELECTEUR, enregistrées comme des
// preuves du travail qu'il a relu (issue #59, brique P13 du plan « Vérifier &
// Corriger »).
//
// CE QUI A ÉTÉ OBSERVÉ. Sur le run 20b73ed1 (16/09/2026), un relecteur a lancé
// six scénarios Playwright réels sur l'application livrée — de très loin la
// preuve la plus solide du run. `verification_runs` portait ZÉRO ligne pour ce
// job. La seule preuve que le système retenait était le `new Function()` du
// développeur, qui dit que le JavaScript se parse : la plus faible des deux, et
// la seule qui comptait. Ce n'était pas un bug — `review_verdict` n'écrit rien
// par conception — mais un chaînon qui n'existait pas.
//
// CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT PAS. Quand un relecteur enregistre
// son verdict, les commandes que SON job a réellement exécutées sont recopiées
// dans `verification_runs` sous le job RELU. Rien n'est inventé : chaque ligne
// vient d'une ligne `tool_calls` qui porte la commande, son code de sortie et
// sa sortie. Une commande qui n'a pas tourné — refusée, bloquée, en attente
// d'approbation — n'entre pas : sa sortie n'a pas la forme d'un processus
// terminé, et le lecteur ci-dessous la laisse passer son chemin.
//
// Ce module ne JUGE rien. Une commande rouge lancée par un relecteur s'écrit
// rouge ; c'est la section Verification de la page de run qui la montre, et le
// blocage de « livré » se décide ailleurs, sur le verdict lui-même.

import {
  agentJobs,
  toolCalls,
  verificationRuns,
  and,
  asc,
  eq,
  inArray,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import { redactSecretsInText } from '@nodal-agents/shared';
import type { RunVerdict } from '@nodal-agents/shared';
import { randomUUID } from 'node:crypto';

/** Journalisé quand l'enregistrement échoue — best-effort, jamais fatal, jamais muet. */
export const REVIEWER_VERIFY_PERSISTENCE_FAILED = 'REVIEWER_VERIFY_PERSISTENCE_FAILED';

/**
 * Le job relu n'appartient pas à l'entité du relecteur — ou son entité ne se
 * lit pas (Reviewer C, mineur 1).
 *
 * Aucune ligne n'est écrite. Une ligne porterait alors l'`entity_id` du
 * relecteur sous le `job_id` d'un autre espace : aucun écran ne la montrerait
 * — tous filtrent par l'entité de la session — mais elle existerait, et une
 * trace qu'on ne peut rattacher à personne n'est pas une preuve. Le cas ne se
 * produit pas aujourd'hui (une délégation reste dans son espace) ; rien dans ce
 * module ne le rendait impossible, et c'est ce trou-là qui est fermé.
 */
export const REVIEWER_VERIFY_ENTITY_MISMATCH = 'REVIEWER_VERIFY_ENTITY_MISMATCH';

/** Le job relu a disparu entre la délégation et le verdict — rien à rattacher. */
export const REVIEWER_VERIFY_ANCHOR_NOT_FOUND = 'REVIEWER_VERIFY_ANCHOR_NOT_FOUND';

/** La valeur de `verification_runs.source` que ce module écrit (migration 0115). */
export const REVIEWER_SOURCE = 'reviewer' as const;

/**
 * Les outils qui LANCENT un processus et rendent son code de sortie.
 *
 * Deux, et nommés : `run_command` (une commande shell — c'est par lui que
 * passent `npx playwright test`, `pnpm test`, `node --check`) et
 * `run_skill_script` (un script livré par une skill). Un outil qui écrit un
 * fichier ou lit une page n'est pas une vérification : l'inscrire ferait
 * passer pour une preuve ce qui n'en est pas une.
 *
 * `code_task` n'y est pas : il délègue à un CLI de code qui a son propre
 * journal (`cli_runs`, lignes `cli:*`), et son « code de sortie » est celui de
 * la session, pas d'une commande vérifiable.
 */
export const COMMAND_TOOL_NAMES = ['run_command', 'run_skill_script'] as const;

/**
 * Plafond de queue par flux, en caractères — le même que la preuve du job
 * (`MAX_TAIL_CHARS` de code-project.ts). La sortie d'un `tool_calls` est déjà
 * bornée par le moteur de shell ; ce plafond-ci borne ce que la TABLE garde.
 */
export const MAX_TAIL_CHARS = 16_384;

/** Une ligne `tool_calls` telle que ce module la lit. */
export interface ReviewerCommandCall {
  toolName: string;
  toolInput: unknown;
  toolOutput: string | null;
  durationMs: number | null;
}

/** Ce qu'une ligne `tool_calls` donne à écrire dans `verification_runs`. */
export interface ReviewerVerificationRecord {
  command: string;
  exitCode: number | null;
  outcomeKind: 'exit' | 'timeout' | 'spawn_error';
  stdoutTail: string | null;
  stderrTail: string | null;
  durationMs: number | null;
  verdict: RunVerdict;
}

function tail(text: unknown): string | null {
  if (typeof text !== 'string' || text === '') return null;
  const bounded = text.length > MAX_TAIL_CHARS ? text.slice(-MAX_TAIL_CHARS) : text;
  return redactSecretsInText(bounded);
}

/**
 * La commande, telle qu'elle sera LUE par un humain sur la page de run.
 *
 * Elle vient de l'ENTRÉE de l'appel, déjà masquée à l'écriture de la ligne
 * d'audit (`redactSecretsForAudit`). `null` quand l'entrée ne porte pas de
 * commande lisible : une ligne de preuve sans commande ne prouve rien, on
 * n'en écrit pas.
 */
export function commandTextOf(toolName: string, toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;
  if (toolName === 'run_command') {
    return typeof input['command'] === 'string' && input['command'] !== ''
      ? input['command']
      : null;
  }
  if (toolName === 'run_skill_script') {
    const script = input['script'];
    if (typeof script !== 'string' || script === '') return null;
    const args = Array.isArray(input['args'])
      ? input['args'].filter((a): a is string => typeof a === 'string')
      : [];
    return [script, ...args].join(' ');
  }
  return null;
}

/**
 * La ligne de preuve que porte cet appel d'outil, ou `null`.
 *
 * `null` dans TOUS les cas où l'appel n'a pas fait tourner de processus :
 * sortie absente, sortie non-JSON, sortie d'une issue d'outil (`outcome` :
 * erreur, blocage, attente d'approbation), ou sortie qui n'a pas la forme d'un
 * processus terminé. On ne devine jamais : seule une sortie portant `exitCode`
 * ET `timedOut` est le résultat d'un shell qui a été lancé.
 *
 * Les trois issues du moteur de shell sont reconstruites depuis cette forme,
 * qui les aplatit : `timedOut` ⇒ `timeout` ; `exitCode` nul sans timeout ⇒ le
 * processus n'a pas démarré (`spawn_error`) ; sinon `exit`. Le verdict suit la
 * même règle que la preuve du job : vert sur 0, rouge sur une sortie non nulle,
 * `infra_error` quand la commande n'a pas pu conclure.
 */
export function reviewerVerificationRecord(
  call: ReviewerCommandCall,
): ReviewerVerificationRecord | null {
  const command = commandTextOf(call.toolName, call.toolInput);
  if (command === null) return null;
  if (call.toolOutput === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(call.toolOutput);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const out = parsed as Record<string, unknown>;
  // Une issue d'outil : l'appel a été refusé, bloqué, ou attend une
  // approbation. Rien n'a tourné.
  if ('outcome' in out) return null;
  if (!('exitCode' in out) || typeof out['timedOut'] !== 'boolean') return null;
  const exitCode = out['exitCode'];
  if (exitCode !== null && typeof exitCode !== 'number') return null;

  const timedOut = out['timedOut'];
  const outcomeKind: 'exit' | 'timeout' | 'spawn_error' = timedOut
    ? 'timeout'
    : exitCode === null
      ? 'spawn_error'
      : 'exit';
  const verdict: RunVerdict =
    outcomeKind === 'exit' && exitCode === 0
      ? 'green'
      : outcomeKind === 'exit'
        ? 'red'
        : 'infra_error';

  return {
    command,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    outcomeKind,
    stdoutTail: tail(out['stdout']),
    stderrTail: tail(out['stderr']),
    durationMs: call.durationMs,
    verdict,
  };
}

/**
 * Le job sous lequel ces preuves se rangent : le PARENT du relecteur.
 *
 * Un relecteur est délégué par le travail qu'il relit ; ce travail est son
 * parent, c'est lui dont la page doit montrer ce que la relecture a éprouvé, et
 * c'est lui dont la livraison en dépend. Sans parent — un job de revue lancé
 * seul, par un cron ou par une personne — la preuve reste sous le job qui l'a
 * lancée : elle est alors déjà à sa place, et l'inventer un ancrage ailleurs
 * serait deviner.
 */
export function anchorJobId(reviewerJobId: string, parentJobId: string | null): string {
  return parentJobId ?? reviewerJobId;
}

/**
 * La clé canonique sous laquelle ces commandes se rangent.
 *
 * `review:<job du relecteur>` : une identité, pas une devinette. Les commandes
 * d'un relecteur ne prouvent pas UN livrable nommé — elles prouvent CETTE
 * relecture, et deux relectures du même travail restent deux preuves
 * distinctes, comme deux séquences de preuve du job le sont déjà.
 */
export function reviewCanonicalKey(reviewerJobId: string): string {
  return `review:${reviewerJobId}`;
}

/** Le type de livrable de ces lignes : aucun des types nommés ne les décrit. */
const REVIEW_DELIVERABLE_TYPE = 'other';

/**
 * Recopie sous le job relu les commandes que CE relecteur a exécutées.
 *
 * Appelée quand un `review_verdict` réussit. Idempotente : les lignes déjà
 * écrites pour ce relecteur sont retirées d'abord, si bien qu'un second verdict
 * (un relecteur qui corrige un appel refusé, puis rappelle l'outil) laisse UNE
 * trace, celle de l'état final de son job — jamais deux fois les mêmes
 * commandes.
 *
 * Rend le nombre de lignes écrites : l'appelant le journalise, et le test le
 * lit sans avoir à rejouer la requête.
 *
 * Lève, AVANT toute écriture, quand le job relu n'est pas de l'entité du
 * relecteur (Reviewer C, mineur 1). L'appelant attrape et journalise le code :
 * l'observabilité ne fait jamais échouer un travail, mais un refus ne se tait
 * pas (invariant #4).
 */
export async function recordReviewerVerificationRuns(
  db: AnyDrizzleDb,
  reviewerJobId: string,
): Promise<number> {
  const jobRows = await db
    .select({
      entityId: agentJobs.entityId,
      parentJobId: agentJobs.parentJobId,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, reviewerJobId))
    .limit(1);
  const job = jobRows[0];
  if (!job) return 0;

  const anchor = anchorJobId(reviewerJobId, job.parentJobId);
  // L'ancrage traverse une frontière d'espace ? On le VÉRIFIE plutôt que de
  // s'en remettre au fait qu'une délégation reste dans son espace. Rien ici ne
  // le garantissait : `parent_job_id` est un identifiant, pas une promesse.
  // Fermé avant la suppression comme avant l'insertion — un refus ne doit pas
  // effacer la trace d'une relecture précédente au passage.
  if (anchor !== reviewerJobId) {
    const anchorRows = await db
      .select({ entityId: agentJobs.entityId })
      .from(agentJobs)
      .where(eq(agentJobs.id, anchor))
      .limit(1);
    const anchorJob = anchorRows[0];
    if (!anchorJob) {
      throw new Error(`${REVIEWER_VERIFY_ANCHOR_NOT_FOUND}: reviewer ${reviewerJobId} → ${anchor}`);
    }
    // Deux entités NULLES ne prouvent pas la même entité : une ligne qu'on ne
    // peut rattacher à personne n'est pas une preuve, elle est un déchet.
    if (
      job.entityId === null ||
      anchorJob.entityId === null ||
      anchorJob.entityId !== job.entityId
    ) {
      throw new Error(
        `${REVIEWER_VERIFY_ENTITY_MISMATCH}: reviewer ${reviewerJobId} (entity ${job.entityId}) → ` +
          `job ${anchor} (entity ${anchorJob.entityId})`,
      );
    }
  }

  const calls = await db
    .select({
      toolName: toolCalls.toolName,
      toolInput: toolCalls.toolInput,
      toolOutput: toolCalls.toolOutput,
      durationMs: toolCalls.durationMs,
    })
    .from(toolCalls)
    .where(
      and(eq(toolCalls.jobId, reviewerJobId), inArray(toolCalls.toolName, [...COMMAND_TOOL_NAMES])),
    )
    // `seq` est l'ordre d'ÉCRITURE (migration 0110) : deux commandes d'un même
    // tour portent le même `turn` et souvent le même `created_at`. Le rang
    // affiché doit être celui dans lequel le relecteur les a lancées.
    .orderBy(asc(toolCalls.seq));

  const records = calls
    .map((call) => reviewerVerificationRecord(call))
    .filter((r): r is ReviewerVerificationRecord => r !== null);

  // La réécriture, toujours : un relecteur dont toutes les commandes ont
  // disparu (cas qui n'existe pas aujourd'hui, mais qui ne doit pas laisser
  // une trace périmée) voit sa trace retirée, pas conservée.
  await db.delete(verificationRuns).where(eq(verificationRuns.sourceJobId, reviewerJobId));
  if (records.length === 0) return 0;

  const sequenceId = randomUUID();
  await db.insert(verificationRuns).values(
    records.map((r, i) => ({
      jobId: anchor,
      entityId: job.entityId,
      deliverableType: REVIEW_DELIVERABLE_TYPE,
      canonicalKey: reviewCanonicalKey(reviewerJobId),
      sequenceId,
      commandRank: i + 1,
      command: r.command,
      exitCode: r.exitCode,
      outcomeKind: r.outcomeKind,
      stdoutTail: r.stdoutTail,
      stderrTail: r.stderrTail,
      durationMs: r.durationMs,
      verdict: r.verdict,
      source: REVIEWER_SOURCE,
      sourceJobId: reviewerJobId,
    })),
  );
  return records.length;
}
