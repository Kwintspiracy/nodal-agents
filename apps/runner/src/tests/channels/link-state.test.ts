// link-state.test.ts — the state of a channel's link, for every channel, from
// what its own library reports: refused for good, lost for now, back.
//
// Table-driven over the channels: each driver feeds the REAL manager or
// gateway the signal its library gives (a fake Telegram API at `fetch`, a fake
// Slack socket calling the manager's hooks with the Web API's typed platform
// error, a fake discord.js Client emitting its gateway events, a fake WhatsApp
// socket emitting its statuses). The state is read back from
// connection_states, where the dashboard reads it.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { channelBindings, connectionStates, readConnectionState } from '@nodal-agents/db';
import { channelConnectionId, type ConnectionState } from '@nodal-agents/shared';
import { ErrorCode as WebApiErrorCode } from '@slack/web-api';
import type { WhatsAppHandle, WhatsAppStatus } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import type { SlackSocketHandle, SlackSocketOpts } from '../../channels/slack/socket.ts';

// ─── A discord.js Client that keeps the listeners the gateway registers ──────
const discord = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  login: null as null | (() => Promise<string>),
}));
vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  class FakeClient {
    user = { id: 'bot-user-1', tag: 'bot#1' };
    channels = { fetch: async () => null };
    on(event: string, listener: (...args: unknown[]) => void): this {
      discord.listeners.set(event, listener);
      return this;
    }
    login(): Promise<string> {
      return discord.login ? discord.login() : Promise.resolve('ok');
    }
    destroy(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, Client: FakeClient };
});

const { startDiscordGateway } = await import('../../channels/discord/gateway.ts');
const { startSlackManager } = await import('../../channels/slack/manager.ts');
const { startWhatsAppManager } = await import('../../channels/whatsapp/manager.ts');
const { runTelegramPoller } = await import('../../telegram/poller.ts');
const { DiscordjsErrorCodes, Events, GatewayCloseCodes } = await import('discord.js');

const env = {
  WORKER_SECRET: 's',
  APP_URL: 'http://localhost:3099',
  PORT: 3099,
} as unknown as RunnerEnv;

let db: TestDb;
let agentId: string;
let entityId: string;

function deps(): RunnerDeps {
  return {
    db: db as unknown as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
}

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  const seed = await seedMinimal(db);
  agentId = seed.agentId;
  entityId = seed.entityId;
  await db.insert(channelBindings).values([
    {
      entityId,
      agentId,
      channel: 'slack',
      credentials: JSON.stringify({ botToken: 'xoxb-1', appToken: 'xapp-1' }),
      enabled: true,
    },
    {
      entityId,
      agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: 'session-1' }),
      enabled: true,
    },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(connectionStates);
});

async function stateOf(channel: string): Promise<ConnectionState> {
  return readConnectionState(db, { kind: 'channel', id: channelConnectionId(agentId, channel) });
}

/** The managers record without awaiting (an event handler): wait for the row. */
async function eventually(
  channel: string,
  state: ConnectionState['state'],
): Promise<ConnectionState> {
  for (let i = 0; i < 100; i++) {
    const s = await stateOf(channel);
    if (s.state === state && s.observedAt !== null) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  return stateOf(channel);
}

/** One channel's library, driven through the real manager. */
interface Driver {
  start(): Promise<void>;
  refuse(): Promise<void>;
  lose(): Promise<void>;
  recover(): Promise<void>;
  stop(): Promise<void>;
}

function telegramDriver(): Driver {
  // Each answer is one getUpdates; past the list, the poll is stopped.
  type Answer = (stop: () => void) => Response;
  const poll = async (answers: Answer[]) => {
    const controller = new AbortController();
    let i = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const answer = answers[i++];
      if (!answer) {
        controller.abort();
        throw new Error('stopped by the test');
      }
      return answer(() => controller.abort());
    });
    await runTelegramPoller({
      agentId,
      agentEntityId: entityId,
      botToken: '111:tok',
      botUsername: 'bot',
      startOffset: 0,
      signal: controller.signal,
      deps: deps(),
      env,
      longPollSeconds: 1,
    });
  };
  const json =
    (status: number, body: unknown): Answer =>
    () =>
      new Response(JSON.stringify(body), { status });
  return {
    start: async () => {},
    refuse: () => poll([json(401, { ok: false, description: 'Unauthorized' })]),
    lose: () => poll([json(502, { ok: false, description: 'Bad Gateway' })]),
    recover: () => poll([json(200, { ok: true, result: [] })]),
    stop: async () => {},
  };
}

function slackDriver(): Driver {
  let socket: SlackSocketOpts | null = null;
  let manager: ReturnType<typeof startSlackManager> | null = null;
  return {
    start: async () => {
      manager = startSlackManager(deps(), {
        env,
        refreshIntervalMs: 999_999,
        startSocket: (opts: SlackSocketOpts): SlackSocketHandle => {
          socket = opts;
          return { stop: async () => {} };
        },
      });
      await manager.refreshNow();
    },
    // What @slack/socket-mode raises from apps.connections.open for a revoked
    // token: a Web API platform error whose `data.error` is in its own
    // UnrecoverableSocketModeStartError list.
    refuse: async () =>
      socket!.onClosed?.(
        'start failed: An API error occurred: invalid_auth',
        Object.assign(new Error('An API error occurred: invalid_auth'), {
          code: WebApiErrorCode.PlatformError,
          data: { ok: false, error: 'invalid_auth' },
        }),
      ),
    lose: async () => socket!.onClosed?.('disconnected'),
    recover: async () => socket!.onConnected?.(),
    stop: async () => {
      await manager?.stop();
    },
  };
}

function discordDriver(): Driver {
  let gateway: ReturnType<typeof startDiscordGateway> | null = null;
  const emit = (event: string, ...args: unknown[]) => discord.listeners.get(event)!(...args);
  return {
    start: async () => {
      gateway = startDiscordGateway({
        agentId,
        agentEntityId: entityId,
        botToken: 't',
        deps: deps(),
        env,
      });
    },
    // discord.js emits shardDisconnect only for a close it will not retry.
    refuse: async () =>
      emit(Events.ShardDisconnect, { code: GatewayCloseCodes.AuthenticationFailed }, 0),
    lose: async () => emit(Events.ShardReconnecting, 0),
    recover: async () => emit(Events.ShardResume, 0, 0),
    stop: async () => {
      await gateway?.stop();
    },
  };
}

function whatsappDriver(): Driver {
  const events = new EventEmitter();
  let manager: ReturnType<typeof startWhatsAppManager> | null = null;
  const handle: WhatsAppHandle = {
    bindingKey: 'session-1',
    events: events as unknown as WhatsAppHandle['events'],
    getStatus: () => 'connecting',
    getIdentity: () => null,
    send: vi.fn(async () => 'id'),
    listGroups: vi.fn(async () => []),
  };
  const status = (s: WhatsAppStatus): void => {
    events.emit('status', s);
  };
  return {
    start: async () => {
      manager = startWhatsAppManager(deps(), {
        env,
        refreshIntervalMs: 999_999,
        ensureSocket: () => handle,
        closeSocket: () => {},
      });
      await manager.refreshNow();
    },
    refuse: async () => status('logged_out'),
    lose: async () => status('closed'),
    recover: async () => status('open'),
    stop: async () => {
      await manager?.stop();
    },
  };
}

const DRIVERS: Array<[channel: string, make: () => Driver]> = [
  ['telegram', telegramDriver],
  ['slack', slackDriver],
  ['discord', discordDriver],
  ['whatsapp', whatsappDriver],
];

describe('the state of a channel link, the same for every channel @cap:parler-par-canal-externe/moteur', () => {
  it('the table covers every channel of CHANNELS', async () => {
    const { CHANNELS } = await import('@nodal-agents/shared');
    expect(DRIVERS.map(([c]) => c).sort()).toEqual([...CHANNELS].sort());
  });

  for (const [channel, make] of DRIVERS) {
    it(`${channel}: refused for good is needs_reauth; lost for now is unreachable; back is working`, async () => {
      const driver = make();
      await driver.start();
      try {
        await driver.refuse();
        expect(await eventually(channel, 'needs_reauth')).toMatchObject({
          state: 'needs_reauth',
          cause: 'grant_refused',
        });

        await driver.lose();
        const lost = await eventually(channel, 'unreachable');
        expect(lost).toMatchObject({ state: 'unreachable', cause: 'provider_unavailable' });
        expect(lost.retryAfter).toBeInstanceOf(Date);

        await driver.recover();
        expect(await eventually(channel, 'working')).toMatchObject({
          state: 'working',
          cause: 'succeeded',
        });
      } finally {
        await driver.stop();
      }
    }, 30_000);
  }
});

describe('what each library says beyond the common three', () => {
  it('discord: a token refused at login (TokenInvalid) is needs_reauth; a disallowed intent is a missing right', async () => {
    discord.login = () =>
      Promise.reject(
        Object.assign(new Error('An invalid token was provided.'), {
          code: DiscordjsErrorCodes.TokenInvalid,
        }),
      );
    const gateway = startDiscordGateway({
      agentId,
      agentEntityId: entityId,
      botToken: 't',
      deps: deps(),
      env,
    });
    try {
      expect(await eventually('discord', 'needs_reauth')).toMatchObject({ cause: 'grant_refused' });
      discord.listeners.get(Events.ShardDisconnect)!(
        { code: GatewayCloseCodes.DisallowedIntents },
        0,
      );
      const s = await (async () => {
        for (let i = 0; i < 100; i++) {
          const st = await stateOf('discord');
          if (st.cause === 'rights_missing') return st;
          await new Promise((r) => setTimeout(r, 10));
        }
        return stateOf('discord');
      })();
      expect(s).toMatchObject({ state: 'needs_reauth', cause: 'rights_missing' });
      expect(s.detail).toContain('4014');
    } finally {
      discord.login = null;
      await gateway.stop();
    }
  });

  it('slack: a platform error outside the library’s unrecoverable list is the link lost for now', async () => {
    const driver = slackDriver();
    await driver.start();
    try {
      const { slackLinkSignal } = await import('../../channels/slack/socket.ts');
      expect(
        slackLinkSignal(
          'start failed',
          Object.assign(new Error('ratelimited'), {
            code: WebApiErrorCode.PlatformError,
            data: { error: 'ratelimited' },
          }),
        ),
      ).toMatchObject({ link: 'lost' });
    } finally {
      await driver.stop();
    }
  });
});
