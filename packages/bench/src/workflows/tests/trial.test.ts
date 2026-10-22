// trial.test.ts — les règles qui rendent le banc sûr sur la stack du propriétaire.
//
// Chaque règle est jouée contre un faux runner (horloge, base et lancement
// simulés) mais sur des lignes RÉELLES : l'essai `file` du 30/09 qui s'est
// arrêté sur une approbation. Ce que les tests vérifient, c'est le résultat —
// la ligne écrite, l'arbre annulé, le job jamais lancé — pas des compteurs
// d'appels.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TreeFactsSchema, type TreeFacts } from '../facts';
import { SCENARIOS, scenarioById } from '../scenarios';
import { BENCH_PRINTER_MISSING } from '../needs';
import {
  DELIVERY_TOOL_NAMES,
  createSendAudioTool,
  createSendFileTool,
  createSendImageTool,
  createSendVideoTool,
  createSendVoiceTool,
  createTelegramSendMessageTool,
} from '@nodal-agents/tools';
import {
  DELIVERY_CONTENT_FIELDS,
  DELIVERY_TARGET_FIELDS,
  busyReason,
  destinationReasons,
  measure,
  runTrial,
  type TrialDeps,
  type TrialOptions,
} from '../trial';
import type { ForeignActivity } from '../stack';
import type { ResearchSubject } from '../subjects';
import type { AnyScenario } from '../types';

const FIX = join(__dirname, 'fixtures');
const load = (name: string): TreeFacts =>
  TreeFactsSchema.parse(
    (JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')) as { facts: unknown }).facts,
  );

const OPTS: TrialOptions = {
  pollMs: 2_000,
  idleWaitMs: 10 * 60_000,
  idlePollMs: 30_000,
  chatQuietMs: 5 * 60_000,
  trigger: 'manual',
  nodalVersion: '0.9.3',
  stackCommit: 'ebef7ed7e02b',
  modelUnderTest: null,
  allowOwnerSends: false,
};

const IDLE: ForeignActivity = { jobs: [], lastChatMs: null };

/** Un sujet calibré, posé pour les essais de recherche (subjects.ts) : celui de l'essai réel du 30/09. */
const CMB: ResearchSubject = {
  id: 'test-cmb',
  kind: 'research',
  request: 'la découverte du fond diffus cosmologique : qui, quand, comment',
  facts: [{ says: 'name Penzias', pattern: '\\bpenzias\\b', flags: 'i' }],
  calibratedOn: ['test'],
};

interface World {
  deps: TrialDeps;
  started: string[];
  cancelled: Array<{ entityId: string; rootId: string }>;
  clock: { now: number };
}

/**
 * Un faux monde : `snapshots` est ce que la base rend, lecture après lecture,
 * tant que personne n'a annulé ; `afterCancel` est ce qu'elle rend ensuite.
 */
function world(opts: {
  rootId: string;
  snapshots: TreeFacts[];
  afterCancel?: TreeFacts;
  foreign?: ForeignActivity[];
  subjects?: ResearchSubject[];
}): World {
  const clock = { now: Date.parse('2026-09-30T03:00:00Z') };
  const started: string[] = [];
  const cancelled: Array<{ entityId: string; rootId: string }> = [];
  let reads = 0;
  let foreignReads = 0;
  const deps: TrialDeps = {
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    start: async (instruction) => {
      started.push(instruction);
      return { jobId: opts.rootId, close: async () => undefined };
    },
    read: async () => {
      if (cancelled.length > 0 && opts.afterCancel) return opts.afterCancel;
      const s = opts.snapshots[Math.min(reads, opts.snapshots.length - 1)]!;
      reads++;
      return s;
    },
    cancel: async (entityId, rootId) => {
      cancelled.push({ entityId, rootId });
    },
    foreign: async () => {
      const list = opts.foreign ?? [IDLE];
      return list[Math.min(foreignReads++, list.length - 1)]!;
    },
    env: async (startedMs) => ({
      workspaceRoots: [],
      teamTools: [],
      services: {},
      unlistedMcpServers: [],
      startedMs,
    }),
    rootModel: async () => 'z-ai/glm-5.3',
    subjects: () => opts.subjects ?? [],
    log: () => undefined,
  };
  return { deps, started, cancelled, clock };
}

/** L'essai `file` réel, tel qu'il était AVANT l'annulation : l'approbation en attente, les jobs vivants. */
function beforeCancel(after: TreeFacts): TreeFacts {
  return {
    ...after,
    jobs: after.jobs.map((j) => ({
      ...j,
      status: j.id === after.rootId ? 'awaiting_delegation' : 'awaiting_approval',
    })),
    approvals: after.approvals.map((a) => ({ ...a, status: 'pending', resolvedBy: null })),
  };
}

describe('workflow trial safety rules', () => {
  it('an approval raised by a trial is RED, and the whole tree is cancelled at once', async () => {
    const after = load('file-red-approval');
    const w = world({ rootId: after.rootId, snapshots: [beforeCancel(after)], afterCancel: after });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);

    // Annulé dès la première lecture qui voit l'approbation : aucune attente.
    expect(w.cancelled).toEqual([{ entityId: after.entityId, rootId: after.rootId }]);
    expect(w.clock.now - Date.parse('2026-09-30T03:00:00Z')).toBe(0);
    expect(line.verdict).toBe('red');
    expect(line.cancelled).toBe(true);
    expect(line.reasons).toContain('asked an approval (run_command)');
    expect(line.approvals).toBe(1);
    expect(line.rootJobId).toBe(after.rootId);
  });

  it('the bench never answers the approval: the only write is the cancel, which expires it', async () => {
    const after = load('file-red-approval');
    const w = world({ rootId: after.rootId, snapshots: [beforeCancel(after)], afterCancel: after });
    await runTrial(scenarioById('question')!, w.deps, OPTS);
    // La ligne relue après l'annulation : l'approbation est expirée par l'annulation, pas approuvée.
    expect(after.approvals.map((a) => [a.status, a.resolvedBy])).toEqual([
      ['expired', 'system:job_cancelled'],
    ]);
  });

  it('a live job of the owner makes the bench wait, then skip with the reason — nothing is started', async () => {
    const busy: ForeignActivity = {
      jobs: [
        {
          id: '5e3c1a90-0000-4000-8000-000000000000',
          status: 'processing',
          channel: 'telegram',
          agentSlug: 'alfred',
        },
      ],
      lastChatMs: null,
    };
    const after = load('question-green');
    const w = world({ rootId: after.rootId, snapshots: [after], foreign: [busy] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);

    expect(w.started).toEqual([]);
    expect(w.cancelled).toEqual([]);
    expect(line.verdict).toBe('skipped');
    expect(line.reasons).toEqual([
      'the stack was busy for 10 min: 1 job(s) of the owner still live: 5e3c1a90 alfred processing via telegram',
    ]);
    expect(line.rootJobId).toBeNull();
  });

  it('the owner finishing while the bench waits lets the trial run', async () => {
    const busy: ForeignActivity = {
      jobs: [
        {
          id: '5e3c1a90-0000-4000-8000-000000000000',
          status: 'processing',
          channel: 'telegram',
          agentSlug: 'alfred',
        },
      ],
      lastChatMs: null,
    };
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green], foreign: [busy, busy, IDLE] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(w.started).toEqual(["Quelle est la capitale de l'Australie ?"]);
    expect(line.verdict).toBe('green');
    expect(line.startedAt).toBe('2026-09-30T03:01:00.000Z');
  });

  it('a recent chat turn counts as the owner working', () => {
    const now = Date.parse('2026-09-30T03:00:00Z');
    expect(busyReason({ jobs: [], lastChatMs: now - 60_000 }, now, 5 * 60_000)).toBe(
      'a chat turn ran 60 s ago',
    );
    expect(busyReason({ jobs: [], lastChatMs: now - 6 * 60_000 }, now, 5 * 60_000)).toBeNull();
  });

  it('a run that outlives its budget is cancelled and red — the bench leaves nothing alive', async () => {
    const after = load('file-red-approval');
    const live: TreeFacts = { ...beforeCancel(after), approvals: [] };
    const w = world({
      rootId: after.rootId,
      snapshots: [live],
      afterCancel: { ...after, approvals: [] },
    });
    const s = scenarioById('question')!;
    const line = await runTrial(s, w.deps, OPTS);
    expect(w.cancelled).toEqual([{ entityId: after.entityId, rootId: after.rootId }]);
    expect(line.verdict).toBe('red');
    expect(line.reasons[0]).toBe('timed out after 5 min');
    expect(line.cancelled).toBe(true);
  });

  it('a tree whose cost passes the trial cap is cancelled and red, delegated jobs counted in the sum', async () => {
    const after = load('file-red-approval');
    const call = load('question-green').llmCalls[0]!;
    const kid = after.jobs.find((j) => j.id !== after.rootId)!.id;
    // 0,70 $ pour la tête, 0,60 $ pour le délégué : chaque job sous le budget
    // de run d'un job (1 $), l'ARBRE au-dessus du plafond de l'essai.
    const billed = [
      { ...call, jobId: after.rootId, error: null, costUsd: 0.7 },
      { ...call, jobId: kid, error: null, costUsd: 0.6 },
    ];
    const live: TreeFacts = { ...beforeCancel(after), approvals: [], llmCalls: billed };
    const w = world({
      rootId: after.rootId,
      snapshots: [live],
      afterCancel: { ...after, approvals: [], llmCalls: billed },
    });
    const line = await runTrial(scenarioById('question')!, w.deps, {
      ...OPTS,
      maxTreeCostUsd: 1,
      campaign: '20261022-090000-abcd',
      configFingerprint: '0123456789ab',
    });
    expect(w.cancelled).toEqual([{ entityId: after.entityId, rootId: after.rootId }]);
    expect(line.verdict).toBe('red');
    expect(line.reasons[0]).toBe('its cost passed the cap of the trial ($1.3000 spent, cap $1)');
    expect(line.costUsd).toBe(1.3);
    expect(line.campaign).toBe('20261022-090000-abcd');
    expect(line.configFingerprint).toBe('0123456789ab');
  });

  it('a missing need SKIPS the trial with its reason, never red, and no job is started', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    const line = await runTrial(scenarioById('print')!, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line.verdict).toBe('skipped');
    expect(line.reasons).toEqual([BENCH_PRINTER_MISSING]);
    expect(line).toMatchObject({
      activity: 'print',
      needs: ['bench-printer'],
      rootModel: 'z-ai/glm-5.3',
    });
  });

  // Décision du propriétaire, 18/10 : un essai d'impression du banc ne parle
  // jamais à une vraie imprimante. Tout scénario de l'activité `print` attend
  // l'imprimante du banc (#794), même quand l'équipe a request_print (le
  // connecteur réel du propriétaire) : il est sauté, avec la raison, et rien
  // ne démarre.
  it.each(SCENARIOS.filter((s) => s.activity === 'print').map((s) => s.id))(
    "%s: a print scenario never runs on the team's real printer: without the bench's recording printer it is skipped, with the reason",
    async (id) => {
      const green = load('print-green');
      const w = world({ rootId: green.rootId, snapshots: [green] });
      w.deps.env = async (startedMs) => ({
        workspaceRoots: [],
        teamTools: ['office_printer__request_print', 'office_printer__get_print_request'],
        services: {},
        unlistedMcpServers: [],
        startedMs,
      });
      const line = await runTrial(scenarioById(id)!, w.deps, OPTS);
      expect(w.started).toEqual([]);
      expect([line.verdict, line.reasons]).toEqual(['skipped', [BENCH_PRINTER_MISSING]]);
    },
  );

  it('the print scenarios are print, print-file and recipe: the rule above is played on each', () => {
    expect(SCENARIOS.filter((s) => s.activity === 'print').map((s) => s.id)).toEqual([
      'print',
      'print-file',
      'recipe',
    ]);
  });

  it('a refused run_task is an ERROR line with the server words, never a silent pass', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    w.deps.start = async () => {
      throw new Error(
        'workflow_mcp_failed: run_task refused: mcp_disabled: the MCP server is switched off',
      );
    };
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(line.verdict).toBe('error');
    expect(line.reasons).toEqual([
      'workflow_mcp_failed: run_task refused: mcp_disabled: the MCP server is switched off',
    ]);
  });

  it('a green trial carries the real measures of its tree', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(line).toMatchObject({
      scenario: 'question',
      scenarioVersion: 1,
      verdict: 'green',
      reasons: [],
      jobs: 1,
      agents: ['alfred'],
      models: ['z-ai/glm-5.3'],
      llmCalls: 2,
      inputTokens: 33722,
      outputTokens: 70,
      costUsd: 0.0358,
      approvals: 0,
      cancelled: false,
      nodalVersion: '0.9.3',
    });
    expect(line.durationMs).toBe(20952);
  });
});

// Revue Codex de la PR #634, constats 5 et 6 : un prérequis qui manque ne doit
// pas coûter trente minutes d'essai, et une préparation qui lève ne doit pas
// emporter les scénarios suivants avec elle.
// Revue Reviewer A de #756, passe 2 (P2-1) : chaque scénario déclare où il
// envoie. Un scénario qui envoie au propriétaire ne tourne qu'avec un drapeau
// explicite ; et un envoi qui part ailleurs que là où le scénario le déclare
// interdit le vert, quel que soit le juge du scénario.
describe('where a trial may send', () => {
  const sendTool = (input: object) => ({
    jobId: null as string | null,
    toolName: 'send_image',
    input: JSON.stringify(input),
    output: JSON.stringify({ ok: true }),
    createdMs: 0,
  });

  it('a scenario that sends to the owner is SKIPPED without --allow-owner-sends, and starts nothing', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    w.deps.env = async (startedMs) => ({
      workspaceRoots: [],
      teamTools: [],
      services: { comfyui: { url: 'http://127.0.0.1:8188', problem: null } },
      unlistedMcpServers: [],
      startedMs,
    });
    const line = await runTrial(scenarioById('comfyui-telegram')!, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line.verdict).toBe('skipped');
    expect(line.reasons).toEqual([
      "this scenario sends to the owner's own account (sends: owner): it runs only with --allow-owner-sends",
    ]);
    expect(line.sends).toBe('owner');
  });

  it('the same scenario starts with the flag', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    w.deps.env = async (startedMs) => ({
      workspaceRoots: [],
      teamTools: [],
      services: { comfyui: { url: 'http://127.0.0.1:8188', problem: null } },
      unlistedMcpServers: [],
      startedMs,
    });
    await runTrial(scenarioById('comfyui-telegram')!, w.deps, { ...OPTS, allowOwnerSends: true });
    expect(w.started).toHaveLength(1);
  });

  it('a send during a scenario that declares nothing is red, though its own judge is green', async () => {
    const green = load('question-green');
    const sent: TreeFacts = {
      ...green,
      toolCalls: [...green.toolCalls, { ...sendTool({ source: 'x.png' }), jobId: green.rootId }],
    };
    const w = world({ rootId: green.rootId, snapshots: [sent] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(scenarioById('question')!.judge(sent, null)).toEqual([]);
    expect(line.verdict).toBe('red');
    expect(line.reasons).toEqual(['a send tool was called (send_image)']);
  });

  it('an owner scenario whose send names an explicit recipient is red: that is not the owner', async () => {
    const green = load('question-green');
    const sent: TreeFacts = {
      ...green,
      toolCalls: [
        { ...sendTool({ source: 'x.png', chatId: '-1001234567890' }), jobId: green.rootId },
      ],
    };
    const w = world({ rootId: green.rootId, snapshots: [sent] });
    const ownerQuestion: AnyScenario = { ...scenarioById('question')!, sends: 'owner' };
    const line = await runTrial(ownerQuestion, w.deps, { ...OPTS, allowOwnerSends: true });
    expect(line.verdict).toBe('red');
    expect(line.reasons).toEqual([
      "a product delivery names an explicit target (send_image: chatId=-1001234567890): sends: owner allows only the owner's own chat",
    ]);
  });

  // Revue Reviewer A, passe 3 (P1) : un envoi par un outil MCP ou de connecteur
  // de messagerie, sans destinataire (donc le chat par défaut : le propriétaire),
  // passait inaperçu. Fermé par défaut : sous `nothing`, tout outil dont le nom
  // porte un verbe sortant ou vise un canal rend l'essai rouge, en le nommant.
  it.each([
    'mcp-telegram__send_message',
    'slack__chat_postMessage',
    'discord__sendMessage',
    'whatsapp__sendText',
    'twitter__tweet',
    'notify__push',
    // Passe 4 (P1) : un connecteur dont le dernier segment ressemble à un outil
    // interne du produit n'est PAS interne.
    'slack__file_upload',
    'telegram__file_send',
    'dropbox__file_share',
    'gdrive__file_publish',
    // Passe 4 (P3) : les flexions des verbes, une seule règle pour tous.
    'blog__create_posts',
    'drive__shares_add',
    'mail_tool__replied_to',
    'cms__publishes',
    'gallery__uploading_images',
    // Passe 5 (P3) : une opération de connecteur adaptateur (un seul « _ ») n'est
    // jamais interne, même nommée comme un outil du produit.
    'file_upload',
    'gmail_send_email',
    'drive_upload_file',
    // Pas de verbe d'action, mais un service de messagerie ou de courrier : fermé par défaut.
    'telegram__chat',
    'smtp_relay',
    // Passe 6 (P1) : une lecture SUIVIE d'un envoi dans le même outil reste un envoi.
    'get_and_send',
    'list_then_post',
    'getAndSend',
    'checkBeforeSend',
    'slack__list_and_notify',
    // Passe 7 (P1) : après une lecture, une base sortante préfixée de « re ».
    'get_sent_then_resend',
    'list_then_resend',
    'fetch_then_repost',
    'check_before_retweet',
    'search_and_reshare',
  ])('under sends: nothing, %s makes the trial red, named', async (tool) => {
    const green = load('question-green');
    const sent: TreeFacts = {
      ...green,
      toolCalls: [
        ...green.toolCalls,
        { jobId: green.rootId, toolName: tool, input: '{"text":"x"}', output: '{}', createdMs: 0 },
      ],
    };
    const w = world({ rootId: green.rootId, snapshots: [sent] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(line.verdict).toBe('red');
    expect(line.reasons).toEqual([`an outbound tool was called (${tool})`]);
  });

  // Revue Reviewer A, passe 5 (P2) : le verbe d'ACTION décide, par sa position
  // (le premier mot après un préfixe de service), pas n'importe quel mot. Un
  // outil qui LIT reste vert, même si un mot de son nom est une forme d'envoi.
  it.each([
    'get_posted_at',
    'list_shared_drives',
    'shared_with_me',
    'list_posts',
    'published_at',
    'queue__sent_items',
    'drive__shared_with_me',
    'slack__list_channels',
    'gmail_list_messages',
    'gmail_get_message',
    'blog__search_posts',
    'telegram__get_updates',
    // Passe 7 (P2) : après une lecture, un -ing est un complément de nom, pas une action.
    'list_sending_domains',
    'get_posting_rules',
    'get_forwarding_rules',
  ])('under sends: nothing, the read %s stays green', async (tool) => {
    const green = load('question-green');
    const read: TreeFacts = {
      ...green,
      toolCalls: [{ jobId: green.rootId, toolName: tool, input: '{}', output: '{}', createdMs: 0 }],
    };
    const w = world({ rootId: green.rootId, snapshots: [read] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(line.reasons).toEqual([]);
  });

  // Revue de #777, passe 8 (P2) : « jamais une vraie imprimante » ne tenait
  // qu'au besoin des trois scénarios d'impression. Imprimer est une action
  // sur le monde, comme envoyer : la même classification (`isOutboundTool`)
  // rend rouge tout essai qui appelle un outil d'impression. Ici sous
  // `sends: nothing` ; sous `owner`, voir la passe 9 plus bas. Une lecture
  // (`list_printers`) ne l'est pas.
  const PRINT_CALLS = [
    'office_printer__request_print',
    'office_printer__confirm_print',
    'printer__print_document',
    'cups__print',
  ];
  const nonPrint = SCENARIOS.filter((s) => s.activity !== 'print' && s.sends === 'nothing');
  it.each(PRINT_CALLS)(
    'a print call (%s) is red with its reason in every non-print scenario, never only in the print ones',
    (tool) => {
      expect(nonPrint.length).toBeGreaterThan(10);
      const green = load('question-green');
      const printed: TreeFacts = {
        ...green,
        toolCalls: [
          { jobId: green.rootId, toolName: tool, input: '{}', output: '{}', createdMs: 0 },
        ],
      };
      for (const s of nonPrint)
        expect([s.id, destinationReasons(s, printed)]).toEqual([
          s.id,
          [`an outbound tool was called (${tool})`],
        ]);
    },
  );

  it('end to end: a question trial whose agent called request_print then confirm_print is red, named', async () => {
    const green = load('question-green');
    const printed: TreeFacts = {
      ...green,
      toolCalls: [
        ...green.toolCalls,
        ...['office_printer__request_print', 'office_printer__confirm_print'].map((toolName) => ({
          jobId: green.rootId,
          toolName,
          input: '{}',
          output: '{}',
          createdMs: 0,
        })),
      ],
    };
    const w = world({ rootId: green.rootId, snapshots: [printed] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect([line.verdict, line.reasons]).toEqual([
      'red',
      [
        'an outbound tool was called (office_printer__request_print, office_printer__confirm_print)',
      ],
    ]);
  });

  it.each(['office_printer__list_printers', 'printer__get_printers', 'printer__list_jobs'])(
    'a printer read (%s) stays green in every non-print scenario',
    (tool) => {
      const green = load('question-green');
      const read: TreeFacts = {
        ...green,
        toolCalls: [
          { jobId: green.rootId, toolName: tool, input: '{}', output: '{}', createdMs: 0 },
        ],
      };
      for (const s of nonPrint) expect([s.id, destinationReasons(s, read)]).toEqual([s.id, []]);
    },
  );

  // Revue de #777, passe 9 (P2) : sous `sends: owner`, seuls les outils de
  // livraison étaient lus (pour leur destinataire) ; une impression ou tout
  // autre outil sortant passait vert. `owner` permet UNE chose sortante : une
  // livraison au chat du propriétaire. Tout autre outil sortant est rouge,
  // quel que soit le `sends` du scénario.
  const OWNER = SCENARIOS.filter((s) => s.sends === 'owner');
  const callOf = (toolName: string, input: object = {}) => ({
    jobId: load('question-green').rootId as string | null,
    toolName,
    input: JSON.stringify(input),
    output: JSON.stringify({ ok: true }),
    createdMs: 0,
  });
  const withCalls = (...calls: ReturnType<typeof callOf>[]): TreeFacts => ({
    ...load('question-green'),
    toolCalls: calls,
  });

  it('every scenario declares nothing or owner: the outbound rule below covers them all', () => {
    expect(OWNER.length).toBeGreaterThan(0);
    expect(SCENARIOS.filter((s) => s.sends !== 'nothing' && s.sends !== 'owner')).toEqual([]);
  });

  it.each([...PRINT_CALLS, 'slack__chat_postMessage', 'gdrive__file_publish', 'notify__push'])(
    'under sends: owner, %s is red with its reason in every owner scenario, beside the owner delivery',
    (tool) => {
      for (const s of OWNER)
        expect([
          s.id,
          destinationReasons(s, withCalls(callOf('send_image', { source: 'x.png' }), callOf(tool))),
        ]).toEqual([s.id, [`an outbound tool was called (${tool})`]]);
    },
  );

  it("under sends: owner, the delivery to the owner's own chat stays green, and one to someone else stays red", () => {
    for (const s of OWNER) {
      expect([
        s.id,
        destinationReasons(s, withCalls(callOf('send_image', { source: 'x.png' }))),
      ]).toEqual([s.id, []]);
      expect([
        s.id,
        destinationReasons(
          s,
          withCalls(callOf('send_image', { source: 'x.png', chatId: '-1001234567890' })),
        ),
      ]).toEqual([
        s.id,
        [
          "a product delivery names an explicit target (send_image: chatId=-1001234567890): sends: owner allows only the owner's own chat",
        ],
      ]);
    }
  });

  it('the real comfyui-telegram trial (its normal path: a skill script, then send_image) stays green on the destination rule', () => {
    const real = load('comfyui-telegram-green');
    expect(destinationReasons(scenarioById('comfyui-telegram')!, real)).toEqual([]);
  });

  // Revue de #777, passe 10 (P2) : l'exemption de `owner` se décidait sur le
  // nom NU (`bareToolName` retire `cli:` et `serveur__`) et sur tout envoi de
  // courrier. Une exemption se décide sur l'IDENTITÉ de l'outil : seuls les
  // outils de livraison du produit, à leur nom EXACT, tel que le runner les
  // range (sans préfixe), livrent au chat de la conversation. Un outil MCP ou
  // de CLI du même nom nu n'est pas celui du produit ; un courrier n'est pas
  // le chat du propriétaire, et son destinataire ne se vérifie pas.
  it('the runner records the product delivery tools by their exact, unprefixed name (real captured trials)', () => {
    expect(
      load('comfyui-telegram-green')
        .toolCalls.map((c) => c.toolName)
        .filter((n) => n.includes('send')),
    ).toEqual(['send_image']);
  });

  it.each([
    ['x__send_image', {}],
    ['cli:send_image', {}],
    ['x__telegram_send_message', { text: 'fait' }],
    ['gmail__send_email', { to: 'boss', subject: 'x' }],
    ['outlook_send_mail', { recipient: 'the team' }],
  ])(
    'under sends: owner, %s looks like a delivery but is not the product one: red, outbound, in every owner scenario',
    (tool, input) => {
      for (const s of OWNER)
        expect([s.id, destinationReasons(s, withCalls(callOf(tool, input)))]).toEqual([
          s.id,
          [`an outbound tool was called (${tool})`],
        ]);
    },
  );

  it.each(['send_image', 'send_file', 'telegram_send_message'])(
    "under sends: owner, the product's own %s (exact name, no recipient) stays green in every owner scenario",
    (tool) => {
      for (const s of OWNER)
        expect([s.id, destinationReasons(s, withCalls(callOf(tool, { source: 'x.png' })))]).toEqual(
          [s.id, []],
        );
    },
  );

  // Revue de #777, passe 11 (P2) : sous `owner`, le destinataire d'une
  // livraison du produit était cherché dans le TEXTE de son entrée
  // (`recipientIds` : courriels, téléphones, identifiants de 9 chiffres et
  // plus). Les outils acceptent tout `chatId` `^-?\d+$` et livrent à toute
  // conversation approuvée : `chatId: '1234567'` passait vert. La règle est
  // STRUCTURELLE : une livraison du produit qui nomme une cible (un champ de
  // destination de son schéma) est rouge ; sans cible, le produit livre au
  // propriétaire de la conversation.
  const TARGETED = (tool: string, what: string) =>
    `a product delivery names an explicit target (${tool}: ${what}): sends: owner allows only the owner's own chat`;
  it.each([
    ['send_file', { source: 'report.pdf', chatId: '1234567' }, 'chatId=1234567'],
    ['send_image', { source: 'x.png', chatId: '1234567' }, 'chatId=1234567'],
    ['telegram_send_message', { text: 'fait', chatId: '1234567' }, 'chatId=1234567'],
    ['send_video', { source: 'v.mp4', chatId: '-42' }, 'chatId=-42'],
    ['send_image', { source: 'x.png', channel: 'slack' }, 'channel=slack'],
  ])(
    'under sends: owner, the product %s with an explicit target is red, in every owner scenario',
    (tool, input, what) => {
      for (const s of OWNER)
        expect([s.id, destinationReasons(s, withCalls(callOf(tool, input)))]).toEqual([
          s.id,
          [TARGETED(tool, what)],
        ]);
    },
  );

  it('under sends: owner, a product delivery with a field the bench does not know is red: it may name a target', () => {
    for (const s of OWNER)
      expect([
        s.id,
        destinationReasons(s, withCalls(callOf('send_image', { source: 'x.png', chat_id: '7' }))),
      ]).toEqual([
        s.id,
        [
          'a product delivery carries a field the bench does not know (send_image: chat_id): it may name a target, so sends: owner refuses it',
        ],
      ]);
  });

  it('under sends: owner, a delivery whose source URL holds 14 digits stays green: no text is scanned', () => {
    for (const s of OWNER)
      expect([
        s.id,
        destinationReasons(
          s,
          withCalls(
            callOf('send_image', {
              source: 'http://127.0.0.1:8188/view?filename=img_20261018123456.png',
              caption: 'n° -1001234567890',
              purpose: 'Livrer au propriétaire.',
            }),
          ),
        ),
      ]).toEqual([s.id, []]);
  });

  it('every field of every product delivery tool is known to the bench, as a target or as content: a new field fails here', () => {
    const tools = [
      createTelegramSendMessageTool(),
      createSendImageTool(),
      createSendFileTool(),
      createSendVideoTool(),
      createSendAudioTool(),
      createSendVoiceTool(),
    ];
    expect(tools.map((t) => t.name).sort()).toEqual([...DELIVERY_TOOL_NAMES].sort());
    const known = new Set<string>([...DELIVERY_TARGET_FIELDS, ...DELIVERY_CONTENT_FIELDS]);
    for (const t of tools) {
      const fields = Object.keys((t.inputSchema as unknown as { shape: object }).shape);
      expect([t.name, fields.filter((f) => !known.has(f))]).toEqual([t.name, []]);
    }
    // Les cibles du produit, lues dans ses schémas : chacune est bien un champ d'au moins un outil.
    for (const f of DELIVERY_TARGET_FIELDS)
      expect(tools.some((t) => f in (t.inputSchema as unknown as { shape: object }).shape)).toBe(
        true,
      );
  });

  it('internal tools stay quiet: files, office documents, the dashboard, return_result', async () => {
    const green = load('question-green');
    const quiet: TreeFacts = {
      ...green,
      toolCalls: [
        'file_write',
        'workspace_list',
        'xlsx_create',
        'docx_replace_text',
        'pptx_append_slides',
        'dashboard_publish',
        'return_result',
        'web_search',
        'run_command',
        'postgres__query',
        // Un message passé à du travail EN COURS de la même conversation : interne.
        // S'il en résulte une réponse sur un canal, c'est une livraison (job_deliveries), lue à part.
        'message_conversation_run',
      ].map((toolName) => ({
        jobId: green.rootId,
        toolName,
        input: '{}',
        output: '{}',
        createdMs: 0,
      })),
    };
    const w = world({ rootId: green.rootId, snapshots: [quiet] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(line.verdict).toBe('green');
  });

  it('a scenario declaring a test account does not run: no test account is wired yet', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    const tested: AnyScenario = { ...scenarioById('question')!, sends: 'test-account:gmail-test' };
    const line = await runTrial(tested, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line).toMatchObject({
      verdict: 'skipped',
      reasons: [
        'this scenario sends to the test account "gmail-test", and no test account is wired yet',
      ],
    });
  });
});

describe('what happens before a trial starts', () => {
  it('deep-research-obsidian without a vault is SKIPPED at once, with the reason, and no job is started', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    const line = await runTrial(scenarioById('deep-research-obsidian')!, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line.verdict).toBe('skipped');
    expect(line.reasons).toEqual([
      'no Obsidian vault is configured: no workspace folder of this workspace holds a .obsidian folder',
    ]);
    expect(line.rootJobId).toBeNull();
  });

  it('a preparation that throws (a declared fixture missing) is an ERROR line with its reason, never a rejected trial', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    w.deps.env = async (startedMs) => ({
      workspaceRoots: [mkdtempSync(join(tmpdir(), 'wf-prep-'))],
      teamTools: ['xlsx_create'],
      services: {},
      unlistedMcpServers: [],
      startedMs,
    });
    const broken: AnyScenario = {
      ...scenarioById('file')!,
      fixtures: [{ from: 'office/absent-bench.xlsx', to: 'nodal-bench/absent-bench.xlsx' }],
    };
    const line = await runTrial(broken, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line.verdict).toBe('error');
    expect(line.reasons).toHaveLength(1);
    expect(line.reasons[0]).toMatch(
      /^the trial could not be prepared: workflow_fixture_missing: .*absent-bench\.xlsx$/,
    );
    expect(line.scenario).toBe('file');
  });

  it('a need check that throws is an ERROR line too', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    w.deps.env = async (startedMs) => ({
      get workspaceRoots(): string[] {
        throw new Error('EACCES: permission denied, stat');
      },
      teamTools: [],
      services: {},
      unlistedMcpServers: [],
      startedMs,
    });
    const line = await runTrial(scenarioById('deep-research-obsidian')!, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line).toMatchObject({
      verdict: 'error',
      reasons: ['the trial could not be prepared: EACCES: permission denied, stat'],
    });
  });

  it('the environment unreadable before the trial is an ERROR line too', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    w.deps.env = async () => {
      throw new Error('connection terminated');
    };
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line).toMatchObject({
      verdict: 'error',
      reasons: ['the trial could not be prepared: connection terminated'],
    });
  });
});

// Revue Codex de la PR #634, constat 4 : une grandeur qu'un runtime ne rapporte
// pas est ABSENTE (null), jamais zéro.
describe('measures that a runtime does not report', () => {
  const green = load('question-green');
  const cli = {
    jobId: green.rootId,
    provider: 'claude',
    modelRequested: 'opus',
    source: 'subscription',
    models: ['claude-opus-4-1-20250805'],
    costUsd: 0.52,
    inputTokens: 10,
    outputTokens: 300,
    cachedTokens: 5000,
    cacheCreationTokens: 200,
    createdMs: green.jobs[0]!.createdMs + 4_000,
  };

  it('a tree run only under a subscription bills no dollar per call: its cost is absent, its tokens are counted', () => {
    const m = measure({ ...green, llmCalls: [], cliRuns: [cli] });
    expect(m.costUsd).toBeNull();
    expect(m.inputTokens).toBe(5210);
    expect(m.outputTokens).toBe(300);
    expect(m.firstModelReplyMs).toBe(4_000);
  });

  it('a CLI run that did not report its input leaves the input tokens unmeasured, not zero', () => {
    const m = measure({ ...green, cliRuns: [{ ...cli, inputTokens: null }] });
    expect(m.inputTokens).toBeNull();
    expect(m.outputTokens).toBe(370);
  });

  it('an API call that answered without a price leaves the cost unmeasured, not zero', () => {
    const m = measure({
      ...green,
      llmCalls: green.llmCalls.map((l, i) => (i === 0 ? { ...l, costUsd: null } : l)),
    });
    expect(m.costUsd).toBeNull();
  });
});

// Décision de Quentin (30/09, #634) : « sources read » n'est plus jugé tant que
// #648 n'est pas fait, mais chaque ligne le DIT. Une ligne verte n'affirme rien
// sur les sources.
describe('an unverified check travels on every line of its scenario', () => {
  const SOURCES = {
    check: 'sources read',
    state: 'not verified',
    ticket: '#648',
  };

  it('a research trial that ran says sources read: not verified, whatever its verdict', async () => {
    const green = load('research-green');
    const w = world({ rootId: green.rootId, snapshots: [green], subjects: [CMB] });
    const line = await runTrial(scenarioById('research')!, w.deps, OPTS);
    expect(w.started).toHaveLength(1);
    expect(line.unverified).toEqual([expect.objectContaining(SOURCES)]);
  });

  // Ce que la passe 2 de revue a fait voir sur un essai RÉEL : le 30/09, le
  // délégué de `research` a appelé telegram_send_message — un message est parti
  // chez le propriétaire pendant un essai du banc. Le juge du scénario disait
  // vert ; la destination déclarée (`nothing`) le refuse désormais.
  it('the real research trial of 30/09 sent a Telegram message: red for that, whatever its judge says', async () => {
    const green = load('research-green');
    expect(scenarioById('research')!.judge(green, { subject: CMB })).not.toContain(
      'a send tool was called (telegram_send_message)',
    );
    const w = world({ rootId: green.rootId, snapshots: [green], subjects: [CMB] });
    const line = await runTrial(scenarioById('research')!, w.deps, OPTS);
    expect(line.verdict).toBe('red');
    expect(line.reasons).toContain('a send tool was called (telegram_send_message)');
  });

  it('a skipped trial says it too: the check is a property of the scenario, not of a green run', async () => {
    const busy: ForeignActivity = {
      jobs: [
        {
          id: '5e3c1a90-0000-4000-8000-000000000000',
          status: 'processing',
          channel: 'telegram',
          agentSlug: 'alfred',
        },
      ],
      lastChatMs: null,
    };
    const green = load('research-green');
    const w = world({ rootId: green.rootId, snapshots: [green], foreign: [busy] });
    const line = await runTrial(scenarioById('research')!, w.deps, OPTS);
    expect(line.verdict).toBe('skipped');
    expect(line.unverified).toEqual([expect.objectContaining(SOURCES)]);
  });

  it('a scenario that verifies everything carries no unverified check', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(line.unverified).toEqual([]);
  });
});

// Le catalogue du 17/10 : un sujet calibré, les outils du produit, le chemin gardé.
describe('workflow trial: subjects, product tools and the path', () => {
  it('a research scenario with no calibrated subject is SKIPPED with the reason and the ticket; nothing starts', async () => {
    const green = load('research-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    const line = await runTrial(scenarioById('research')!, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line.verdict).toBe('skipped');
    expect(line.reasons).toEqual([
      'no calibrated research subject (kind research) in packages/bench/subjects/research-subjects.json: the trial does not run on a subject models know from memory (#776)',
    ]);
    expect(line.subject).toBeNull();
  });

  it('a calibrated subject goes into the request word for word, and the line names it', async () => {
    const green = load('research-green');
    const w = world({ rootId: green.rootId, snapshots: [green], subjects: [CMB] });
    const line = await runTrial(scenarioById('research')!, w.deps, OPTS);
    expect(w.started).toEqual([
      'Trouve sur le web la réponse à cette question, et donne tes sources avec leurs liens : la découverte du fond diffus cosmologique : qui, quand, comment',
    ]);
    expect(line.subject).toBe('test-cmb');
  });

  it('a subject of the other kind is no subject: the deep research is skipped, the simple one runs', async () => {
    const green = load('research-green');
    const w = world({ rootId: green.rootId, snapshots: [green], subjects: [CMB] });
    const deep = await runTrial(scenarioById('deep-research-report')!, w.deps, OPTS);
    expect(deep.verdict).toBe('skipped');
    expect(deep.reasons[0]).toMatch(/^no calibrated research subject \(kind deep-research\)/);
  });

  it('an unreadable subjects file is an ERROR line with its words, never a skip or a default subject', async () => {
    const green = load('research-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    w.deps.subjects = () => {
      throw new Error('workflow_subjects_unreadable: x is not JSON');
    };
    const line = await runTrial(scenarioById('research')!, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line.verdict).toBe('error');
    expect(line.reasons).toEqual([
      'the trial could not be prepared: workflow_subjects_unreadable: x is not JSON',
    ]);
  });

  it.each(['file', 'word-create', 'ppt-read-answer', 'html-edit'])(
    '%s: no product tool of the scenario in the team SKIPS it with that reason; nothing starts',
    async (id) => {
      const green = load('question-green');
      const w = world({ rootId: green.rootId, snapshots: [green] });
      const line = await runTrial(scenarioById(id)!, w.deps, OPTS);
      expect(w.started).toEqual([]);
      expect(line.verdict).toBe('skipped');
      expect(line.reasons).toEqual([
        `no agent of this workspace has the product tool this scenario is about (${scenarioById(id)!.productTools!.tools.join(', ')})`,
      ]);
    },
  );

  it('the real file trial of 30/09 wrote the workbook with a Python script while xlsx tools were there: red, no xlsx write recorded', async () => {
    const after = load('file-red-approval');
    // Sans son approbation (et l'annulation qu'elle a causée) : il ne reste que le chemin.
    const done: TreeFacts = {
      ...after,
      approvals: [],
      jobs: after.jobs.map((j) => ({ ...j, status: 'completed' })),
    };
    const w = world({ rootId: after.rootId, snapshots: [done] });
    // Un dossier partagé vide : le classeur du 30/09 n'y est pas, et le banc
    // sait où il poserait ses fichiers (un espace sans dossier lève, #4).
    const shared = mkdtempSync(join(tmpdir(), 'wf-trial-3009-'));
    w.deps.env = async (startedMs) => ({
      workspaceRoots: [shared],
      teamTools: ['xlsx_create', 'xlsx_read', 'xlsx_set_cell', 'xlsx_set_range'],
      services: {},
      unlistedMcpServers: [],
      startedMs,
    });
    const line = await runTrial(scenarioById('file')!, w.deps, OPTS);
    expect(line.verdict).toBe('red');
    // Le classeur a été écrit par python (run_command) : aucune écriture d'un
    // outil xlsx n'est enregistrée (un essai d'avant #779 n'en enregistre
    // aucune, et un script n'en laisse jamais) : rouge, jamais vert.
    expect(line.reasons.filter((r) => r.startsWith('product tool available'))).toEqual([
      'product tool available, not used: no write of nodal-bench/ventes-bench.xlsx by xlsx_create, xlsx_set_range is recorded with the bytes it wrote',
    ]);
  });

  it('the line keeps the path: every tool by name and in order, per job, and the teammate delegated to', async () => {
    const after = load('file-red-approval');
    const w = world({ rootId: after.rootId, snapshots: [beforeCancel(after)], afterCancel: after });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(line.toolCalls).toBe(9);
    expect(line.path).toEqual([
      {
        job: '75bbf3d0',
        agent: 'alfred',
        parent: null,
        tools: ['skill_view', 'load_tools', 'assign_researcher'],
      },
      {
        job: '074e7161',
        agent: 'researcher',
        parent: '75bbf3d0',
        tools: [
          'skill_view',
          'file_write',
          'load_tools',
          'run_command',
          'run_command',
          'run_command',
        ],
      },
    ]);
    expect(line.delegatedTo).toEqual(['researcher']);
  });

  it('the line classifies the links of the answer: on the real research trial, the Nobel page alone unseen', async () => {
    const green = load('research-green');
    const w = world({ rootId: green.rootId, snapshots: [green], subjects: [CMB] });
    const line = await runTrial(scenarioById('research')!, w.deps, OPTS);
    expect(line.links).toHaveLength(15);
    expect(line.links.filter((l) => !l.seen).map((l) => l.url)).toEqual([
      'nobelprize.org/prizes/physics/1978/summary',
    ]);
  });

  it('a skipped line records an empty path, not a missing one: nothing ran', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    const line = await runTrial(scenarioById('file')!, w.deps, OPTS);
    expect(line).toMatchObject({ verdict: 'skipped', path: [], delegatedTo: [], links: [] });
  });
});
