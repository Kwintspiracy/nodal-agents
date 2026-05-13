// @nodal-agents/llm — message structure validation
// Ports the invariants from AgentOne/agent/resilience.py

import type { ModelMessage } from 'ai';
import { MessageStructureError } from './errors';

/**
 * Validates that a conversation history satisfies all tool-use invariants
 * before it is sent to an LLM provider.
 *
 * Invariants enforced (ported from resilience.py):
 *
 * 1. Every tool_call in an assistant message must have a matching tool_result
 *    in the immediately following message (role=tool), identified by toolCallId.
 *
 * 2. Every toolCallId is unique across the entire conversation — duplicates
 *    indicate a bookkeeping bug in the orchestrator.
 *
 * 3. The conversation must not end with an assistant message that contains
 *    unresolved tool calls (mid-flight state leaked into a POST).
 *
 * 4. Every tool result content block must be defined (not undefined/null
 *    in a way that would produce a structurally invalid message).
 *
 * Throws MessageStructureError with a code and context object.
 * Never retried — caller must fix the orchestrator.
 */
export function validateMessageStructure(messages: ModelMessage[]): void {
  // Collect all seen toolCallIds to detect duplicates (invariant 2)
  const seenToolCallIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    // noUncheckedIndexedAccess: messages[i] may be undefined per tsconfig
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'assistant') {
      const content = msg.content;

      // String content has no tool calls — nothing to validate
      if (typeof content === 'string') continue;

      const toolCallParts = content.filter((p) => p.type === 'tool-call');
      if (toolCallParts.length === 0) continue;

      // Invariant 2: duplicate toolCallId detection
      for (const part of toolCallParts) {
        if (seenToolCallIds.has(part.toolCallId)) {
          throw new MessageStructureError('duplicate_tool_use_id', {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            messageIndex: i,
          });
        }
        seenToolCallIds.add(part.toolCallId);
      }

      // Invariant 3: conversation cannot end on an assistant message with unresolved tool calls
      const isLastMessage = i === messages.length - 1;
      if (isLastMessage) {
        throw new MessageStructureError('unresolved_tail', {
          unresolvedIds: toolCallParts.map((p) => p.toolCallId),
          messageIndex: i,
        });
      }

      // Invariant 1: next message must be role=tool with matching results
      const next = messages[i + 1];
      if (!next || next.role !== 'tool') {
        throw new MessageStructureError('unmatched_tool_use', {
          unresolvedIds: toolCallParts.map((p) => p.toolCallId),
          messageIndex: i,
          nextRole: next?.role ?? 'none',
        });
      }

      // Build a set of result IDs from the tool message. AI SDK v6 widens
      // tool-message content to include ToolApprovalResponse parts (no
      // toolCallId/output) — we only care about tool-result parts here.
      const toolResultParts = next.content.filter((r) => r.type === 'tool-result');
      const resultIds = new Set(toolResultParts.map((r) => r.toolCallId));

      for (const part of toolCallParts) {
        if (!resultIds.has(part.toolCallId)) {
          throw new MessageStructureError('unmatched_tool_use', {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            messageIndex: i,
          });
        }
      }

      // Invariant 4: every tool result must have defined content. v6 stores
      // the result in `output` (a discriminated union) rather than a free
      // `result: unknown` field — undefined/null `output` means malformed.
      for (const resultPart of toolResultParts) {
        if (resultPart.output === undefined || resultPart.output === null) {
          throw new MessageStructureError('missing_tool_result_content', {
            toolCallId: resultPart.toolCallId,
            toolName: resultPart.toolName,
            messageIndex: i + 1,
          });
        }
      }
    }
  }
}
