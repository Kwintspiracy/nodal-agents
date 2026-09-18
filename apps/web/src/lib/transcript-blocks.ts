// transcript-blocks.ts — la lecture d'un message de transcript, bloc par bloc.
//
// Gère les blocs Anthropic (tool_use / tool_result, souligné) et ceux de l'AI
// SDK v4 (tool-call / tool-result, tiret) ; le runner persiste en v4, c'est
// donc le cas courant.
//
// Ce code vivait dans `components/JobMessages.tsx`, à côté du composant qui
// dessinait le transcript brut sur /jobs/[id]. Cette page rend maintenant la
// page d'un run (18/09) et le composant est parti avec elle ; la LECTURE, elle,
// sert toujours — `conversation-feed.ts` en tire les blocs de chaque tour. Elle
// vit donc dans `lib/`, où elle est ce qu'elle est : une fonction pure, sans
// une ligne de rendu.

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
