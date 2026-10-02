import { describe, it, expect, vi } from 'vitest';
import type { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpToolToToolDefinition, slugToPrefix } from '../tools.ts';
import { MCP_TOOL_OUTPUT_FORMAT } from '@nodal-agents/shared';
import type { McpToolDescriptor } from '../client.ts';

function clientWithCallTool(impl: () => unknown): Client {
  return { callTool: vi.fn(impl) } as unknown as Client;
}

const descriptor: McpToolDescriptor = {
  name: 'get_home',
  description: 'Return the home view',
  inputSchema: { type: 'object', properties: { detail: { type: 'boolean' } } },
  annotations: { readOnlyHint: true },
};

describe('slugToPrefix', () => {
  it('sanitises non-alphanumerics to underscores, lowercased', () => {
    expect(slugToPrefix('cogni-cortex')).toBe('cogni_cortex');
    expect(slugToPrefix('My Server')).toBe('my_server');
  });
});

describe('mcpToolToToolDefinition', () => {
  it('namespaces the tool name with the server slug', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      descriptor,
      'cogni-cortex',
    );
    expect(def.name).toBe('cogni_cortex__get_home');
  });

  it('does NOT let a server downgrade itself with readOnlyHint (MCP-001)', () => {
    // Annotations come FROM THE SERVER, so on a hostile one they are the
    // attacker's claim about themselves. Measured during the audit: a tool named
    // `purge_all_data`, described as deleting the whole workspace, carrying
    // `readOnlyHint: true`, was assigned riskLevel 'read' — which under
    // `destructive_gate` meant auto-approval. `destructiveHint` is still
    // honoured (it can only RAISE the level); readOnlyHint can no longer lower it.
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      descriptor,
      'c',
    );
    expect(def.riskLevel).toBe('write');
  });

  it('frames the server-supplied description as untrusted (SKILL-001)', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      descriptor,
      'cogni-cortex',
    );
    // The server's own text is preserved…
    expect(def.description).toContain('Return the home view');
    // …but never alone: it now carries its provenance, the same mitigation the
    // webhook envelope applies to external payloads.
    expect(def.description).toContain('cogni-cortex');
    expect(def.description).toContain('untrusted');
  });

  // The 500-char cap is gone (owner's decision, 02/10/2026): it cut legitimate
  // descriptions — hp-connector `request_print` (3 059 chars, its A4 / 15 mm page
  // rule at char 1 575), Blender (up to 970), Supabase `search_docs` (1 809). The
  // SKILL-001 mitigation that stays is the provenance frame, as for webhook
  // payloads; Hermes does not cut descriptions either (tools/mcp_tool_schema.py:191).
  it.each([970, 1_809, 3_059])(
    'passes a %i-char description whole, still framed as untrusted',
    (size) => {
      const head = 'HEAD-MARKER ';
      const tail = ' TAIL-MARKER';
      const long = head + 'x'.repeat(size - head.length - tail.length) + tail;
      const def = mcpToolToToolDefinition(
        clientWithCallTool(() => ({ content: [] })),
        { ...descriptor, description: long },
        'c',
      );
      expect(def.description).toContain(long);
      expect(def.description).not.toContain('truncated');
      expect(def.description).toContain('untrusted');
    },
  );

  it('maps destructiveHint → riskLevel destructive', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      { name: 'wipe', annotations: { destructiveHint: true } },
      'c',
    );
    expect(def.riskLevel).toBe('destructive');
  });

  it('defaults riskLevel to write when there are no annotations', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      { name: 'mystery' },
      'c',
    );
    expect(def.riskLevel).toBe('write');
  });

  // execute() returns the RECORD (what tool_calls keeps); toModelOutput() is
  // what the model reads (result.ts). Both are asserted: a result is right only
  // when the row keeps it AND the model reads it.
  const read = (def: { toModelOutput?: (o: unknown) => string }, out: unknown): string => {
    if (!def.toModelOutput) throw new Error('an MCP tool declares no toModelOutput');
    return def.toModelOutput(out);
  };

  it('execute() dispatches with the original un-prefixed name; the model reads the text block', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
    }));
    const client = { callTool } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'cogni-cortex');

    const out = await def.execute({ detail: true }, {} as never);

    expect(callTool).toHaveBeenCalledWith(
      { name: 'get_home', arguments: { detail: true } },
      undefined,
      // The call's bound is the adapter's own clock (signal, restarted on
      // progress, paused while a person answers a question): proven against a
      // real server in elicitation.test.ts.
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onprogress: expect.any(Function),
      }),
    );
    expect(out).toEqual({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [{ type: 'text', text: 'hi' }],
    });
    // The model reads the text itself, not a block wrapper.
    expect(read(def, out)).toBe('hi');
  });

  it('structuredContent with no text block: kept, and read by the model serialized', async () => {
    // Airtable & other structured-output servers return data here while the SDK
    // defaults `content` to []. Regression for live job c66f1db0 (empty results).
    const records = [{ id: 'rec1', fields: { Name: 'A' } }];
    const client = {
      callTool: vi.fn(async () => ({ content: [], structuredContent: { records } })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'airtable');

    const out = await def.execute({ baseId: 'app1', tableId: 'JobList' }, {} as never);

    expect(out).toEqual({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [],
      structuredContent: { records },
    });
    expect(read(def, out)).toBe(JSON.stringify({ records }));
  });

  it('an image block is recorded as its type and size, and said to the model', async () => {
    const blocks = [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }];
    const client = {
      callTool: vi.fn(async () => ({ content: blocks })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'c');

    const out = await def.execute({}, {} as never);

    expect(out).toEqual({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [{ type: 'image', mimeType: 'image/png', bytes: 3 }],
    });
    expect(read(def, out)).toBe(
      "[Image returned by the tool (image/png, 3 B): not passed to you. Nodal does not give a tool's image to the model.]",
    );
  });

  it('execute() throws when the MCP tool returns isError', async () => {
    const client = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'c');

    await expect(def.execute({}, {} as never)).rejects.toThrow(/boom/);
  });

  // ── audit#2026-07-07 F6: cap unbounded MCP tool results ──────────────────

  it('an oversized text result is truncated with a trailing marker, on the row and for the model (F6)', async () => {
    const huge = 'x'.repeat(60_000);
    const client = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: huge }],
        isError: false,
      })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'c');

    const out = await def.execute({}, {} as never);
    const model = read(def, out);

    // Capped, not the full 60k, and clearly marked as truncated (not silently cut).
    expect(model.length).toBeLessThan(60_000);
    expect(model).toContain('[...truncated at 50000 chars');
    expect(model.startsWith('x'.repeat(1000))).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(60_000);
  });

  it('a text result under the cap is not truncated', async () => {
    const small = 'hello world';
    const client = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: small }], isError: false })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'c');

    const out = await def.execute({}, {} as never);

    expect(read(def, out)).toBe(small);
  });

  it('an oversized structuredContent is wrapped with truncated:true instead of corrupting the JSON (F6)', async () => {
    const records = Array.from({ length: 5000 }, (_, i) => ({
      id: `rec${i}`,
      fields: { Name: `Record number ${i}`, Notes: 'padding '.repeat(10) },
    }));
    const client = {
      callTool: vi.fn(async () => ({ content: [], structuredContent: { records } })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'airtable');

    const out = (await def.execute({}, {} as never)) as {
      structuredContent: { truncated: boolean; originalLength: number; preview: string };
    };

    expect(out.structuredContent.truncated).toBe(true);
    expect(out.structuredContent.originalLength).toBeGreaterThan(50_000);
    expect(out.structuredContent.preview.length).toBe(50_000);
    // The preview must still be a prefix of the real serialized JSON — never
    // fabricated content — even though it is not parseable on its own.
    expect(JSON.stringify({ records }).startsWith(out.structuredContent.preview)).toBe(true);
    // The model reads the wrapper, which says it was truncated.
    expect(read(def, out)).toContain('"truncated":true');
  });

  it('a structuredContent under the cap is kept as is', async () => {
    const records = [{ id: 'rec1', fields: { Name: 'A' } }];
    const client = {
      callTool: vi.fn(async () => ({ content: [], structuredContent: { records } })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'airtable');

    const out = await def.execute({}, {} as never);

    expect(out).toEqual({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [],
      structuredContent: { records },
    });
  });

  it('many image blocks are recorded as their sizes, never their bytes (F6)', async () => {
    const blocks = Array.from({ length: 200 }, () => ({
      type: 'image',
      data: 'iVBOR'.repeat(200),
      mimeType: 'image/png',
    }));
    const client = {
      callTool: vi.fn(async () => ({ content: blocks })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'c');

    const out = (await def.execute({}, {} as never)) as { content: unknown[] };

    expect(out.content).toHaveLength(200);
    expect(JSON.stringify(out)).not.toContain('iVBOR');
    expect(read(def, out).split('\n')).toHaveLength(200);
  });

  it('a block cut by what is LEFT of the budget says the length it was cut at', async () => {
    const client = {
      callTool: vi.fn(async () => ({
        content: [
          { type: 'text', text: 'a'.repeat(30_000) },
          { type: 'text', text: 'b'.repeat(30_000) },
        ],
      })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'c');

    const out = (await def.execute({}, {} as never)) as { content: Array<{ text: string }> };
    const second = out.content[1]!.text;
    const kept = second.match(/^b*/)![0].length;

    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(30_000);
    // The marker names the cut that was applied, not the overall cap.
    expect(second).toContain(`[...truncated at ${kept} chars`);
  });

  it('many text blocks under the per-block cap are bounded as a whole on the row, and the cut is said (F6)', async () => {
    // 200 blocks of 49k: each passes a per-block cap, together ~10 MB.
    const blocks = Array.from({ length: 200 }, (_, i) => ({
      type: 'text',
      text: `${i}:`.padEnd(49_000, 'y'),
    }));
    const client = {
      callTool: vi.fn(async () => ({ content: blocks })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'c');

    const out = (await def.execute({}, {} as never)) as {
      content: Array<{ type: string; count?: number; text?: string }>;
    };

    // The row stays within the cap (plus the markers that say so).
    expect(JSON.stringify(out).length).toBeLessThan(51_000);
    // The first block survives; the rest is counted, not lost in silence.
    expect(out.content[0]?.text?.startsWith('0:')).toBe(true);
    const omitted = out.content.at(-1)!;
    expect(omitted.type).toBe('omitted');
    expect(omitted.count).toBe(200 - (out.content.length - 1));
    expect(read(def, out)).toContain(
      `[${omitted.count} more content blocks not kept: the result exceeded 50000 chars.]`,
    );
  });

  it('the 2024-10-07 result shape (`toolResult`) is read, never reported as empty', async () => {
    // CompatibilityCallToolResultSchema in the SDK: a pre-2025 server answers
    // `{ toolResult }`; the SDK's loose result schema keeps the key and
    // defaults `content` to [].
    const client = {
      callTool: vi.fn(async () => ({ content: [], toolResult: { temperature: 21 } })),
    } as unknown as Client;
    const def = mcpToolToToolDefinition(client, descriptor, 'legacy');

    const out = await def.execute({}, {} as never);

    expect(out).toEqual({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [],
      toolResult: { temperature: 21 },
    });
    expect(read(def, out)).toBe('{"temperature":21}');
  });
});

// ─── Stated purpose ──────────────────────────────────────────────────────────
//
// Before this, `toolInput.purpose` was undefined for EVERY MCP tool — no
// discovered tool declares that field — so the approval card printed "Purpose
// not specified by the agent." on 100% of MCP approvals. Reported live, with
// the only reasonable conclusion: "je ne les approuverai pas".

describe('purpose injection', () => {
  const shapeOf = (def: { inputSchema: unknown }) =>
    (def.inputSchema as { shape: Record<string, unknown> }).shape;

  it('adds a REQUIRED purpose to a discovered tool', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      descriptor,
      'cogni-cortex',
    );

    // Present in the schema the LLM sees...
    expect(Object.keys(shapeOf(def))).toContain('purpose');
    // ...and genuinely required: an omitted purpose must not validate, or a
    // model under pressure simply drops it and we are back to the bug.
    const parsed = (def.inputSchema as z.ZodTypeAny).safeParse({ detail: true });
    expect(parsed.success).toBe(false);
  });

  it("does not forward purpose to the server — it is the product's field", async () => {
    let sent: unknown;
    const callTool = vi.fn(async (req: unknown) => {
      sent = req;
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const def = mcpToolToToolDefinition({ callTool } as unknown as Client, descriptor, 'c');

    await def.execute({ detail: true, purpose: 'Vérifier le CHANGELOG' }, {} as never);

    // The server never declared `purpose`; a strict server would reject it.
    expect(sent).toEqual({ name: 'get_home', arguments: { detail: true } });
  });

  it('KEEPS a purpose the server itself declares, and does not re-describe it', async () => {
    // The dangerous case: stripping unconditionally would delete a real
    // argument the tool needs, and the call would silently do the wrong thing.
    const ownPurpose: McpToolDescriptor = {
      name: 'file_note',
      description: 'Note something',
      inputSchema: {
        type: 'object',
        properties: { purpose: { type: 'string', description: "the note's subject" } },
        required: ['purpose'],
      },
    };
    let sent: unknown;
    const callTool = vi.fn(async (req: unknown) => {
      sent = req;
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const def = mcpToolToToolDefinition({ callTool } as unknown as Client, ownPurpose, 'c');

    await def.execute({ purpose: 'quarterly report' }, {} as never);

    expect(sent).toEqual({ name: 'file_note', arguments: { purpose: 'quarterly report' } });
    // Et il le DIT : la porte d'approbation doit savoir que deux purposes
    // différents font deux appels différents (revue Codex de #492).
    expect(def.purposeIsArgument).toBe(true);
  });

  it('a purpose WE added is the approval sentence: the definition does not claim it as an argument', () => {
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      descriptor,
      'c',
    );
    expect(def.purposeIsArgument).toBeUndefined();
  });

  it('leaves a non-object input schema alone rather than forcing one', () => {
    const scalar: McpToolDescriptor = {
      name: 'ping',
      description: 'Ping',
      inputSchema: { type: 'string' },
    };
    const def = mcpToolToToolDefinition(
      clientWithCallTool(() => ({ content: [] })),
      scalar,
      'c',
    );
    // No shape to extend. The card keeps its honest "did not say why" line
    // instead of the tool call failing validation forever.
    expect((def.inputSchema as { shape?: unknown }).shape).toBeUndefined();
  });
});
