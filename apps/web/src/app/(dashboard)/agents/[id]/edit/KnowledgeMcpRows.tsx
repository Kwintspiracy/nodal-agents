'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { setAgentMcpServerAssignmentAction, type AgentMcpServerRow } from '@/lib/actions.ts';
import EdRow, { IcBtn } from '@/components/ui/EdRow';
import EdAddButton from '@/components/ui/EdAddButton';
import Disc from '@/components/ui/Disc';

/**
 * KnowledgeMcpRows — MCP server picker for the Settings → Knowledge
 * section of /agents/[id]/edit. Built on the same `.ed-row` + `.ed-add`
 * patterns as ConnectorsTabContent.
 *
 * Click the gear IcBtn on a connected MCP server to reveal an inline
 * per-tool whitelist. Click `×` to detach. The bottom EdAddButton routes
 * to /mcp to install new servers.
 */

type McpState = { assigned: boolean; enabledTools: string[] | null };

type Props = {
  agentId: string;
  servers: AgentMcpServerRow[];
};

export default function KnowledgeMcpRows({ agentId, servers }: Props) {
  const [states, setStates] = useState<Map<string, McpState>>(() => {
    const m = new Map<string, McpState>();
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

  function toggleAssigned(mcpServerId: string, nextAssigned: boolean) {
    setStates((prev) => {
      const m = new Map(prev);
      m.set(mcpServerId, { assigned: nextAssigned, enabledTools: null });
      persist(mcpServerId, nextAssigned, null);
      return m;
    });
    if (!nextAssigned) {
      setExpanded((p) => {
        const s = new Set(p);
        s.delete(mcpServerId);
        return s;
      });
    }
  }

  function toggleTool(mcpServerId: string, toolName: string, allTools: string[]) {
    setStates((prev) => {
      const current = prev.get(mcpServerId) ?? { assigned: true, enabledTools: null };
      let nextEnabled: string[] | null;
      if (current.enabledTools === null) {
        nextEnabled = allTools.filter((t) => t !== toolName);
      } else {
        const has = current.enabledTools.includes(toolName);
        nextEnabled = has
          ? current.enabledTools.filter((t) => t !== toolName)
          : [...current.enabledTools, toolName];
      }
      if (nextEnabled !== null && nextEnabled.length === allTools.length) nextEnabled = null;
      const m = new Map(prev);
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
    toggleAssigned(mcpServerId, false);
  }

  function toggleExpand(mcpServerId: string) {
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(mcpServerId)) s.delete(mcpServerId);
      else s.add(mcpServerId);
      return s;
    });
  }

  const { connected, available } = useMemo(() => {
    const connected: AgentMcpServerRow[] = [];
    const available: AgentMcpServerRow[] = [];
    for (const s of servers) {
      const state = states.get(s.mcpServerId) ?? s;
      if (state.assigned) connected.push(s);
      else available.push(s);
    }
    return { connected, available };
  }, [servers, states]);

  if (servers.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] text-ink-3">
          No MCP servers installed yet. Add some on the MCP page first.
        </p>
        <EdAddButton href="/mcp">Browse MCP servers</EdAddButton>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {connected.length > 0 && (
        <div className="space-y-2">
          {connected.map((s) => {
            const state = states.get(s.mcpServerId) ?? s;
            const isExpanded = expanded.has(s.mcpServerId);
            const allTools = s.availableTools.map((t) => t.name);
            const enabledTools = state.enabledTools;
            const toolsLabel =
              enabledTools === null
                ? `all ${allTools.length} tools`
                : `${enabledTools.length} of ${allTools.length} tools`;
            return (
              <McpEdRow
                key={s.mcpServerId}
                row={s}
                toolsLabel={toolsLabel}
                expanded={isExpanded}
                enabled={enabledTools}
                onToggleExpand={() => toggleExpand(s.mcpServerId)}
                onRemove={() => toggleAssigned(s.mcpServerId, false)}
                onToggleTool={(name) => toggleTool(s.mcpServerId, name, allTools)}
                onEnableAll={() => enableAll(s.mcpServerId)}
                onUncheckAll={() => uncheckAll(s.mcpServerId)}
              />
            );
          })}
        </div>
      )}

      {available.length > 0 && (
        <div className="space-y-2">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">
            Available · {available.length}
          </div>
          {available.map((s) => (
            <EdRow
              key={s.mcpServerId}
              glyph={
                <Disc variant="conn" size="lg" shape="square">
                  <span className="font-mono text-[10.5px] font-semibold">MCP</span>
                </Disc>
              }
              name={s.label}
              meta={`${s.availableTools.length} tools`}
              actions={
                <IcBtn
                  title="Add to this agent"
                  ariaLabel="Add"
                  onClick={() => toggleAssigned(s.mcpServerId, true)}
                >
                  <PlusIcon />
                </IcBtn>
              }
            />
          ))}
        </div>
      )}

      <EdAddButton href="/mcp">Browse MCP servers</EdAddButton>
    </div>
  );
}

function McpEdRow({
  row,
  toolsLabel,
  expanded,
  enabled,
  onToggleExpand,
  onRemove,
  onToggleTool,
  onEnableAll,
  onUncheckAll,
}: {
  row: AgentMcpServerRow;
  toolsLabel: string;
  expanded: boolean;
  enabled: string[] | null;
  onToggleExpand: () => void;
  onRemove: () => void;
  onToggleTool: (name: string) => void;
  onEnableAll: () => void;
  onUncheckAll: () => void;
}) {
  return (
    <EdRow
      glyph={
        <Disc variant="conn" size="lg" shape="square">
          <span className="font-mono text-[10.5px] font-semibold">MCP</span>
        </Disc>
      }
      name={row.label}
      meta={toolsLabel}
      actions={
        <>
          <IcBtn
            title={expanded ? 'Hide tools' : 'Configure tools'}
            ariaLabel="Configure"
            onClick={onToggleExpand}
          >
            <GearIcon />
          </IcBtn>
          <IcBtn title="Remove from this agent" ariaLabel="Remove" onClick={onRemove}>
            <CloseIcon />
          </IcBtn>
        </>
      }
      expanded={
        expanded ? (
          <>
            <div className="flex gap-2">
              <ToolbarMiniBtn onClick={onEnableAll}>Enable all</ToolbarMiniBtn>
              <ToolbarMiniBtn onClick={onUncheckAll}>Uncheck all</ToolbarMiniBtn>
            </div>
            <div className="space-y-0.5">
              {row.availableTools.map((tool) => {
                const checked = enabled === null || enabled.includes(tool.name);
                return (
                  <label
                    key={tool.name}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12.5px] transition-colors hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleTool(tool.name)}
                      className="shrink-0 accent-agent-vivid"
                    />
                    <code className="shrink-0 font-mono text-[11px] text-ink-2">{tool.name}</code>
                    {tool.description && (
                      <span className="truncate text-[11px] italic text-ink-4">
                        {tool.description}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </>
        ) : null
      }
    />
  );
}

function ToolbarMiniBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-rule px-2 py-1 text-[11px] font-medium text-ink-3 transition-colors hover:border-rule-2 hover:text-ink"
    >
      {children}
    </button>
  );
}

function GearIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="8" cy="8" r="2" />
      <circle cx="8" cy="8" r="6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <path d="M6 2v8M2 6h8" />
    </svg>
  );
}
