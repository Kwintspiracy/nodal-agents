// verification-runs-query.ts — LA lecture des lignes `verification_runs`, une
// fois pour les quatre écrans qui les montrent.
//
// Elle existe parce que ces colonnes étaient recopiées dans quatre `select`
// (la page d'un run, le fil d'une conversation, le détail Code, la page d'un
// projet). Le jour où la table a gagné l'origine d'une preuve (#59), les quatre
// devaient gagner la même jointure — et un écran oublié aurait montré les
// commandes d'un relecteur comme si le job les avait lancées lui-même.
//
// La jointure sur `source_job_id` remonte au job qui a EXÉCUTÉ la commande,
// puis à son agent, pour que l'écran puisse NOMMER d'où vient la preuve. Deux
// jointures à gauche : une ligne dont l'exécutant est le job lui-même
// (`source = 'job'`, `source_job_id` nul) sort avec un nom nul, elle n'est
// jamais perdue.

import 'server-only';
import { agentJobs, agents, eq, verificationRuns } from '@nodal-agents/db';
import type { getDb } from './server.ts';

type Db = ReturnType<typeof getDb>;

/**
 * Le `select` des preuves, jointures comprises. L'appelant ajoute son `where`
 * (et son `orderBy`) : c'est la seule chose qui diffère d'un écran à l'autre.
 */
export function selectVerificationRuns(db: Db) {
  return db
    .select({
      jobId: verificationRuns.jobId,
      deliverableType: verificationRuns.deliverableType,
      canonicalKey: verificationRuns.canonicalKey,
      sequenceId: verificationRuns.sequenceId,
      commandRank: verificationRuns.commandRank,
      command: verificationRuns.command,
      exitCode: verificationRuns.exitCode,
      outcomeKind: verificationRuns.outcomeKind,
      durationMs: verificationRuns.durationMs,
      verdict: verificationRuns.verdict,
      testedGeneration: verificationRuns.testedGeneration,
      testedEpoch: verificationRuns.testedEpoch,
      createdAt: verificationRuns.createdAt,
      source: verificationRuns.source,
      sourceAgentName: agents.name,
    })
    .from(verificationRuns)
    .leftJoin(agentJobs, eq(agentJobs.id, verificationRuns.sourceJobId))
    .leftJoin(agents, eq(agents.id, agentJobs.agentId));
}
