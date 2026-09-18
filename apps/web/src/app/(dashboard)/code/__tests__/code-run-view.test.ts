// code-run-view.test.ts — la TRADUCTION d'un process de code en blocs de run.
//
// La page `/code/[id]` montre un run comme les deux autres routes ; ce qui
// change est la donnée. Ces fonctions sont ce changement, et chaque cas prouve
// une valeur rendue : un chiffre absent donne « — », un appel refusé garde son
// issue, un run sans rien à montrer n'annonce pas de livraison.

import { describe, it, expect } from 'vitest';
import type { CodingActivityItem, CodingProcessDetail } from '@/lib/actions.ts';
import { UNKNOWN } from '@/app/(dashboard)/runs/run-view.ts';
import {
  codeActivityLabel,
  codeAgents,
  codeDelivery,
  codeFilesHref,
  codeOrigin,
  codeRuntime,
  codeStats,
  codeStatus,
  isRefusedCall,
  toolStepOfCall,
  turnModelLines,
} from '../[id]/code-run-view.ts';

const JOB = '11111111-1111-4111-8111-111111111111';

const header = (
  over: Partial<CodingProcessDetail['header']> = {},
): CodingProcessDetail['header'] => ({
  id: JOB,
  kind: 'job',
  agentId: null,
  agentName: 'Ada',
  origin: 'api',
  status: 'completed',
  stage: 'done',
  task: 'Unfolding a block must not move the scroll',
  costUsd: 0,
  providers: [],
  filesChanged: 0,
  activityAt: null,
  projectPath: null,
  projectName: null,
  projectId: null,
  agentAvatarUrl: null,
  sessionType: 'coding',
  durationMs: null,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  ...over,
});

const call = (over: Partial<Extract<CodingActivityItem, { kind: 'call' }>> = {}) =>
  ({
    kind: 'call',
    id: 'c1',
    toolName: 'cli:Bash',
    toolInput: { command: 'pnpm test' },
    toolOutput: 'ok',
    durationMs: 400,
    createdAt: null,
    delegatedFrom: null,
    ...over,
  }) satisfies CodingActivityItem;

const turn = (over: Partial<Extract<CodingActivityItem, { kind: 'turn' }>> = {}) =>
  ({
    kind: 'turn',
    jobId: JOB,
    turn: 1,
    inputTokens: 4120,
    outputTokens: 380,
    cachedTokens: 3900,
    cacheCreationTokens: null,
    modelUsage: null,
    costUsd: 0.011,
    ...over,
  }) satisfies CodingActivityItem;

const detail = (over: Partial<CodingProcessDetail> = {}): CodingProcessDetail => ({
  header: header(),
  activity: [],
  verdicts: [],
  changes: [],
  pipelineJobIds: [JOB],
  verificationRuns: [],
  verificationSkippedSurfaces: [],
  verificationUnconfigured: [],
  ...over,
});

const valueOf = (h: CodingProcessDetail['header'], label: string): string =>
  codeStats(h).find((s) => s.label === label)?.value ?? 'ABSENT';

describe('code-run-view — l’en-tête @cap:suivre-execution/ecran', () => {
  it('les sept cases, dans l’ordre des autres runs', () => {
    expect(codeStats(header()).map((s) => s.label)).toEqual([
      'Cost',
      'Duration',
      'Input tokens',
      'Output tokens',
      'Cache reads',
      'Files changed',
      'Activity',
    ]);
  });

  it('une valeur que la donnée ne dit pas s’écrit « — »', () => {
    const h = header();
    expect(valueOf(h, 'Cost')).toBe(UNKNOWN);
    expect(valueOf(h, 'Duration')).toBe(UNKNOWN);
    expect(valueOf(h, 'Input tokens')).toBe(UNKNOWN);
    expect(valueOf(h, 'Activity')).toBe(UNKNOWN);
  });

  it('les valeurs connues sont formatées comme sur les autres runs', () => {
    const h = header({ costUsd: 1.92, durationMs: 408_000, inputTokens: 184_300, filesChanged: 2 });
    expect(valueOf(h, 'Cost')).toBe('$1.92');
    expect(valueOf(h, 'Duration')).toBe('6 min 48');
    expect(valueOf(h, 'Input tokens')).toBe('184,300');
    expect(valueOf(h, 'Files changed')).toBe('2');
  });

  it('l’origine nomme le PROJET quand il est dérivable, jamais une branche inventée', () => {
    expect(codeOrigin(header({ projectName: 'nodal-agents' }))).toBe('code · nodal-agents');
    // Sans projet, la provenance de la session — et rien d'autre : le détail
    // d'un process ne porte aucune branche git.
    expect(codeOrigin(header({ origin: 'telegram' }))).toBe('code · telegram');
    expect(codeOrigin(header({ origin: 'code' }))).toBe('code');
  });

  it('le harnais et le modèle se lisent ensemble, et rien ne s’écrit sans eux', () => {
    expect(codeRuntime(header({ providers: ['claude'] }), [])).toBe('claude');
    expect(
      codeRuntime(header({ providers: ['claude'] }), [
        turn({
          modelUsage: [
            {
              model: 'claude-opus-5',
              inputTokens: 1,
              outputTokens: 1,
              cachedTokens: 0,
              cacheCreationTokens: null,
              costUsd: null,
            },
          ],
        }),
      ]),
    ).toBe('claude · claude-opus-5');
    expect(codeRuntime(header(), [])).toBeNull();
  });

  it('le bouton « Files » ne paraît que sur un projet ENREGISTRÉ', () => {
    expect(codeFilesHref(header({ projectId: 'p1' }))).toBe('/spaces/p1/files');
    // Un dossier jamais déclaré n'a pas de page : pas de bouton.
    expect(codeFilesHref(header({ projectId: null }))).toBeNull();
  });

  it('l’état porte le mot de l’étape, et une étape inconnue s’écrit telle quelle', () => {
    expect(codeStatus('done')).toEqual({ variant: 'done', label: 'Done' });
    expect(codeStatus('coding')).toEqual({ variant: 'run', label: 'Coding' });
    expect(codeStatus('awaiting_approval')).toEqual({
      variant: 'warn',
      label: 'Blocked · needs approval',
    });
    expect(codeStatus('teleported')).toEqual({ variant: 'idle', label: 'teleported' });
  });
});

describe('code-run-view — ce qui a été livré @cap:suivre-execution/ecran', () => {
  it('sans fichier ni preuve, il n’y a rien à annoncer', () => {
    expect(codeDelivery(detail())).toBeNull();
  });

  it('les fichiers, leurs lignes et les commandes de preuve viennent des lignes réelles', () => {
    const summary = codeDelivery(
      detail({
        header: header({ costUsd: 1.92, durationMs: 408_000 }),
        changes: [
          { filePath: 'a.tsx', addedLines: 9, removedLines: 2, edits: [] },
          { filePath: 'b.ts', addedLines: 1, removedLines: 0, edits: [] },
        ],
        verificationRuns: [
          {
            sequenceId: 's1',
            jobId: JOB,
            deliverableType: 'code_project',
            canonicalKey: 'd:/apps/x',
            verdict: 'green',
            startedAt: '2026-09-18T09:58:00.000Z',
            runs: [
              {
                jobId: JOB,
                sequenceId: 's1',
                commandRank: 1,
                command: 'pnpm typecheck',
                exitCode: 0,
                outcomeKind: 'exit',
                durationMs: 100,
                verdict: 'green',
                testedGeneration: 1,
                testedEpoch: 0,
                createdAt: '2026-09-18T09:58:00.000Z',
              },
            ],
          },
        ],
      }),
    );
    expect(summary).not.toBeNull();
    expect(summary?.files).toBe(2);
    expect(summary?.filePaths).toEqual(['a.tsx', 'b.ts']);
    expect(summary?.lines).toEqual({ added: 10, removed: 2 });
    expect(summary?.tests).toEqual({ passed: 1, total: 1 });
    expect(summary?.verdict).toBe('green');
    expect(summary?.checks).toEqual([{ command: 'pnpm typecheck', ok: true }]);
    expect(summary?.costUsd).toBe(1.92);
    // Le bloc nomme QUI a relu ; un verdict de code ne porte pas ce nom.
    expect(summary?.reviews).toEqual([]);
  });
});

describe('code-run-view — l’activité @cap:suivre-execution/ecran', () => {
  it('un appel devient un bloc du fil, sans carte inventée', () => {
    const step = toolStepOfCall(call(), JOB);
    expect(step.toolName).toBe('cli:Bash');
    expect(step.card).toBeNull();
    expect(step.presented).toBeNull();
    expect(step.outcome).toBe('success');
    expect(step.durationMs).toBe(400);
  });

  it('un appel REFUSÉ par le harnais garde son issue — il ne passe pas pour un succès', () => {
    expect(isRefusedCall('<tool_use_error>not allowed</tool_use_error>')).toBe(true);
    expect(isRefusedCall('{"ok":false,"error":"denied"}')).toBe(true);
    expect(isRefusedCall('all good')).toBe(false);
    expect(
      toolStepOfCall(call({ toolOutput: '<tool_use_error>nope</tool_use_error>' }), JOB).outcome,
    ).toBe('error');
  });

  it('un tour rend une ligne de modèle ; un tour à deux modèles en rend deux', () => {
    expect(turnModelLines(turn())).toHaveLength(1);
    expect(turnModelLines(turn())[0]?.usage.inputTokens).toBe(4120);
    const split = turnModelLines(
      turn({
        modelUsage: [
          {
            model: 'a',
            inputTokens: 1,
            outputTokens: 2,
            cachedTokens: 0,
            cacheCreationTokens: null,
            costUsd: 0.1,
          },
          {
            model: 'b',
            inputTokens: 3,
            outputTokens: 4,
            cachedTokens: 0,
            cacheCreationTokens: null,
            costUsd: null,
          },
        ],
      }),
    );
    expect(split.map((l) => l.model)).toEqual(['a', 'b']);
    expect(split[1]?.usage.costUsd).toBeNull();
  });

  it('les agents sont ceux du process et de ses délégués, dédoublonnés, avec leur image', () => {
    const activity = [
      call(),
      call({
        id: 'c2',
        delegatedFrom: { jobId: 'j2', agentName: 'Hopper', agentAvatarUrl: '/r.png' },
      }),
      call({
        id: 'c3',
        delegatedFrom: { jobId: 'j3', agentName: 'Hopper', agentAvatarUrl: null },
      }),
    ];
    const agents = codeAgents(header({ agentAvatarUrl: '/dev-c.png' }), activity);
    expect(agents.map((a) => a.name)).toEqual(['Ada', 'Hopper']);
    // La barre montre des VISAGES : l'image voyage jusqu'à elle (18/09).
    expect(agents.map((a) => a.avatarUrl)).toEqual(['/dev-c.png', '/r.png']);
    // Sans image, rien d'inventé — `AgentAvatar` retombe sur les initiales.
    expect(codeAgents(header(), []).map((a) => a.avatarUrl)).toEqual([null]);
  });

  it('la ligne de l’activité compte les pas, les agents et la durée', () => {
    const activity = [call(), turn()];
    expect(codeActivityLabel(header({ durationMs: 408_000 }), activity)).toBe(
      '2 steps · 1 agent · 6 min 48',
    );
    // Sans durée connue, la ligne n'en invente pas.
    expect(codeActivityLabel(header(), activity)).toBe('2 steps · 1 agent');
  });
});
