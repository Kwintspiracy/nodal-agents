// return-result-outcomes.test.ts — ce que le modèle lit quand il choisit
// l'issue d'un job : un résultat qui attend la décision d'une personne est
// LIVRÉ, pas bloqué.
//
// Le banc, sur l'intégration du lot 2 de la 0.9.5 (jobs VERT 015c478a,
// ROUGES fe14218d et 3031b319, même modèle, même sortie d'outil) : « Imprime ce
// court texte » ; Alfred crée la demande d'impression, que l'outil laisse EN
// ATTENTE d'un clic humain par conception ({status:"pending",
// approval:{required:true}}), puis rend `return_result {status:"blocked"}`, et
// le runner finalise en échec. Le socle venait de perdre les deux seules
// phrases qui présentaient « attendre une personne » comme une issue normale.
//
// Le choix du statut appartient au modèle (invariant #3 : la couche agent, pas
// le runtime). Un modèle simulé choisit ce qu'on lui dicte : un job exécuté ne
// prouve donc pas le choix. Ce qui se prouve, c'est ce qu'on lui DIT, lu dans
// le corps de la vraie requête LLM : la définition des deux issues dans la
// description de `return_result`, là où il les choisit, et la demi-phrase
// symétrique du socle. La vraie preuve du comportement est le banc `print`.
//
// Deux rôles (racine qui délègue, agent délégué) : la définition vaut pour tout
// job, pas pour l'impression ni pour Alfred.
//
// Revue A, passe 4 de #656 : la première version citait « a draft to send »,
// une attente qu'un modèle fabrique SANS aucun outil (l'envoi échoue, il écrit
// un brouillon et rend succès en citant la règle). L'attente est désormais un
// FAIT : un état qu'un outil a RENDU, et l'action demandée qui échoue ou n'a pu
// être appelée est `blocked`. Et l'attente se dit dans la réponse, parce que
// c'est la réponse d'un délégué que son orchestrateur reçoit (`summary` du
// record de délégation) : le second bloc le prouve sur une vraie délégation.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agents, agentAssignments } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('return-result-outcomes.test: no active LLM client');
      return active;
    },
  };
});

interface Captured {
  system: string;
  tools: Array<{ name: string; description?: string }>;
}

/** Un modèle qui rend succès au premier tour, et garde ce qu'on lui a envoyé. */
function capturingClient(captured: Captured[]): RunnerDeps['llmClient'] {
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      const prompt = options.prompt as Array<{ role: string; content: unknown }>;
      captured.push({
        system: prompt
          .filter((m) => m.role === 'system')
          .map((m) => String(m.content))
          .join('\n'),
        tools: ((options.tools ?? []) as Array<{ name: string; description?: string }>).map(
          (t) => ({ name: t.name, description: t.description }),
        ),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Done.',
          },
          {
            type: 'tool-call' as const,
            toolCallId: `tc-rr-${captured.length}`,
            toolName: 'return_result',
            input: JSON.stringify({ status: 'success' }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
});

function makeDeps(llmClient: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(llmClient);
  return {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

/** Les phrases qui définissent les deux issues, dans la description envoyée. */
const OUTCOME_DEFINITION = [
  'status="success" means you did everything that was yours to do',
  // L'attente est un fait rendu par un outil, jamais un état que le modèle
  // fabrique lui-même.
  'When a TOOL RETURNED a state waiting on a person',
  'the result is DELIVERED, not blocked',
  'write in your reply what waits, who decides and where',
  'on a delegated task, that reply is what your orchestrator reads',
  // La porte d'approbation de Nodal suspend seule : rien à déclarer.
  'An approval Nodal itself asks before a call suspends the run on its own',
  'status="blocked" means YOUR part could not be done',
  'the requested action itself failed or could not be called',
];

/** Une attente que le modèle peut fabriquer sans aucun outil : jamais un exemple. */
const SELF_MADE_WAIT = 'a draft to send';

/** La demi-phrase symétrique du socle (verify-before-done). */
const BASELINE_HALF = 'a state a tool returned as waiting on a person is delivered, not blocked';

describe('return_result tells the model that waiting on a person is delivered, not blocked @cap:approuver-une-action/moteur', () => {
  for (const role of ['orchestrator', 'agent'] as const) {
    it(`${role}: the real LLM request carries both outcomes in return_result and the baseline half-sentence`, async () => {
      await db.update(agents).set({ role }).where(eq(agents.id, seed.agentId));
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'api',
          task: 'Print this short text',
          status: 'pending',
          messages: [],
          chainCount: 0,
        })
        .returning();
      const captured: Captured[] = [];

      await executeJob(job!.id as JobId, makeDeps(capturingClient(captured)), testEnv);

      const first = captured[0];
      expect(first, 'the model was never called').toBeDefined();
      const rr = first!.tools.find((t) => t.name === 'return_result');
      expect(rr, 'return_result is not among the tools sent').toBeDefined();
      const missing = OUTCOME_DEFINITION.filter((p) => !rr!.description?.includes(p));
      expect(missing, 'phrases missing from the return_result description sent').toEqual([]);
      expect(rr!.description).not.toContain(SELF_MADE_WAIT);
      expect(first!.system).toContain(BASELINE_HALF);
    });
  }
});

// ─── Ce qui attend remonte à l'orchestrateur ─────────────────────────────────
//
// Un délégué n'a pas d'outil de livraison : sa réponse écrite EST le livrable,
// et le runner la rend au parent dans le `summary` du record de délégation
// (`delegationRecordFromOutcome`, execute.ts, puis `resumeDelegated`). Une
// attente rendue en succès ne perd donc pas son signal, à condition d'être
// écrite dans la réponse, ce que la description demande. Le test le prouve sur
// le vrai chemin : un vrai `assign_*`, un vrai enfant, et la requête LLM que le
// parent reçoit ensuite.

/** Un modèle qui joue un script, et garde le prompt de chaque appel. */
function scriptedClient(
  turns: Array<{ text?: string; call: { name: string; args: Record<string, unknown> } }>,
  prompts: unknown[],
): RunnerDeps['llmClient'] {
  let i = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const turn = turns[i] ?? turns[turns.length - 1]!;
      i++;
      return {
        content: [
          ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
          {
            type: 'tool-call' as const,
            toolCallId: `tc-script-${i}`,
            toolName: turn.call.name,
            input: JSON.stringify(turn.call.args),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    ...capturingClient([]),
    generateText: (args) =>
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
  };
}

/** Le `summary` que le parent lit dans le tool-result de sa délégation. */
function delegationSummary(prompt: unknown, toolName: string): string | undefined {
  for (const message of prompt as Array<{ role: string; content: unknown }>) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{
      type: string;
      toolName?: string;
      output?: { type: string; value: unknown };
    }>) {
      if (part.type !== 'tool-result' || part.toolName !== toolName) continue;
      const value = part.output?.value;
      if (typeof value !== 'string') continue;
      const record = JSON.parse(value) as { summary?: unknown };
      if (typeof record.summary === 'string') return record.summary;
    }
  }
  return undefined;
}

describe('a delegate that delivers a wait hands its orchestrator what waits @cap:organiser-equipe/moteur', () => {
  // Deux attentes de nature différente, rendues chacune par un outil : la
  // remontée ne dépend pas de ce qui attend.
  const WAITS = [
    'The print request is created and waits for you: click Approve on its card in the dashboard.',
    'The meeting invite is sent; it waits on Marc, who has to accept it in his calendar.',
  ];

  for (const wait of WAITS) {
    it(`the parent's next LLM request carries the child's wait: "${wait.slice(0, 30)}…"`, async () => {
      const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const [orchestrator] = await db
        .insert(agents)
        .values({
          entityId: seed.entityId,
          name: `Lead ${ts}`,
          slug: `lead-rro-${ts}`,
          personality: 'a lead',
          role: 'orchestrator',
          orchestratorMode: 'router',
          llmKeyId: seed.llmKeyId,
          active: true,
        })
        .returning();
      const [child] = await db
        .insert(agents)
        .values({
          entityId: seed.entityId,
          name: `Doer ${ts}`,
          slug: `doer-rro-${ts}`,
          personality: 'a doer',
          role: 'agent',
          llmKeyId: seed.llmKeyId,
          active: true,
        })
        .returning();
      await db.insert(agentAssignments).values({
        orchestratorId: orchestrator!.id,
        subAgentId: child!.id,
        entityId: seed.entityId,
      });
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: orchestrator!.id,
          channel: 'api',
          task: 'Get this done',
          status: 'pending',
          messages: [],
          chainCount: 0,
        })
        .returning();
      const assignTool = `assign_${child!.slug.replace(/-/g, '_')}`;
      const prompts: unknown[] = [];

      // [0] le parent délègue ; [1] l'enfant rend succès en disant ce qui
      // attend ; [2] le parent, repris, lit le record et conclut.
      const outcome = await executeJob(
        job!.id as JobId,
        makeDeps(
          scriptedClient(
            [
              { call: { name: assignTool, args: { task: 'Get this done' } } },
              { text: wait, call: { name: 'return_result', args: { status: 'success' } } },
              { text: 'Relayed.', call: { name: 'return_result', args: { status: 'success' } } },
            ],
            prompts,
          ),
        ),
        testEnv,
      );

      expect(outcome.status).toBe('completed');
      expect(prompts.length, 'the parent was never resumed').toBeGreaterThanOrEqual(3);
      expect(delegationSummary(prompts[2], assignTool)).toContain(wait);
    });
  }
});
