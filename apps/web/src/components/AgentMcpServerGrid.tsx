'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { setAgentMcpServerAssignmentAction, type AgentMcpServerRow } from '@/lib/actions.ts';

// Mirrors AgentConnectorGrid: a checkbox assigns the whole MCP server to
// the agent, expanding reveals a per-tool whitelist. enabledTools null =
// all tools enabled.

type McpServerState = {
  assigned: boolean;
  enabledTools: string[] | null;
};

interface McpServerGridProps {
  agentId: string;
  servers: AgentMcpServerRow[];
}

/**
 * Per-agent MCP server + tool whitelist. Behaviour preserved from when it
 * lived inline in AgentForm. Used by AgentForm (legacy edit) and
 * AgentComposer (new 3-col edit, "Knowledge" tab).
 */
export default function AgentMcpServerGrid({ agentId, servers }: McpServerGridProps) {
  const [states, setStates] = useState<Map<string, McpServerState>>(() => {
    const m = new Map<string, McpServerState>();
    for (const s of servers) {
      m.set(s.mcpServerId, { assigned: s.assigned, enabledTools: s.enabledTools });
    }
    return m;
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const debounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const persist = useCallback(
    (mcpServerId: string, assigned: boolean, enabledTools: string[] | null) => {
      const existing = debounceRef.current.get(mcpServerId);
      if (existing) clearTimeout(existing);
      const handle = setTimeout(() => {
        debounceRef.current.delete(mcpServerId);
        void setAgentMcpServerAssignmentAction(agentId, mcpServerId, assigned, enabledTools).then(
          (result) => {
            if (!result.ok) toast.error(result.message);
          },
        );
      }, 300);
      debounceRef.current.set(mcpServerId, handle);
    },
    [agentId],
  );

  function toggleServer(mcpServerId: string) {
    setStates((prev) => {
      const current = prev.get(mcpServerId) ?? { assigned: false, enabledTools: null };
      const next: McpServerState = { assigned: !current.assigned, enabledTools: null };
      const m = new Map(prev);
      m.set(mcpServerId, next);
      persist(mcpServerId, next.assigned, next.enabledTools);
      return m;
    });
  }

  function toggleTool(mcpServerId: string, toolName: string, allToolNames: string[]) {
    setStates((prev) => {
      const current = prev.get(mcpServerId) ?? { assigned: true, enabledTools: null };
      let nextEnabled: string[] | null;
      if (current.enabledTools === null) {
        // Currently all enabled — unchecking one yields the array of the rest.
        nextEnabled = allToolNames.filter((t) => t !== toolName);
      } else {
        const inList = current.enabledTools.includes(toolName);
        nextEnabled = inList
          ? current.enabledTools.filter((t) => t !== toolName)
          : [...current.enabledTools, toolName];
      }
      // All tools checked → collapse to null ("all enabled").
      if (nextEnabled !== null && nextEnabled.length === allToolNames.length) {
        nextEnabled = null;
      }
      const m = new Map(prev);
      // Empty whitelist → same as unassigning the server.
      if (nextEnabled !== null && nextEnabled.length === 0) {
        m.set(mcpServerId, { assigned: false, enabledTools: null });
        persist(mcpServerId, false, null);
        setExpanded((p) => {
          const s = new Set(p);
          s.delete(mcpServerId);
          return s;
        });
        return m;
      }
      m.set(mcpServerId, { assigned: true, enabledTools: nextEnabled });
      persist(mcpServerId, true, nextEnabled);
      return m;
    });
  }

  function enableAll(mcpServerId: string) {
    setStates((prev) => {
      const m = new Map(prev);
      m.set(mcpServerId, { assigned: true, enabledTools: null });
      persist(mcpServerId, true, null);
      return m;
    });
  }

  function uncheckAll(mcpServerId: string) {
    setStates((prev) => {
      const m = new Map(prev);
      m.set(mcpServerId, { assigned: false, enabledTools: null });
      persist(mcpServerId, false, null);
      return m;
    });
    setExpanded((prev) => {
      const s = new Set(prev);
      s.delete(mcpServerId);
      return s;
    });
  }

  function toggleExpand(mcpServerId: string) {
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(mcpServerId)) s.delete(mcpServerId);
      else s.add(mcpServerId);
      return s;
    });
  }

  if (servers.length === 0) {
    return (
      <p className="text-xs text-ink-4">
        No MCP connectors yet.{' '}
        <a href="/mcp" className="underline hover:text-ink-3 transition-colors">
          Connect one first.
        </a>
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {servers.map((s) => {
        const state = states.get(s.mcpServerId) ?? {
          assigned: s.assigned,
          enabledTools: s.enabledTools,
        };
        const isExpanded = expanded.has(s.mcpServerId);
        const allToolNames = s.availableTools.map((t) => t.name);
        const summary = !state.assigned
          ? null
          : state.enabledTools === null
            ? 'all tools'
            : `${state.enabledTools.length} of ${allToolNames.length} tools`;

        return (
          <div key={s.mcpServerId} className="rounded-lg border border-rule-2 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2">
              <input
                type="checkbox"
                checked={state.assigned}
                onChange={() => toggleServer(s.mcpServerId)}
                className="accent-violet-500 shrink-0"
              />
              <button
                type="button"
                onClick={() => toggleExpand(s.mcpServerId)}
                className="flex-1 text-left flex items-center gap-2 min-w-0"
              >
                <span className="text-ink-3 text-xs w-3 shrink-0">{isExpanded ? '▾' : '▸'}</span>
                <span className="text-sm text-ink font-medium truncate">{s.label}</span>
                {summary ? (
                  <span className="text-xs text-ink-3 shrink-0 ml-auto">{summary}</span>
                ) : null}
              </button>
            </div>

            {state.assigned && isExpanded && (
              <div className="border-t border-rule-2 px-3 py-2 bg-canvas/40 space-y-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => enableAll(s.mcpServerId)}
                    className="text-xs px-2 py-1 rounded border border-rule text-ink-3 hover:text-ink hover:border-ink-3 transition-colors"
                  >
                    Enable all
                  </button>
                  <button
                    type="button"
                    onClick={() => uncheckAll(s.mcpServerId)}
                    className="text-xs px-2 py-1 rounded border border-rule text-ink-3 hover:text-ink hover:border-ink-3 transition-colors"
                  >
                    Uncheck all
                  </button>
                </div>
                <div className="space-y-0.5">
                  {s.availableTools.map((tool) => {
                    const checked =
                      state.enabledTools === null || state.enabledTools.includes(tool.name);
                    return (
                      <label
                        key={tool.name}
                        className="flex items-center gap-2 px-1 py-1 rounded text-sm cursor-pointer hover:bg-hover"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleTool(s.mcpServerId, tool.name, allToolNames)}
                          className="accent-violet-500 shrink-0"
                        />
                        <code className="font-mono text-xs text-ink-2 shrink-0">{tool.name}</code>
                        {tool.description ? (
                          <span className="text-xs text-ink-4 italic truncate">
                            {tool.description}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
