// runtime-block.test.ts — unit tests for buildRuntimeBlock + DeploymentContext
// integration into buildSystemPrompt.
//
// House rule: assert REAL rendered strings — not call counts.

import { describe, it, expect, beforeAll } from 'vitest';
import { buildRuntimeBlock, buildSystemPrompt } from '../system-prompt';
import type { DeploymentContext } from '../system-prompt';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { agents } from '@nodal-agents/db';
import type { Agent, AgentId, EntityId } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

// ─── buildRuntimeBlock unit tests ─────────────────────────────────────────────

describe('buildRuntimeBlock', () => {
  it('(i) loopback, no notes — renders correct heading and localhost guidance', () => {
    const d: DeploymentContext = {
      os: 'macOS',
      networkMode: 'loopback',
      authMode: 'local-trust',
    };
    const block = buildRuntimeBlock(d);

    expect(block).toContain('## Runtime');
    expect(block).toContain('macOS');
    expect(block).toContain('127.0.0.1');
    expect(block).toContain('localhost');
    expect(block).toContain('NEVER ask the user to expose a local service through a public tunnel');
    expect(block).toContain('loopback');
    expect(block).toContain('single-user instance on this machine');

    // Must NOT include LAN or container lines when not applicable
    expect(block).not.toContain('host.docker.internal');
    expect(block).not.toContain('LAN');
    expect(block).not.toContain('### Install notes');
  });

  it('(ii) lan with lanAddresses — renders LAN line with IPs', () => {
    const d: DeploymentContext = {
      os: 'Linux',
      networkMode: 'lan',
      authMode: 'local-auth',
      lanAddresses: ['192.168.1.42', '10.0.0.5'],
    };
    const block = buildRuntimeBlock(d);

    expect(block).toContain('## Runtime');
    expect(block).toContain('Linux');
    expect(block).toContain('LAN');
    expect(block).toContain('192.168.1.42');
    expect(block).toContain('10.0.0.5');
    expect(block).toContain('multiple users may share this instance');

    // No container note, no install notes
    expect(block).not.toContain('host.docker.internal');
    expect(block).not.toContain('### Install notes');
  });

  it('(iii) containerized — renders host.docker.internal line', () => {
    const d: DeploymentContext = {
      os: 'Linux',
      networkMode: 'loopback',
      authMode: 'local-trust',
      containerized: true,
    };
    const block = buildRuntimeBlock(d);

    expect(block).toContain('host.docker.internal');
    expect(block).toContain('instead of `127.0.0.1`');
  });

  it('(iv) installNotes present — renders ### Install notes section', () => {
    const d: DeploymentContext = {
      os: 'Windows',
      networkMode: 'loopback',
      authMode: 'local-trust',
      installNotes: 'ComfyUI runs on :8188 with no auth.',
    };
    const block = buildRuntimeBlock(d);

    expect(block).toContain('### Install notes (from the operator)');
    expect(block).toContain('ComfyUI runs on :8188 with no auth.');
  });

  it('installNotes whitespace-only is omitted', () => {
    const d: DeploymentContext = {
      os: 'Linux',
      networkMode: 'loopback',
      authMode: 'local-trust',
      installNotes: '   \n   ',
    };
    const block = buildRuntimeBlock(d);
    expect(block).not.toContain('### Install notes');
  });

  it('installNotes empty string is omitted', () => {
    const d: DeploymentContext = {
      os: 'Linux',
      networkMode: 'loopback',
      authMode: 'local-trust',
      installNotes: '',
    };
    const block = buildRuntimeBlock(d);
    expect(block).not.toContain('### Install notes');
  });

  // ─── Event Triggers, Brique 1: cron trigger_context line ─────────────────────

  it('renders the "Scheduled run of" line with the previous last_run when triggerContext.prevRunAt is set', () => {
    const d: DeploymentContext = { os: 'Linux', networkMode: 'loopback', authMode: 'local-trust' };
    const block = buildRuntimeBlock(d, {
      type: 'cron',
      scheduleName: 'Nightly digest',
      prevRunAt: '2026-07-01T09:00:00.000Z',
    });
    expect(block).toContain(
      '- Scheduled run of "Nightly digest". Previous run of this schedule: 2026-07-01T09:00:00.000Z.',
    );
  });

  it('renders the FIRST-run variant when triggerContext.prevRunAt is null', () => {
    const d: DeploymentContext = { os: 'Linux', networkMode: 'loopback', authMode: 'local-trust' };
    const block = buildRuntimeBlock(d, {
      type: 'cron',
      scheduleName: 'Nightly digest',
      prevRunAt: null,
    });
    expect(block).toContain(
      '- Scheduled run of "Nightly digest". This is the FIRST run of this schedule.',
    );
  });

  it('renders no "Scheduled run of" line when triggerContext is absent (non-cron regression)', () => {
    const d: DeploymentContext = { os: 'Linux', networkMode: 'loopback', authMode: 'local-trust' };
    const block = buildRuntimeBlock(d);
    expect(block).not.toContain('Scheduled run of');
  });
});

// ─── Regression: localhost reachability message ───────────────────────────────

describe('buildRuntimeBlock — tunnel regression', () => {
  it('always tells the agent localhost is directly reachable and never to tunnel', () => {
    const loopback: DeploymentContext = {
      os: 'macOS',
      networkMode: 'loopback',
      authMode: 'local-trust',
    };
    const lan: DeploymentContext = {
      os: 'Linux',
      networkMode: 'lan',
      authMode: 'local-auth',
      lanAddresses: ['192.168.1.1'],
    };

    for (const d of [loopback, lan]) {
      const block = buildRuntimeBlock(d);
      expect(block).toContain('127.0.0.1');
      expect(block).toContain('localhost');
      expect(block).toContain('NEVER');
      expect(block).toContain('ngrok');
      expect(block).toContain('cloudflared');
    }
  });

  it('switching networkMode flips the wording loopback ↔ LAN', () => {
    const lo = buildRuntimeBlock({
      os: 'Linux',
      networkMode: 'loopback',
      authMode: 'local-trust',
    });
    const lan = buildRuntimeBlock({
      os: 'Linux',
      networkMode: 'lan',
      authMode: 'local-auth',
      lanAddresses: [],
    });

    expect(lo).toContain('loopback');
    expect(lo).not.toContain('multiple users');

    expect(lan).toContain('LAN');
    expect(lan).toContain('multiple users may share this instance');
    expect(lan).not.toContain('single-user instance');
  });
});

// ─── buildSystemPrompt integration ───────────────────────────────────────────

describe('buildSystemPrompt — runtime block integration', () => {
  async function seedAgent(db: TestDb, entityId: string): Promise<Agent> {
    const [row] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'RT Test Agent',
        slug: `rt-test-${Date.now()}`,
        personality: 'You are a test agent.',
        role: 'agent',
      })
      .returning();

    return {
      id: row!.id as AgentId,
      name: row!.name,
      slug: row!.slug,
      role: 'agent',
      personality: row!.personality,
      entityId: entityId as EntityId,
      model: 'claude-sonnet-4-6-20260217',
      active: true,
      orchestratorMode: null,
      memoryTokenBudget: 0,
    };
  }

  async function seedEntity(db: TestDb) {
    const { users, entities } = await import('@nodal-agents/db');
    const [user] = await db
      .insert(users)
      .values({ email: `rt-${Date.now()}@ex.com` })
      .returning();
    const [entity] = await db
      .insert(entities)
      .values({ userId: user!.id, name: 'RT', slug: `rt-${Date.now()}` })
      .returning();
    return { userId: user!.id, entityId: entity!.id };
  }

  it('includes ## Runtime when jobContext.deployment is provided', async () => {
    const { entityId } = await seedEntity(db);
    const agent = await seedAgent(db, entityId);
    const deployment: DeploymentContext = {
      os: 'macOS',
      networkMode: 'loopback',
      authMode: 'local-trust',
    };
    const prompt = await buildSystemPrompt(agent, db, { origin: 'api', deployment });
    expect(prompt).toContain('## Runtime');
    expect(prompt).toContain('macOS');
  });

  it('does NOT include ## Runtime when jobContext has no deployment', async () => {
    const { entityId } = await seedEntity(db);
    const agent = await seedAgent(db, entityId);
    const prompt = await buildSystemPrompt(agent, db, { origin: 'api' });
    expect(prompt).not.toContain('## Runtime');
  });

  it('does NOT include ## Runtime when jobContext is omitted entirely', async () => {
    const { entityId } = await seedEntity(db);
    const agent = await seedAgent(db, entityId);
    const prompt = await buildSystemPrompt(agent, db);
    expect(prompt).not.toContain('## Runtime');
  });

  it('runtime block sits in the VOLATILE tail after the cache boundary (E1)', async () => {
    const { entityId } = await seedEntity(db);
    const agent = await seedAgent(db, entityId);
    const deployment: DeploymentContext = {
      os: 'Linux',
      networkMode: 'loopback',
      authMode: 'local-trust',
    };
    const prompt = await buildSystemPrompt(agent, db, { origin: 'api', deployment });

    const personalityIdx = prompt.indexOf('You are a test agent.');
    const builtinIdx = prompt.indexOf('## Built-in capabilities');
    const boundaryIdx = prompt.indexOf('[[[NODAL_SYSTEM_CACHE_BOUNDARY]]]');
    const runtimeIdx = prompt.indexOf('## Runtime');

    // E1: the live-timestamp runtime block moved to the VOLATILE tail so the
    // stable prefix (personality → built-in → skills) caches across jobs. Order
    // is now: personality < built-in < cache-boundary < runtime.
    expect(personalityIdx).toBeGreaterThanOrEqual(0);
    expect(builtinIdx).toBeGreaterThan(personalityIdx);
    expect(boundaryIdx).toBeGreaterThan(builtinIdx);
    expect(runtimeIdx).toBeGreaterThan(boundaryIdx);
  });

  it('surfaces jobContext.triggerContext as a "Scheduled run of" line end-to-end', async () => {
    const { entityId } = await seedEntity(db);
    const agent = await seedAgent(db, entityId);
    const deployment: DeploymentContext = {
      os: 'macOS',
      networkMode: 'loopback',
      authMode: 'local-trust',
    };
    const prompt = await buildSystemPrompt(agent, db, {
      origin: 'cron',
      deployment,
      triggerContext: { type: 'cron', scheduleName: 'Nightly digest', prevRunAt: null },
    });
    expect(prompt).toContain(
      '- Scheduled run of "Nightly digest". This is the FIRST run of this schedule.',
    );
  });
});

// ─── Projets de code dans le bloc Runtime (décision Quentin 25/08) ───────────
// Trois sessions de suite, l'agent root a cherché à l'aveugle une app qu'il
// aurait dû connaître. La section dit l'existence, l'emplacement ET le
// détenteur — le routage devient une lecture, plus une devinette.

describe('buildRuntimeBlock — code projects', () => {
  const base: DeploymentContext = {
    os: 'Windows',
    networkMode: 'loopback',
    authMode: 'local-trust',
  };

  it('rend chaque projet avec son chemin et ses détenteurs, + la consigne de délégation', () => {
    const block = buildRuntimeBlock({
      ...base,
      codeProjects: [
        {
          name: 'calorie-counter',
          path: 'C:/Users/kwint/Documents/Dev/outputs/calorie-counter',
          owners: ['Dev C', 'Lead-Dev'],
          lastActivityAt: '2026-08-25T02:00:00.000Z',
        },
        {
          name: 'water-intake',
          path: 'C:/Users/kwint/Documents/Dev/water-intake',
          owners: ['Dev C'],
          lastActivityAt: null,
        },
      ],
    });

    expect(block).toContain('### Code projects in this workspace');
    expect(block).toContain(
      '- **calorie-counter** — `C:/Users/kwint/Documents/Dev/outputs/calorie-counter` — worked on by: Dev C, Lead-Dev',
    );
    expect(block).toContain(
      '- **water-intake** — `C:/Users/kwint/Documents/Dev/water-intake` — worked on by: Dev C',
    );
    // La consigne qui change le comportement : déléguer plutôt que chercher.
    expect(block).toContain('DELEGATE');
    expect(block).toContain('do not hunt for it');
  });

  it('aucun projet → aucune section (jamais un en-tête vide)', () => {
    expect(buildRuntimeBlock(base)).not.toContain('Code projects');
    expect(buildRuntimeBlock({ ...base, codeProjects: [] })).not.toContain('Code projects');
  });
});
