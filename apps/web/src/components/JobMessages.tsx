// Server-renderable component — shows LLM conversation messages

type Message = Record<string, unknown>;

function roleLabel(role: unknown): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return String(role ?? 'unknown');
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') return b['text'];
          if (b['type'] === 'tool_use')
            return `[tool_use: ${String(b['name'] ?? '')} → ${JSON.stringify(b['input']).slice(0, 120)}]`;
          if (b['type'] === 'tool_result')
            return `[tool_result: ${JSON.stringify(b['content']).slice(0, 120)}]`;
        }
        return JSON.stringify(block).slice(0, 200);
      })
      .join('\n');
  }
  return JSON.stringify(content).slice(0, 400);
}

export default function JobMessages({ messages }: { messages: Message[] }) {
  if (!messages || messages.length === 0) {
    return <p className="text-xs text-neutral-600">No messages recorded yet.</p>;
  }

  return (
    <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
      {messages.map((msg, i) => {
        const role = msg['role'];
        const text = extractText(msg['content']);
        const isAssistant = role === 'assistant';
        return (
          <div
            key={i}
            className={`rounded-lg p-3 border text-xs font-mono whitespace-pre-wrap leading-relaxed ${
              isAssistant
                ? 'bg-neutral-900 border-neutral-800/50 text-neutral-300'
                : 'bg-neutral-950 border-neutral-800/30 text-neutral-500'
            }`}
          >
            <span
              className={`inline-block text-[10px] font-semibold uppercase tracking-wider mb-1.5 ${
                isAssistant ? 'text-violet-400' : 'text-neutral-600'
              }`}
            >
              {roleLabel(role)}
            </span>
            <div>{text}</div>
          </div>
        );
      })}
    </div>
  );
}
