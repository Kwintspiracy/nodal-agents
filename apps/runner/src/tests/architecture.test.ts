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
  scanForOutcomeGuesses,
  assertNoViolations,
  OUTBOUND_BRAND_CAST,
  scanForOutboundBypass,
  scanForToolResultBypass,
  stripComments,
  type OutboundExit,
  scanForGitSpawnOutsideLauncher,
} from '@nodal-agents/test-kit';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Ce qui sort du runner passe par la couture de sortie ───────────────────
//
// Une réponse HTTP : `outboundResponses`, posé sur l'application avant tout le
// reste. Un événement de flux : `sseEvent`, qui ne prend qu'une valeur sortante
// (le compilateur le tient). Un SDK de plateforme atteint directement (les
// sessions Discord, Slack, WhatsApp du runner) : ce scanner.

/** Un SDK de messagerie atteint directement : son texte passe par la couture. */
const RUNNER_SDK_SENDS: readonly OutboundExit[] = [
  {
    rule: 'sdk-send-beside-seam',
    call: /\bchat\s*\.\s*(?:postMessage|postEphemeral|update|scheduleMessage)\s*\(/,
    fields: ['text'],
  },
  {
    rule: 'sdk-send-beside-seam',
    call: /\binteraction\s*\.\s*(?:reply|followUp|update|editReply)\s*\(/,
    fields: ['content'],
  },
];

/** Dans les sessions de canal, tout `.send(` d'un client de plateforme. */
const CHANNEL_SESSION_SENDS: readonly OutboundExit[] = [
  { rule: 'sdk-send-beside-seam', call: /\.\s*send\s*\(/, fields: ['text', 'content', 'caption'] },
];

/** Une trame de flux écrite à la main, hors de `sseEvent`. */
const HAND_WRITTEN_SSE_FRAME: OutboundExit = {
  rule: 'sse-frame-beside-sse-event',
  pattern: /['"`]data: /,
};

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

// ─── Une clé de modèle ne part que vers l'adresse enregistrée pour elle ─────

describe('un client de modèle ne se construit qu’à partir de la clé de l’agent @cap:choisir-modele/moteur', () => {
  // Tous les appels de modèle du runner (boucle de job, chat, titres, relances,
  // curateurs, réflexion) passent par resolveAgentLlmClient, qui construit le
  // client depuis la ligne entity_llm_keys : adresse enregistrée (ou officielle)
  // et clé enregistrée. Un autre site qui construirait son propre client
  // échapperait à cette règle.
  const MODEL_CLIENT_BUILDERS = ['job/resolve-llm.ts'];

  it('createLlmClient / createFailoverLlmClient ne sont appelés que par resolve-llm.ts', () => {
    const violations = scanForPattern(
      { srcDir: SRC_DIR, skipFiles: MODEL_CLIENT_BUILDERS },
      { pattern: /\bcreate(?:Failover)?LlmClient\s*\(/, rule: 'model-client-outside-resolver' },
    ).filter((v) => !/^\s*(\/\/|\*)/.test(v.text));
    if (violations.length > 0) {
      expect.fail(
        formatViolations('Client de modèle construit hors de resolve-llm.ts', violations),
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

// ─── #1180 : un seul écrivain de `failed`, et c'est lui qui prépare la notice ──
//
// Une trentaine de sorties d'échec (la boucle, le runtime CLI, le tableau, les
// faucheurs) ; seules quelques-unes prévenaient la personne, chacune à sa façon.
// La règle : `failed` s'écrit à UN endroit (`writeFailure`, job/state.ts, sous
// `failJob`), et cet endroit prépare la notice dans la transaction qui l'écrit.
// Une sortie nouvelle n'a donc rien à faire pour que la personne l'apprenne ;
// une écriture de `failed` ailleurs serait un échec que personne n'apprend.

/** `.update(agentJobs).set({ … status: 'failed' … })`, avant son WHERE. */
const JOB_FAILED_WRITE =
  /\.update\(agentJobs\)\s*\.set\(\{(?:(?!\.where\()[\s\S]){0,600}?\bstatus:\s*'failed'/g;

describe('architecture — un seul écrivain de `failed`, qui prépare la notice (#1180) @cap:parler-par-canal-externe/moteur', () => {
  it('`failed` n’est écrit sur agent_jobs qu’une fois, dans writeFailure, qui prépare la notice avant d’annoncer', () => {
    const files = scanRoots(new RegExp(JOB_FAILED_WRITE.source), 'job-failed-write').map((v) =>
      rel(v.file),
    );
    expect([...new Set(files)]).toEqual(['apps/runner/src/job/state.ts']);

    const src = readFileSync(join(REPO, 'apps/runner/src/job/state.ts'), 'utf-8');
    expect([...src.matchAll(JOB_FAILED_WRITE)]).toHaveLength(1);
    const start = src.indexOf('async function writeFailure(');
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(new RegExp(JOB_FAILED_WRITE.source));
    const prepare = body.indexOf('await prepareFailureNotice(');
    const announce = body.indexOf('await announceTransitions(');
    expect(prepare).toBeGreaterThan(-1);
    expect(announce).toBeGreaterThan(prepare);
  });

  it('aucune sortie d’échec ne prépare sa propre notice : la clé de la notice n’a qu’un auteur', () => {
    const outside = WRITER_ROOTS.flatMap((root) =>
      scanForPattern(
        { srcDir: join(REPO, root) },
        {
          pattern: /failureNoticeKey\(|:harness:|notifyJobFailure\(/,
          rule: 'failure-notice-elsewhere',
        },
      ),
    )
      .filter((v) => !isTestFile(v.file))
      .map((v) => rel(v.file))
      .filter((f) => f !== 'apps/runner/src/job/failure-notice.ts');
    expect(outside).toEqual([]);
  });
});

// ─── #1215 : un seul écrivain de `completed`, et c'est lui qui prépare la réponse ──
//
// Quatre façons coexistaient de répondre dans le chat de la demande : un outil
// d'envoi surveillé par un drapeau en mémoire (Telegram, Discord, Slack), la
// réponse du runtime CLI relayée par l'outbox, la synthèse du tableau, et rien
// (WhatsApp). La règle : `completed` s'écrit à UN endroit (`completeJob`,
// job/state.ts), et cet endroit prépare la réponse dans la transaction qui
// l'écrit (job/answer-delivery.ts). Une fin nouvelle, un canal nouveau n'ont
// rien à faire pour que la personne reçoive la réponse.

/** `.update(agentJobs).set({ … status: 'completed' … })`, avant son WHERE. */
const JOB_COMPLETED_WRITE =
  /\.update\(agentJobs\)\s*\.set\(\{(?:(?!\.where\()[\s\S]){0,600}?\bstatus:\s*'completed'/g;

/**
 * Ce qui remet un texte à un adaptateur de canal, hors de l'outbox, des outils
 * d'envoi et des cartes d'approbation : chacun nommé, avec ce qu'il envoie.
 * Aucun ne porte la réponse ni l'échec d'un job.
 */
const OTHER_CHANNEL_SENDERS: Readonly<Record<string, string>> = {
  'apps/runner/src/cron/run-schedules.ts': "the owner notice of a routine's spent daily budget",
  'apps/runner/src/notify/code-transitions.ts': 'a transition of the Code tab',
  'apps/runner/src/telegram/poller.ts': 'the pairing and membership replies of the bot',
};

/** Les lieux où un texte peut être remis à un canal par construction. */
const SENDER_HOMES = [
  // Les adaptateurs eux-mêmes.
  'packages/delivery/src/',
  // L'outbox : la réponse et l'échec de tout job.
  'apps/runner/src/delivery/outbox.ts',
  // Les outils d'envoi : ce qu'un agent envoie de lui-même (un fichier, un autre chat).
  'packages/tools/src/communication/',
  // Les cartes d'approbation et les questions d'un serveur MCP.
  'apps/runner/src/approvals/',
];

describe('architecture — un seul écrivain de `completed`, qui prépare la réponse (#1215) @cap:parler-par-canal-externe/moteur', () => {
  it('`completed` n’est écrit sur agent_jobs qu’une fois, dans completeJob, qui prépare la réponse avant d’annoncer', () => {
    const files = scanRoots(new RegExp(JOB_COMPLETED_WRITE.source), 'job-completed-write').map(
      (v) => rel(v.file),
    );
    expect([...new Set(files)]).toEqual(['apps/runner/src/job/state.ts']);

    const src = readFileSync(join(REPO, 'apps/runner/src/job/state.ts'), 'utf-8');
    expect([...src.matchAll(JOB_COMPLETED_WRITE)]).toHaveLength(1);
    const start = src.indexOf('export async function completeJob(');
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(new RegExp(JOB_COMPLETED_WRITE.source));
    const prepare = body.indexOf('await prepareAnswerDelivery(');
    const announce = body.indexOf('await announceTransitions(');
    expect(prepare).toBeGreaterThan(-1);
    expect(announce).toBeGreaterThan(prepare);
  });

  it('une livraison ne se prépare qu’aux deux portes de fin : la réponse et l’échec', () => {
    const outside = WRITER_ROOTS.flatMap((root) =>
      scanForPattern(
        { srcDir: join(REPO, root) },
        { pattern: /\bprepareDelivery\(|answerDeliveryKey\(/, rule: 'delivery-prepared-elsewhere' },
      ),
    )
      .filter((v) => !isTestFile(v.file))
      .map((v) => rel(v.file))
      .filter(
        (f) =>
          ![
            'apps/runner/src/delivery/outbox.ts',
            'apps/runner/src/job/answer-delivery.ts',
            'apps/runner/src/job/failure-notice.ts',
          ].includes(f),
      );
    expect(outside).toEqual([]);
  });

  it('rien hors de l’outbox, des outils d’envoi et des cartes d’approbation ne remet un texte à un canal ; les autres envois sont nommés', () => {
    const senders = WRITER_ROOTS.flatMap((root) =>
      scanForPattern(
        { srcDir: join(REPO, root) },
        { pattern: /\.sendText\(|\.sendMedia\(|\bsendTelegramMessage\(/, rule: 'channel-send' },
      ),
    )
      .filter((v) => !isTestFile(v.file))
      .map((v) => rel(v.file))
      .filter((f) => !SENDER_HOMES.some((home) => f.startsWith(home)));
    expect([...new Set(senders)].sort()).toEqual(Object.keys(OTHER_CHANNEL_SENDERS).sort());
  });
});

describe('architecture — the outcome of a call is read on its row (#1184)', () => {
  it('no production file decides a call’s outcome from its output', () => {
    assertNoViolations(
      'outcome guessed from a tool output',
      scanForOutcomeGuesses({ srcDir: SRC_DIR }),
    );
  });
});

describe('architecture — ce qui sort du runner passe par la couture de sortie @cap:parler-a-un-agent/moteur', () => {
  it('un SDK de messagerie atteint directement porte son texte par la couture', () => {
    const violations = [
      ...scanForOutboundBypass({ srcDir: SRC_DIR }, RUNNER_SDK_SENDS),
      ...scanForOutboundBypass({ srcDir: join(SRC_DIR, 'channels') }, CHANNEL_SESSION_SENDS),
    ];
    if (violations.length > 0) {
      expect.fail(
        formatViolations('Texte posté sur une plateforme à côté de la couture', violations),
      );
    }
  });

  it('une trame de flux ne s’écrit que par `sseEvent`, et rien ne se dit sorti sans y être passé', () => {
    const violations = scanForOutboundBypass({ srcDir: SRC_DIR, skipFiles: ['routes/sse.ts'] }, [
      HAND_WRITTEN_SSE_FRAME,
      OUTBOUND_BRAND_CAST,
    ]);
    if (violations.length > 0) {
      expect.fail(formatViolations('Flux écrit à côté de la couture', violations));
    }
  });

  it('l’application répond par `outboundResponses`, posé avant toute autre porte', () => {
    const src = stripComments(readFileSync(join(SRC_DIR, 'server.ts'), 'utf-8'));
    const created = src.indexOf('new Hono()');
    const seam = src.indexOf("app.use('*', outboundResponses)");
    const firstOther = src
      .slice(created)
      .search(/\bapp\s*\.\s*(?:use|get|post|put|patch|delete|all|route|on)\s*\(/);
    expect(created).toBeGreaterThan(-1);
    expect(seam).toBeGreaterThan(created);
    expect(created + firstOther).toBe(seam);
    // Une seule application dans le runner : une seconde n'aurait pas la couture.
    expect(src.match(/new Hono\(/g)).toHaveLength(1);
    expect(
      scanForOutboundBypass({ srcDir: SRC_DIR, skipFiles: ['src/server.ts'] }, [
        { rule: 'second-app', pattern: /\bnew\s+Hono\s*[(<]/ },
      ]),
    ).toEqual([]);
  });
});

describe('architecture — un résultat d’outil ne sort que par la frontière (executeTool) @cap:connecter-un-service/moteur', () => {
  it('src/ ne lance aucun outil hors d’executeTool et n’écrit aucune ligne tool_calls hors de la frontière', () => {
    const v = scanForToolResultBypass({
      srcDir: SRC_DIR,
      exemptRuns: [
        {
          // L'outil de recherche d'un connecteur, lancé DANS l'outil
          // `web_search` (`ctx.searchBackend`) : ce qu'il rend est le résultat
          // de `web_search`, masqué par la frontière comme celui de tout outil.
          line: 'searchTool.execute(',
          reason: 'inside web_search, whose result goes through the seam',
        },
      ],
    });
    if (v.length > 0) expect.fail(formatViolations('Résultat d’outil hors de la frontière', v));
  });
});

describe('architecture — git n’est lancé que par le lanceur de Nodal', () => {
  it('starts git for itself only through the launcher (@nodal-agents/shared/internal-git)', () => {
    const v = scanForGitSpawnOutsideLauncher({ srcDir: SRC_DIR });
    if (v.length > 0) expect.fail(formatViolations('git lancé hors du lanceur', v));
  });
});
