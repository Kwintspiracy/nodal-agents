// Server-renderable component — shows LLM conversation messages.
// Handles both Anthropic-style blocks (tool_use / tool_result, underscore) and
// AI SDK v4 blocks (tool-call / tool-result, hyphen). Our runner persists in
// the v4 shape, so the hyphen variant is the common case.

type Message = Record<string, unknown>;

function roleLabel(role: unknown): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  if (role === 'tool') return 'Tool';
  return String(role ?? 'unknown');
}

export interface RenderedBlock {
  kind: 'text' | 'tool-call' | 'tool-result';
  text?: string;
  toolName?: string;
  toolCallId?: string;
  payload?: unknown;
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function blocksFromContent(content: unknown): RenderedBlock[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [{ kind: 'text', text: pretty(content) }];

  return content.map((block): RenderedBlock => {
    if (typeof block === 'string') return { kind: 'text', text: block };
    if (typeof block !== 'object' || block === null) {
      return { kind: 'text', text: pretty(block) };
    }
    const b = block as Record<string, unknown>;
    const type = b['type'];

    if (type === 'text' && typeof b['text'] === 'string') {
      return { kind: 'text', text: b['text'] };
    }

    // Anthropic legacy: { type: 'tool_use', name, input, id }
    // AI SDK v4:        { type: 'tool-call', toolName, args | input, toolCallId }
    if (type === 'tool_use' || type === 'tool-call') {
      return {
        kind: 'tool-call',
        toolName: String(b['name'] ?? b['toolName'] ?? 'unknown'),
        toolCallId: String(b['id'] ?? b['toolCallId'] ?? ''),
        payload: b['input'] ?? b['args'] ?? {},
      };
    }

    // Anthropic legacy: { type: 'tool_result', tool_use_id, content }
    // AI SDK v4:        { type: 'tool-result', toolCallId, toolName, result }
    // AI SDK v6:        { type: 'tool-result', toolCallId, toolName, output: { type, value } }
    if (type === 'tool_result' || type === 'tool-result') {
      const v6Output = b['output'];
      const v6Payload =
        v6Output && typeof v6Output === 'object' && 'value' in v6Output
          ? (v6Output as { value: unknown }).value
          : undefined;
      return {
        kind: 'tool-result',
        toolName: typeof b['toolName'] === 'string' ? b['toolName'] : undefined,
        toolCallId: String(b['tool_use_id'] ?? b['toolCallId'] ?? ''),
        payload: b['content'] ?? b['result'] ?? v6Payload ?? null,
      };
    }

    return { kind: 'text', text: pretty(block) };
  });
}

export default function JobMessages({ messages }: { messages: Message[] }) {
  if (!messages || messages.length === 0) {
    return <p className="text-xs text-ink-4">No messages recorded yet.</p>;
  }

  return (
    <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
      {messages.map((msg, i) => {
        const role = msg['role'];
        const blocks = blocksFromContent(msg['content']);
        const isAssistant = role === 'assistant';
        const isTool = role === 'tool';
        return (
          <div
            key={i}
            className={`rounded-lg p-3 border text-xs leading-relaxed ${
              isAssistant
                ? 'bg-paper border-rule-2 text-ink-2'
                : isTool
                  ? 'bg-ok-bg border-ok/30 text-ink-3'
                  : 'bg-canvas border-rule-2 text-ink-3'
            }`}
          >
            <span
              className={`inline-block text-[11px] font-semibold uppercase tracking-wider mb-1.5 ${
                isAssistant ? 'text-run' : isTool ? 'text-ok' : 'text-ink-4'
              }`}
            >
              {roleLabel(role)}
            </span>
            <div className="space-y-2">
              {blocks.map((block, j) => {
                if (block.kind === 'text') {
                  return (
                    <div key={j} className="font-mono whitespace-pre-wrap">
                      {block.text || <span className="text-ink-4 italic">(empty)</span>}
                    </div>
                  );
                }
                if (block.kind === 'tool-call') {
                  return (
                    <div key={j} className="border-l-2 border-run/30 pl-3 py-1 bg-run-bg rounded-r">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-run mb-1">
                        → call {block.toolName}
                      </p>
                      <pre className="font-mono text-[12px] text-ink-2 whitespace-pre-wrap break-words">
                        {pretty(block.payload)}
                      </pre>
                    </div>
                  );
                }
                // tool-result
                return (
                  <div key={j} className="border-l-2 border-ok/30 pl-3 py-1 bg-ok-bg rounded-r">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-ok mb-1">
                      ← result {block.toolName ? `from ${block.toolName}` : ''}
                    </p>
                    <pre className="font-mono text-[12px] text-ink-2 whitespace-pre-wrap break-words">
                      {pretty(block.payload)}
                    </pre>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
