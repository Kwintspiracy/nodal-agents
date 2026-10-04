// elicitation.test.ts — un serveur MCP pose une QUESTION pendant un de ses
// appels (`elicitation/create`, mode formulaire), et Nodal y répond.
//
// Contre un VRAI serveur : la fixture `mcp-elicit-server.mjs`, construite avec
// le SDK officiel (`McpServer`), lancée en sous-processus stdio. Rien du SDK
// n'est simulé : ce que le serveur dit avoir reçu est la preuve.
//
// Ce que ce fichier tient :
//   - la capacité `{ elicitation: { form: {} } }` est annoncée par une
//     connexion de job (le SDK serveur refuse une question sans `form`) ;
//   - la question arrive à `ctx.requestUserInput`, rattachée à l'appel en
//     cours (outil, id d'appel), et la réponse revient AU SERVEUR, telle quelle,
//     pour `accept` comme pour `decline` ;
//   - sans personne pour répondre (`requestUserInput` absent), et pour une
//     question posée hors de tout appel : `cancel`, jamais un silence ;
//   - les images jointes (`_meta["nodal/attachments"]`) sont lues et validées,
//     une pièce invalide écartée sans perdre la question ;
//   - un serveur qui retire sa question interrompt le `signal` de la demande ;
//   - le délai d'un appel ne compte pas l'attente humaine, mais compte encore
//     le travail du serveur.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { ToolContext, UserInputRequest, UserInputResponse } from '@nodal-agents/tools';
import {
  createMcpTools,
  createLazyMcpTools,
  type McpToolOutput,
  type McpToolset,
} from '../index.ts';
import { ELICITATIONS_PER_CALL_MAX } from '@nodal-agents/shared';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-elicit-server.mjs', import.meta.url));

const OPTS = {
  transport: 'stdio' as const,
  command: process.execPath,
  args: [FIXTURE],
  env: {},
  slug: 'printer',
};

let toolsets: McpToolset[] = [];
const savedTimeout = process.env['MCP_CALL_TIMEOUT_MS'];

beforeEach(() => {
  toolsets = [];
});

afterEach(async () => {
  for (const t of toolsets) await t.close();
  if (savedTimeout === undefined) delete process.env['MCP_CALL_TIMEOUT_MS'];
  else process.env['MCP_CALL_TIMEOUT_MS'] = savedTimeout;
});

async function connect(): Promise<McpToolset> {
  const t = await createMcpTools(OPTS);
  toolsets.push(t);
  return t;
}

function tool(t: McpToolset, name: string) {
  const def = t.tools.find((d) => d.name === `printer__${name}`);
  if (!def) throw new Error(`no tool printer__${name}`);
  return def;
}

/** Un contexte d'outil minimal : ce que l'adaptateur lit, rien d'autre. */
function ctxWith(
  requestUserInput?: (req: UserInputRequest) => Promise<UserInputResponse>,
): ToolContext {
  return {
    toolCallId: 'call-print-1',
    ...(requestUserInput ? { requestUserInput } : {}),
  } as unknown as ToolContext;
}

/**
 * Le texte JSON que l'outil de la fixture rend : ce que le SERVEUR a reçu.
 * Un appel MCP rend l'enregistrement complet du résultat (`McpToolOutput`,
 * #665) ; la fixture y écrit un seul bloc texte.
 */
function received(output: unknown): unknown {
  const texts = (output as McpToolOutput).content.filter((b) => b.type === 'text');
  expect(texts).toHaveLength(1);
  return JSON.parse((texts[0] as { text: string }).text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('élicitation MCP, contre un vrai serveur stdio @cap:approuver-une-action/moteur', () => {
  it('une connexion de job annonce le mode formulaire au serveur', async () => {
    const t = await connect();
    const out = await tool(t, 'capabilities').execute({ purpose: 'check' }, ctxWith());
    expect(received(out)).toEqual({ elicitation: { form: {} } });
  });

  it('accept : la question arrive à la personne, sa réponse arrive au serveur', async () => {
    const t = await connect();
    const asked: UserInputRequest[] = [];
    const out = await tool(t, 'order').execute(
      { purpose: 'print the report' },
      ctxWith(async (req) => {
        asked.push(req);
        return { action: 'accept', content: { color: 'grayscale', copies: 2, duplex: true } };
      }),
    );
    expect(received(out)).toEqual({
      action: 'accept',
      content: { color: 'grayscale', copies: 2, duplex: true },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      serverSlug: 'printer',
      toolName: 'printer__order',
      toolCallId: 'call-print-1',
      message: 'How should "report.pdf" be printed?',
      attachments: [],
    });
    expect(asked[0]!.requestedSchema).toMatchObject({
      type: 'object',
      required: ['color', 'copies'],
      properties: { copies: { type: 'integer', minimum: 1, maximum: 5 } },
    });
  });

  it('decline : le serveur lit un refus, sans contenu', async () => {
    const t = await connect();
    const out = await tool(t, 'order').execute(
      { purpose: 'print' },
      ctxWith(async () => ({ action: 'decline' })),
    );
    expect(received(out)).toEqual({ action: 'decline', content: null });
  });

  it('la connexion paresseuse d’un job répond aussi', async () => {
    const t = createLazyMcpTools(OPTS, [
      { name: 'order', inputSchema: { type: 'object', properties: {} } },
    ]);
    toolsets.push(t);
    const out = await tool(t, 'order').execute(
      { purpose: 'print' },
      ctxWith(async () => ({ action: 'accept', content: { color: 'color', copies: 1 } })),
    );
    expect(received(out)).toEqual({ action: 'accept', content: { color: 'color', copies: 1 } });
  });

  it('personne pour répondre ici : le serveur reçoit cancel', async () => {
    const t = await connect();
    const out = await tool(t, 'order').execute({ purpose: 'print' }, ctxWith());
    expect(received(out)).toEqual({ action: 'cancel', content: null });
  });

  it('une question posée hors de tout appel reçoit cancel', async () => {
    const t = await connect();
    const asked: UserInputRequest[] = [];
    const ask = async (req: UserInputRequest): Promise<UserInputResponse> => {
      asked.push(req);
      return { action: 'accept', content: { color: 'color', copies: 1 } };
    };
    await tool(t, 'ask_later').execute({ purpose: 'x' }, ctxWith(ask));
    await sleep(300);
    const out = await tool(t, 'later_result').execute({ purpose: 'x' }, ctxWith(ask));
    expect(received(out)).toEqual({ action: 'cancel', content: null });
    expect(asked).toHaveLength(0);
  });

  it('les images jointes sont lues ; une pièce qui n’est pas une image est écartée, pas la question', async () => {
    const t = await connect();
    const asked: UserInputRequest[] = [];
    await tool(t, 'order').execute(
      { purpose: 'print', attach: true },
      ctxWith(async (req) => {
        asked.push(req);
        return { action: 'decline' };
      }),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.attachments).toEqual([
      expect.objectContaining({ mimeType: 'image/png', caption: 'Page 1 preview', byteSize: 70 }),
    ]);
  });

  /** Une demande qui ne répond jamais d'elle-même : elle attend l'interruption. */
  function waitForAbort(seen: { reason: unknown; aborted: boolean }) {
    return (req: UserInputRequest) =>
      new Promise<UserInputResponse>((resolve) => {
        req.signal.addEventListener('abort', () => {
          seen.aborted = true;
          seen.reason = req.signal.reason;
          resolve({ action: 'cancel' });
        });
      });
  }

  it('les libellés que le serveur donne à ses boutons arrivent avec la question', async () => {
    const t = await connect();
    const asked: UserInputRequest[] = [];
    await tool(t, 'order').execute(
      { purpose: 'print', actions: { accept: 'Print', decline: 'Not now' } },
      ctxWith(async (req) => {
        asked.push(req);
        return { action: 'decline' };
      }),
    );
    expect(asked[0]!.actions).toEqual({ accept: 'Print', decline: 'Not now' });
  });

  it('un libellé invalide est écarté et dit ; la question est posée quand même', async () => {
    const t = await connect();
    const asked: UserInputRequest[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await tool(t, 'order').execute(
        { purpose: 'print', actions: { accept: 'P'.repeat(80), decline: 'Cancel' } },
        ctxWith(async (req) => {
          asked.push(req);
          return { action: 'decline' };
        }),
      );
      expect(asked[0]!.actions).toEqual({ accept: null, decline: 'Cancel' });
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
        '[adapter-mcp] printer: the accept label of its question is ignored: is longer than 32 characters',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('un serveur qui retire sa question interrompt le signal de la demande', async () => {
    const t = await connect();
    // Une première question, répondue : celle qu'on retire ensuite n'est pas
    // la requête d'id 0, la seule dont le SDK 1.29.0 ignore l'annulation.
    await tool(t, 'order').execute(
      { purpose: 'print' },
      ctxWith(async () => ({ action: 'decline' })),
    );
    const seen = { aborted: false, reason: undefined as unknown };
    const out = await tool(t, 'order').execute(
      { purpose: 'print', serverTimeoutMs: 200, afterMs: 300 },
      ctxWith(waitForAbort(seen)),
    );
    expect(seen.aborted).toBe(true);
    // Retirée PAR LE SERVEUR (sa raison), avant la fin de l'appel.
    expect(String(seen.reason)).toMatch(/timed out/i);
    expect(received(out)).toEqual({ error: expect.stringMatching(/timed out/i) });
  });

  it('une question encore ouverte quand son appel se termine est interrompue', async () => {
    const t = await connect();
    // La première question du processus (id 0) : le serveur la retire, le SDK
    // ignore ce retrait — c'est la fin de l'appel qui l'interrompt.
    const seen = { aborted: false, reason: undefined as unknown };
    const out = await tool(t, 'order').execute(
      { purpose: 'print', serverTimeoutMs: 200 },
      ctxWith(waitForAbort(seen)),
    );
    expect(received(out)).toEqual({ error: expect.stringMatching(/timed out/i) });
    expect(seen.aborted).toBe(true);
    expect(String(seen.reason)).toMatch(/call is over/);
  });

  it('le délai d’appel ne compte pas l’attente humaine', async () => {
    process.env['MCP_CALL_TIMEOUT_MS'] = '400';
    const t = await connect();
    const out = await tool(t, 'order').execute(
      { purpose: 'print' },
      ctxWith(async () => {
        await sleep(1200);
        return { action: 'accept', content: { color: 'color', copies: 3 } };
      }),
    );
    expect(received(out)).toEqual({ action: 'accept', content: { color: 'color', copies: 3 } });
  });

  it('le délai d’appel compte encore le travail du serveur après la réponse', async () => {
    process.env['MCP_CALL_TIMEOUT_MS'] = '400';
    const t = await connect();
    await expect(
      tool(t, 'order').execute(
        { purpose: 'print', afterMs: 1500 },
        ctxWith(async () => ({ action: 'decline' })),
      ),
    ).rejects.toThrow(/timed out after 400ms/);
  });
});

// Revue Codex passe 3 de #660 : rien ne bornait le nombre de questions qu'un
// serveur pose pendant UN appel. Chacune pose une ligne, des images, une
// notification : un serveur bogué ou hostile les multipliait sans fin, hors de
// toute garde anti-boucle (invariant #8).
describe('un appel pose au plus ELICITATIONS_PER_CALL_MAX questions @cap:approuver-une-action/moteur', () => {
  it('les questions au-delà reçoivent une erreur qui dit pourquoi ; la personne n’en voit aucune', async () => {
    const t = await connect();
    const asked: UserInputRequest[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await tool(t, 'order').execute(
        { purpose: 'print', times: ELICITATIONS_PER_CALL_MAX + 2 },
        ctxWith(async (req) => {
          asked.push(req);
          return { action: 'accept', content: { color: 'color', copies: 1 } };
        }),
      );
      const replies = received(out) as Array<Record<string, unknown>>;
      expect(asked).toHaveLength(ELICITATIONS_PER_CALL_MAX);
      expect(
        replies.slice(0, ELICITATIONS_PER_CALL_MAX).every((r) => r['action'] === 'accept'),
      ).toBe(true);
      for (const r of replies.slice(ELICITATIONS_PER_CALL_MAX)) {
        expect(String(r['error'])).toContain(
          `at most ${ELICITATIONS_PER_CALL_MAX} questions during one tool call`,
        );
      }
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});
