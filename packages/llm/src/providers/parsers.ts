// parsers.ts — per-model-family native tool-call parsers
//
// Each parser extracts tool calls from the raw assistant message text in the
// model's native markup. Patterns follow the per-model-parser approach common
// in inference servers (vLLM and similar) — each agentic model family has its
// own trained tool-call markup, and the parser regex matches that markup.
//
// Philosophy: zero prompt modification. The LLM uses its trained format, we
// adapt at the parse step. See `tool-call-middleware.ts` for the wrapper.

import { randomUUID } from 'node:crypto';
import type { LanguageModelV3ToolCall } from '@ai-sdk/provider';
import { createNativeToolCallMiddleware, type NativeToolCallParser } from './tool-call-middleware';

function generateToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// ─── DeepSeek V3 / V3.1 / V4 — fullwidth Unicode markup ───────────────────────
// Format:
//   <｜tool▁calls▁begin｜>
//     <｜tool▁call▁begin｜>function<｜tool▁sep｜>name
//     ```json
//     {"arg": "val"}
//     ```
//     <｜tool▁call▁end｜>
//   <｜tool▁calls▁end｜>
//
// Special chars: ｜ = U+FF5C (fullwidth vertical bar), ▁ = U+2581 (lower one
// eighth block). DeepSeek tokenizer treats these as single tokens.

const DEEPSEEK_START_TOKEN = '<｜tool▁calls▁begin｜>';
// Groups: 1=kind (unused), 2=name, 3=args. Uses [\s\S] instead of /s flag
// for ES2017 compatibility (the apps/web tsconfig targets pre-ES2018).
const DEEPSEEK_PATTERN =
  /<｜tool▁call▁begin｜>([\s\S]*?)<｜tool▁sep｜>([\s\S]*?)\s*```json\s*([\s\S]*?)\s*```\s*<｜tool▁call▁end｜>/g;

export const deepseekNativeParser: NativeToolCallParser = (text) => {
  if (!text.includes(DEEPSEEK_START_TOKEN)) return { text, toolCalls: [] };

  const toolCalls: LanguageModelV3ToolCall[] = [];
  DEEPSEEK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DEEPSEEK_PATTERN.exec(text)) !== null) {
    const name = match[2]?.trim();
    const args = match[3]?.trim();
    if (!name) continue;
    toolCalls.push({
      type: 'tool-call',
      toolCallId: generateToolCallId(),
      toolName: name,
      input: args && args.length > 0 ? args : '{}',
    });
  }

  if (toolCalls.length === 0) return { text, toolCalls: [] };

  const startIdx = text.indexOf(DEEPSEEK_START_TOKEN);
  return {
    text: startIdx > 0 ? text.slice(0, startIdx).trim() : '',
    toolCalls,
  };
};

// ─── Kimi K2 / K2.5 / K2.6 — pipe-bracket markup ──────────────────────────────
// Format:
//   <|tool_calls_section_begin|>
//     <|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"arg":"val"}<|tool_call_end|>
//   <|tool_calls_section_end|>
//
// The tool-call id has form `<namespace>.<func_name>:<index>`. We extract the
// last segment before `:` as the function name and preserve the full id as
// the LanguageModel tool-call id (Kimi expects this id format in subsequent
// tool result messages).

const KIMI_START_TOKENS: readonly string[] = [
  '<|tool_calls_section_begin|>',
  '<|tool_call_section_begin|>', // singular variant some routers normalize to
];
// Groups: 1=full tool-call id (e.g. "functions.get_weather:0"), 2=args.
// Uses [\s\S] instead of /s flag for ES2017 compatibility.
const KIMI_PATTERN =
  /<\|tool_call_begin\|>\s*([^<]+:\d+)\s*<\|tool_call_argument_begin\|>\s*((?:(?!<\|tool_call_begin\|>)[\s\S])*?)\s*<\|tool_call_end\|>/g;

export const kimiNativeParser: NativeToolCallParser = (text) => {
  if (!KIMI_START_TOKENS.some((tok) => text.includes(tok))) {
    return { text, toolCalls: [] };
  }

  const toolCalls: LanguageModelV3ToolCall[] = [];
  KIMI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KIMI_PATTERN.exec(text)) !== null) {
    const fullId = match[1]?.trim();
    const args = match[2]?.trim();
    if (!fullId) continue;
    // "functions.get_weather:0" → "get_weather"; "get_weather:0" → "get_weather"
    const beforeColon = fullId.split(':')[0] ?? '';
    const name = beforeColon.split('.').pop() ?? '';
    if (name.length === 0) continue;
    toolCalls.push({
      type: 'tool-call',
      toolCallId: fullId,
      toolName: name,
      input: args && args.length > 0 ? args : '{}',
    });
  }

  if (toolCalls.length === 0) return { text, toolCalls: [] };

  let earliest = text.length;
  for (const tok of KIMI_START_TOKENS) {
    const idx = text.indexOf(tok);
    if (idx >= 0 && idx < earliest) earliest = idx;
  }
  return {
    text: earliest > 0 ? text.slice(0, earliest).trim() : '',
    toolCalls,
  };
};

// ─── XML-tagged JSON format — <tool_call>JSON</tool_call> ─────────────────────
// Format: <tool_call>{"name": "func", "arguments": {...}}</tool_call>
//
// Common XML-wrapped JSON format across multiple agentic model families
// (Qwen3-Coder, some GLM-4 variants, and other tag-based finetunes). Single
// regex covers them all.

const NODAL_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

export const nodalNativeParser: NativeToolCallParser = (text) => {
  if (!text.includes('<tool_call>')) return { text, toolCalls: [] };

  const toolCalls: LanguageModelV3ToolCall[] = [];
  NODAL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NODAL_PATTERN.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (!body) continue;

    let parsed: { name?: unknown; arguments?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      continue;
    }
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) continue;

    const argsString =
      parsed.arguments === undefined
        ? '{}'
        : typeof parsed.arguments === 'string'
          ? parsed.arguments
          : JSON.stringify(parsed.arguments);

    toolCalls.push({
      type: 'tool-call',
      toolCallId: generateToolCallId(),
      toolName: parsed.name,
      input: argsString,
    });
  }

  if (toolCalls.length === 0) return { text, toolCalls: [] };

  const startIdx = text.indexOf('<tool_call>');
  return {
    text: startIdx > 0 ? text.slice(0, startIdx).trim() : '',
    toolCalls,
  };
};

// ─── Public middlewares ───────────────────────────────────────────────────────

export const deepseekToolCallMiddleware = createNativeToolCallMiddleware(deepseekNativeParser);
export const kimiToolCallMiddleware = createNativeToolCallMiddleware(kimiNativeParser);
export const nodalToolCallMiddleware = createNativeToolCallMiddleware(nodalNativeParser);

/** Exported for unit testing — the middlewares are the public surface. */
export const __testing = {
  deepseekNativeParser,
  kimiNativeParser,
  nodalNativeParser,
};
