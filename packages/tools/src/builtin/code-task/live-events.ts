// live-events.ts — turn a coding CLI's JSONL stream into tool_calls rows AS IT
// RUNS, instead of one row once the session ends.
//
// Why this file exists: `executeTool` writes its audit row AFTER the tool
// returns, so a `code_task` that runs for fifteen minutes leaves the Code tab
// empty for fifteen minutes — precisely when the owner wants to know whether it
// is progressing, went sideways, or even started. The runtime path already does
// the right thing (run-job.ts pairs tool_use → tool_result live); this brings
// the tool path to parity.
//
// Both CLIs emit one JSON object per line, but NOT the same shapes, so the two
// are normalised here rather than in the caller.

import { toolCalls } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { redactSecretsForAudit, redactSecretsInText } from '@nodal-agents/shared';

/**
 * Plafond par ligne d audit. Une sortie d outil peut faire des megaoctets (un
 * `Read` sur un gros fichier) ; l audit doit dire CE QUI s est passe, pas
 * archiver le contenu du depot.
 */
const MAX_OUTPUT_CHARS = 8_000;

export interface LiveToolEvent {
  /** The CLI's own id, used to pair a start with its result. */
  id: string;
  name: string;
  input: unknown;
  /** Present on the closing event only. */
  output?: string;
}

/**
 * Parse ONE stdout line into a tool event, or null when the line is not about a
 * tool (init banners, assistant text, usage totals).
 *
 * Returns `kind` so the caller can pair: a `use` opens, a `result` closes.
 */
export function parseLiveToolEvent(
  provider: 'claude' | 'codex',
  line: string,
): { kind: 'use' | 'result'; event: LiveToolEvent } | null {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // A non-JSON line is not an error here: this hook is best-effort
    // observability, and the authoritative parse still happens at the end.
    return null;
  }
  if (typeof evt !== 'object' || evt === null) return null;

  if (provider === 'claude') {
    // stream-json wraps tool use/result in an assistant/user message's content.
    const message = evt['message'] as Record<string, unknown> | undefined;
    const content = message?.['content'];
    if (!Array.isArray(content)) return null;
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (
        p['type'] === 'tool_use' &&
        typeof p['id'] === 'string' &&
        typeof p['name'] === 'string'
      ) {
        return { kind: 'use', event: { id: p['id'], name: p['name'], input: p['input'] } };
      }
      if (p['type'] === 'tool_result' && typeof p['tool_use_id'] === 'string') {
        const c = p['content'];
        return {
          kind: 'result',
          event: {
            id: p['tool_use_id'],
            name: '',
            input: undefined,
            output: typeof c === 'string' ? c : JSON.stringify(c ?? ''),
          },
        };
      }
    }
    return null;
  }

  // codex --json: item.started / item.completed carrying a command_execution or
  // file_change item. `id` is the item id, stable across the pair.
  const type = evt['type'];
  if (type !== 'item.started' && type !== 'item.completed') return null;
  const item = evt['item'] as Record<string, unknown> | undefined;
  if (!item || typeof item['id'] !== 'string' || typeof item['type'] !== 'string') return null;
  const itemType = item['type'];
  if (itemType !== 'command_execution' && itemType !== 'file_change') return null;

  if (type === 'item.started') {
    return { kind: 'use', event: { id: item['id'], name: itemType, input: item } };
  }
  return {
    kind: 'result',
    event: {
      id: item['id'],
      name: itemType,
      input: undefined,
      output: JSON.stringify(item).slice(0, 8000),
    },
  };
}

/**
 * Build the `onStdoutLine` handler that records a CLI's internal tool calls as
 * they happen.
 *
 * Pairing is by the CLI's own id, exactly like run-job.ts: an unmatched result
 * is dropped rather than guessed. Inserts are fire-and-forget — a failed audit
 * write must never take down the session it is auditing, so it warns and moves
 * on (the authoritative `cli_runs` row is written separately at the end).
 */
export function makeLiveToolRecorder(args: {
  db: AnyDrizzleDb;
  entityId: string | null;
  jobId: string;
  provider: 'claude' | 'codex';
}): (line: string) => void {
  const pending = new Map<string, { name: string; input: unknown; startedAt: number }>();

  return (line: string): void => {
    const parsed = parseLiveToolEvent(args.provider, line);
    if (!parsed) return;

    if (parsed.kind === 'use') {
      pending.set(parsed.event.id, {
        name: parsed.event.name,
        input: parsed.event.input,
        startedAt: Date.now(),
      });
      return;
    }

    const started = pending.get(parsed.event.id);
    if (!started) return;
    pending.delete(parsed.event.id);

    void args.db
      .insert(toolCalls)
      .values({
        entityId: args.entityId,
        jobId: args.jobId,
        // Same namespace as the runtime path, so ONE surface renders both and a
        // CLI-internal Read is never mistaken for a Nodal builtin.
        toolName: `cli:${started.name}`,
        toolInput: redactSecretsForAudit(started.input) as Record<string, unknown>,
        // La SORTIE aussi, et elle porte le vrai risque : redactSecretsForAudit
        // masque par NOM DE CHAMP, ce qui ne dit rien d un texte libre. Or ces
        // lignes-la n existaient pas avant — un code_task n ecrivait qu une
        // ligne finale. Enregistrer chaque appel interne fait entrer dans l
        // audit le contenu de chaque fichier lu, jeton compris. redactSecretsInText
        // masque les formes de credentials dans du texte, et rend la chaine
        // inchangee quand rien ne matche.
        toolOutput: redactSecretsInText((parsed.event.output ?? '').slice(0, MAX_OUTPUT_CHARS)),
        durationMs: Date.now() - started.startedAt,
        toolCallId: parsed.event.id,
      })
      .catch((err: unknown) => {
        console.warn(`[code-task] live tool_calls insert failed (job=${args.jobId}):`, err);
      });
  };
}
