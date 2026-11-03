// architecture.test.ts — invariants du produit, appliqués mécaniquement.
//
// Les scanners vivent dans @nodal-agents/test-kit : ils étaient auparavant
// recopiés dans 15 fichiers `architecture.test.ts`, chacun portant sa propre
// liste de slugs et son propre marcheur de répertoires. Quinze copies, c'est
// quinze endroits à mettre à jour au renommage d'un agent — et quinze chances
// qu'une devienne plus laxiste que les autres sans que personne ne relise celles
// qui passent.
//
// Ce fichier reste le point d'application POUR CE PACKAGE ; seule la mécanique
// est partagée.

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForUserFacingStrings,
  scanForDbDriverImports,
  scanForProjectKeyCopies,
  scanForMutatingSpawnOutsideIntent,
  scanForDirectTerminalCompleted,
  scanForCompleteJobCallers,
  scanForMultilinePattern,
  scanForPattern,
  scanForTerminalSendOutsideOutbox,
  RUNNER_NON_TERMINAL_SENDERS,
  scanFilesForDeliverableTypeLiterals,
  formatViolations,
} from '@nodal-agents/test-kit';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('invariant 1 — aucune métadonnée d’agent en dur', () => {
  it('src/ ne contient aucun slug d’agent connu', () => {
    const violations = scanForAgentSlugs({ srcDir: SRC_DIR });
    if (violations.length > 0) {
      expect.fail(formatViolations('Invariant 1 violé', violations));
    }
  });
});

describe('invariant 2 — aucun texte utilisateur en dur dans le runner', () => {
  it('src/ ne met aucune phrase dans la bouche de l’agent', () => {
    const violations = scanForUserFacingStrings({ srcDir: SRC_DIR });
    if (violations.length > 0) {
      expect.fail(formatViolations('Invariant 2 violé', violations));
    }
  });
});

describe('architecture — le runner n’importe aucun driver de base', () => {
  it('src/ passe exclusivement par @nodal-agents/db', () => {
    const violations = scanForDbDriverImports({ srcDir: SRC_DIR });
    if (violations.length > 0) {
      expect.fail(formatViolations('Import de driver hors packages/db', violations));
    }
  });
});

describe('architecture — la clé d’identité d’un chemin n’a qu’une source', () => {
  it('src/ ne recopie pas la règle « lettre de lecteur » de @nodal-agents/shared', () => {
    const violations = scanForProjectKeyCopies({ srcDir: SRC_DIR });
    if (violations.length > 0) {
      expect.fail(formatViolations('Copie de projectKey hors packages/shared', violations));
    }
  });
});

/**
 * Les deux SEULS points d'où un runtime CLI part écrire dans un workspace.
 * Ils posent l'intention de mutation avant de lancer le binding ; un troisième
 * appel ailleurs écrirait hors vérification sans que rien ne rougisse.
 */
const CLI_RUNTIME_LAUNCHERS = ['cli-runtime/run-job.ts', 'cli-runtime/run-chat.ts'] as const;

// ─── Plan « Vérifier & Corriger », T13 : une porte terminale, une sortie ────

/**
 * Les deux SEULS fichiers qui écrivent le statut terminal de succès : la
 * primitive, et l'écriture interne qu'elle appelle. Tout autre `.update(
 * agentJobs)` posant `status: 'completed'` contournerait la décision de
 * vérification ET l'outbox sans qu'un test de comportement rougisse.
 */
const TERMINAL_WRITERS = ['job/finalize.ts', 'job/state.ts'] as const;

/**
 * Les envois de canal NON terminaux — une allowlist explicite, dont la
 * longueur est ce qu'on surveille : une demande d'approbation, une transition
 * de l'onglet Code, le rappel d'un cron, le reset des orphelins, le poller.
 * Le résultat terminal d'un job, lui, ne part que par l'outbox.
 */
const NON_TERMINAL_SENDERS = RUNNER_NON_TERMINAL_SENDERS;

describe('architecture — une seule porte terminale de succès (V&C T13)', () => {
  it('src/ ne pose status=completed sur agent_jobs que dans la primitive et son écriture interne', () => {
    const violations = scanForDirectTerminalCompleted({
      srcDir: SRC_DIR,
      skipFiles: TERMINAL_WRITERS,
    });
    if (violations.length > 0) {
      expect.fail(formatViolations('Écriture terminale directe hors de la primitive', violations));
    }
  });

  it('completeJob n’a aucun appelant hors de la primitive (c’est son écriture interne)', () => {
    const violations = scanForCompleteJobCallers({ srcDir: SRC_DIR, skipFiles: TERMINAL_WRITERS });
    if (violations.length > 0) {
      expect.fail(formatViolations('Appel de completeJob hors de la primitive', violations));
    }
  });

  it('src/ n’envoie un résultat terminal que par l’outbox — les autres envois sont sur allowlist', () => {
    const violations = scanForTerminalSendOutsideOutbox({
      srcDir: SRC_DIR,
      skipFiles: NON_TERMINAL_SENDERS,
    });
    if (violations.length > 0) {
      expect.fail(formatViolations('Envoi de canal hors de l’outbox', violations));
    }
  });

  it('la primitive ne mentionne aucun type de livrable — elle n’appelle que le registre', () => {
    const violations = scanFilesForDeliverableTypeLiterals([join(SRC_DIR, 'job', 'finalize.ts')]);
    if (violations.length > 0) {
      expect.fail(formatViolations('Type de livrable en dur dans la primitive', violations));
    }
  });
});

describe('architecture — le runtime CLI ne part écrire que du seam d’intention', () => {
  it('src/ ne lance un binding CLI que depuis run-job.ts et run-chat.ts', () => {
    const violations = scanForMutatingSpawnOutsideIntent(
      { srcDir: SRC_DIR, skipFiles: CLI_RUNTIME_LAUNCHERS },
      /binding\.run\(/,
    );
    if (violations.length > 0) {
      expect.fail(
        formatViolations(
          'Lancement de binding CLI hors des deux points qui posent l’intention',
          violations,
        ),
      );
    }
  });
});

// ─── #944 : une porte par transition ──────────────────────────────────────────
//
// Deux transitions se poussent aux clients (`GET /api/events`) : (a) un job
// atteint un statut terminal, (b) une demande quitte `pending`. Chacune ne
// s'écrit que par une PORTE, qui écrit sous sa garde et annonce ce qui a
// atterri (`announceTransitions`, packages/db/src/repos/transitions.ts) ; le
// runner pousse l'annonce après le COMMIT. Une écriture ailleurs serait une
// transition qu'aucun client n'apprend — l'oubli que la revue de #956 a trouvé
// deux fois (l'arrêt d'un arbre, la cascade vers le parent).

const REPO = resolve(SRC_DIR, '../../..');

/**
 * Tout le code qui écrit la base, dans tous les processus. `test-kit` est
 * laissé de côté : il ne tourne nulle part, et ses commentaires citent les
 * motifs mêmes qu'on cherche.
 */
const WRITER_ROOTS = [
  ...readdirSync(join(REPO, 'apps'))
    .map((a) => `apps/${a}/src`)
    .filter((r) => existsSync(join(REPO, r))),
  ...readdirSync(join(REPO, 'packages'))
    .filter((p) => p !== 'test-kit')
    .map((p) => `packages/${p}/src`)
    .filter((r) => existsSync(join(REPO, r))),
];

/** (a) — `.update(agentJobs).set({ … status: <terminal> … })`, avant son WHERE. */
const JOB_TERMINAL_WRITE =
  /\.update\(agentJobs\)\s*\.set\(\{(?:(?!\.where\()[\s\S]){0,600}?\bstatus:\s*(?:'completed'|'failed'|'cancelled'|[a-zA-Z]+Status\b)/;
/**
 * (a), forme abrégée — `.set({ status, … })` : la valeur vient d'une variable,
 * et rien ne dit au motif ci-dessus qu'elle n'est pas terminale (la cascade d'un
 * délégué en ligne y est passée, revue de #956 passe 2). Hors d'une porte, elle
 * est refusée. Le vrai garde est le TYPE : `setJobStatus` (state.ts, fichier de
 * porte) n'accepte qu'un `NonTerminalJobStatus` (`set-job-status-type.test.ts`).
 */
const JOB_STATUS_SHORTHAND_WRITE =
  /\.update\(agentJobs\)\s*\.set\(\{(?:(?!\.where\()[\s\S]){0,600}?[{,]\s*status\s*[,}]/;
/** (b) — `.update(approvalRequests).set({ … status … })` : toute écriture du statut d'une demande la fait quitter `pending`. */
const REQUEST_SETTLE_WRITE =
  /\.update\(approvalRequests\)\s*\.set\(\{(?:(?!\.where\()[\s\S]){0,600}?\bstatus:/;

/** Les portes. Chaque fichier y écrit, et annonce chaque écriture. */
const JOB_DOORS = ['packages/db/src/repos/transitions.ts', 'apps/runner/src/job/state.ts'];
const REQUEST_DOORS = ['packages/db/src/repos/transitions.ts'];

/** Les fonctions qui passent une porte, et que l'on appelle pour arrêter ou trancher. */
const DOOR_CALL =
  /\b(?:cancelJobTree|stopRuns|stopConversationRuns|cancelJobs|expirePendingRequests|decidePendingRequest)\(/;

/** Le code qui tourne DANS le processus du runner, où l'écouteur est branché (`createApp`). */
const IN_RUNNER_ROOTS = [
  'apps/runner/src',
  'packages/db/src',
  'packages/orchestration/src',
  'packages/tools/src',
];

/**
 * Les écrivains qui passent une porte HORS du processus du runner : leur
 * annonce ne trouve aucun écouteur, et aucun client ne l'apprend. Chacun est
 * nommé, avec ce qui le fera disparaître ; une entrée qui ne passe plus aucune
 * porte est refusée aussi (la liste ne vieillit pas en silence).
 */
const OUT_OF_PROCESS_WRITERS: Record<string, string> = {
  'apps/web/src/lib/actions.ts':
    'cancelJobAction : le bouton Stop du tableau de bord appelle cancelJobTree depuis le processus du web. #955 le fait passer par une route du runner, et retire cette entrée.',
  'packages/bench/src/workflows/stack.ts':
    "le banc d'essai annule l'arbre d'un scénario depuis son propre processus, pour mesurer l'arrêt ; aucun client n'écoute le banc.",
};

/** Un test posé à côté de son code (`*.test.ts`) écrit ses fixtures : il ne tourne dans aucun processus. */
const isTestFile = (file: string): boolean => /\.test\.tsx?$/.test(file);

function scanRoots(pattern: RegExp, rule: string) {
  return WRITER_ROOTS.flatMap((root) =>
    scanForMultilinePattern({ srcDir: join(REPO, root) }, { pattern, rule }),
  ).filter((v) => !isTestFile(v.file));
}

const rel = (file: string): string =>
  file
    .split('\\')
    .join('/')
    .slice(REPO.split('\\').join('/').length + 1);

describe('architecture — une porte par transition poussée (#944) @cap:suivre-execution/moteur', () => {
  it('un job ne passe à un statut terminal que par une porte', () => {
    const outside = [
      ...scanRoots(JOB_TERMINAL_WRITE, 'job-terminal-write-outside-door'),
      ...scanRoots(JOB_STATUS_SHORTHAND_WRITE, 'job-status-shorthand-outside-door'),
    ].filter((v) => !JOB_DOORS.includes(rel(v.file)));
    if (outside.length > 0) {
      expect.fail(formatViolations('Statut terminal de job écrit hors d’une porte', outside));
    }
  });

  it('une demande ne quitte `pending` que par une porte', () => {
    const outside = scanRoots(REQUEST_SETTLE_WRITE, 'request-settle-outside-door').filter(
      (v) => !REQUEST_DOORS.includes(rel(v.file)),
    );
    if (outside.length > 0) {
      expect.fail(formatViolations('Demande tranchée ou expirée hors d’une porte', outside));
    }
  });

  it('chaque porte annonce chacune de ses écritures', () => {
    for (const door of new Set([...JOB_DOORS, ...REQUEST_DOORS])) {
      const src = readFileSync(join(REPO, door), 'utf-8');
      const writes =
        [...src.matchAll(new RegExp(JOB_TERMINAL_WRITE.source, 'g'))].length +
        [...src.matchAll(new RegExp(REQUEST_SETTLE_WRITE.source, 'g'))].length;
      const announces = [...src.matchAll(/await announceTransitions\(/g)].length;
      expect(writes, door).toBeGreaterThan(0);
      expect(announces, door).toBeGreaterThanOrEqual(writes);
    }
  });

  it('hors du runner, seuls les écrivains nommés passent une porte', () => {
    const calls = WRITER_ROOTS.filter((r) => !IN_RUNNER_ROOTS.includes(r))
      .flatMap((root) =>
        scanForPattern({ srcDir: join(REPO, root) }, { pattern: DOOR_CALL, rule: 'door-call' }),
      )
      .filter((v) => !isTestFile(v.file));
    const unnamed = calls.filter((v) => !(rel(v.file) in OUT_OF_PROCESS_WRITERS));
    if (unnamed.length > 0) {
      expect.fail(formatViolations('Porte passée hors du processus du runner', unnamed));
    }
    const used = new Set(calls.map((v) => rel(v.file)));
    expect(Object.keys(OUT_OF_PROCESS_WRITERS).filter((f) => !used.has(f))).toEqual([]);
  });
});
