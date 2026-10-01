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

  it('the detector finds the orders #649 was made of, and their rewordings', () => {
    // The texts as they stood on main 7fae63ae, then rewordings a future text
    // could use (review of #657, pass 2): each one must be caught, or the
    // tests above prove nothing.
    for (const order of [
      'For content delivery to the user, use the appropriate delivery tool (`telegram_send_message`, `dashboard_publish`, etc.) — return_result carries no content.',
      'Whenever your task involves delivering an answer, emit `return_result` and the delivery tool(s) **in the same assistant turn** (parallel tool calls).',
      'Deliver your output with send_file.',
      'You are not delegated: send your answer with telegram_send_message.',
      'Post the result through your send tool, as a separate message.',
      'Your response goes out via telegram_send_message.',
    ]) {
      expect({ order, caught: unconditionalSendOrders(order).length > 0 }).toEqual({
        order,
        caught: true,
      });
    }
  });

  it('the detector lets through what defers to the delivery: line or refuses the send', () => {
    for (const fine of [
      'When a send tool carries your reply (the `delivery:` line says so), emit it and `return_result` in the same turn.',
      'On a DELEGATED sub-task you have no delivery tool: your written reply is the delivery.',
      'Do not send your answer with telegram_send_message yourself.',
    ]) {
      expect({ fine, caught: unconditionalSendOrders(fine) }).toEqual({ fine, caught: [] });
    }
  });

  it('no system skill picks the reply path from where the request came from', () => {
    // The destination is said by the `delivery:` line; a skill that routes by
    // origin ("the conversation's channel") contradicts it on a dashboard task
    // that named a Telegram chat, or an MCP request (review of #657, pass 2).
    const byOrigin =
      /conversation's channel|ongoing conversation|request came from (Telegram|Discord|Slack|the dashboard|anywhere)/i;
    const found = systemSkills
      .map((s) => ({
        skill: s.slug,
        lines: s.content.split('\n').filter((l) => byOrigin.test(l)),
      }))
      .filter((f) => f.lines.length > 0);
    expect(found).toEqual([]);
  });
});
