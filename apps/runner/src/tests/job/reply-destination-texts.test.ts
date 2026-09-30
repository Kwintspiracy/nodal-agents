// reply-destination-texts.test.ts — no text shared by every job orders the
// answer through a channel send tool (#649, review of #657 pass 1).
//
// Where a job's reply goes is decided per job and said by the `delivery:` line
// of its Job context. A tool description or a system skill is read by EVERY
// job: an unconditional "deliver your answer with the send tool" in one of
// them re-invites, on a job whose reply is its result (MCP, API, the web), the
// exact gesture of #649. By enumeration, so a text added tomorrow is covered.

import { describe, it, expect } from 'vitest';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import {
  createTelegramSendMessageTool,
  createSendImageTool,
  createSendFileTool,
  createSendVideoTool,
  createSendAudioTool,
  createSendVoiceTool,
  createListConversationsTool,
} from '@nodal-agents/tools';
import { systemSkills } from '@nodal-agents/catalog';
import { unconditionalSendOrders } from '../send-orders.ts';

describe('shared texts defer the reply path to the delivery: line (#649) @cap:parler-par-canal-externe/moteur', () => {
  it('no tool description orders the answer through a send tool unconditionally', () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const tools = [
      ...registry.list(),
      createTelegramSendMessageTool(),
      createSendImageTool(),
      createSendFileTool(),
      createSendVideoTool(),
      createSendAudioTool(),
      createSendVoiceTool(),
      createListConversationsTool(),
    ] as Array<{ name: string; description: string }>;
    const found = tools
      .map((t) => ({ tool: t.name, orders: unconditionalSendOrders(t.description) }))
      .filter((f) => f.orders.length > 0);
    expect(found).toEqual([]);
  });

  it('no system skill orders the answer through a send tool unconditionally', () => {
    const found = systemSkills
      .map((s) => ({ skill: s.slug, orders: unconditionalSendOrders(s.content) }))
      .filter((f) => f.orders.length > 0);
    expect(found).toEqual([]);
  });

  it('the detector finds the orders #649 was made of', () => {
    // The texts as they stood on main 7fae63ae: each one must be caught, or
    // the two tests above prove nothing.
    for (const order of [
      'For content delivery to the user, use the appropriate delivery tool (`telegram_send_message`, `dashboard_publish`, etc.) — return_result carries no content.',
      'Whenever your task involves delivering an answer, emit `return_result` and the delivery tool(s) **in the same assistant turn** (parallel tool calls).',
    ]) {
      expect({ order, caught: unconditionalSendOrders(order).length > 0 }).toEqual({
        order,
        caught: true,
      });
    }
  });
});
