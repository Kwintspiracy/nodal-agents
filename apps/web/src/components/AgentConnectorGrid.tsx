'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { setAgentConnectorAssignmentAction, type AgentConnectorRow } from '@/lib/actions.ts';
import type { OperationDescriptor } from '@nodal-agents/shared';

type ConnectorState = {
  assigned: boolean;
  enabledOperations: string[] | null;
};

type ConnectorStates = Map<string, ConnectorState>;

function riskBadge(op: OperationDescriptor): React.ReactNode {
  const base =
    'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider';
  if (op.risk === 'read') {
    return <span className={`${base} text-ok bg-agent-vivid/10`}>read</span>;
  }
  if (op.risk === 'write') {
    return (
      <span className={`${base} text-warn bg-warn/10`}>{op.requiresApproval ? '⚠ ' : ''}write</span>
    );
  }
  // destructive
  return <span className={`${base} text-err bg-warn-bg`}>⚠ destr</span>;
}

interface ConnectorGridProps {
  agentId: string;
  connectors: AgentConnectorRow[];
}

/**
 * Per-agent connector + operations whitelist. Each row is a checkbox to
 * assign the connector wholesale; expanding the row reveals the per-operation
 * grid for finer-grained control (`enabledOperations` — null means all).
 *
 * Used inside AgentForm (legacy edit) and AgentComposer (new 3-col edit).
 * Behaviour is unchanged from when it lived inline in AgentForm.
 */
export default function AgentConnectorGrid({ agentId, connectors }: ConnectorGridProps) {
  const [states, setStates] = useState<ConnectorStates>(() => {
    const m = new Map<string, ConnectorState>();
    for (const c of connectors) {
      m.set(c.connectorId, { assigned: c.assigned, enabledOperations: c.enabledOperations });
    }
    return m;
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const debounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const persist = useCallback(
    (connectorId: string, assigned: boolean, enabledOperations: string[] | null) => {
      const existing = debounceRef.current.get(connectorId);
      if (existing) clearTimeout(existing);

      const handle = setTimeout(() => {
        debounceRef.current.delete(connectorId);
        void setAgentConnectorAssignmentAction(
          agentId,
          connectorId,
          assigned,
          enabledOperations,
        ).then((result) => {
          if (!result.ok) toast.error(result.message);
        });
      }, 300);
      debounceRef.current.set(connectorId, handle);
    },
    [agentId],
  );

  function toggleConnector(connectorId: string) {
    setStates((prev) => {
      const current = prev.get(connectorId) ?? { assigned: false, enabledOperations: null };
      const next = { ...current, assigned: !current.assigned };
      if (next.assigned) {
        // Turning ON: default to all enabled (null)
        next.enabledOperations = null;
      }
      const m = new Map(prev);
      m.set(connectorId, next);
      persist(connectorId, next.assigned, next.enabledOperations);
      return m;
    });
  }

  function toggleOperation(connectorId: string, slug: string, availableOps: OperationDescriptor[]) {
    setStates((prev) => {
      const current = prev.get(connectorId) ?? { assigned: true, enabledOperations: null };
      const allSlugs = availableOps.map((o) => o.slug);

      let nextEnabled: string[] | null;
      if (current.enabledOperations === null) {
        // Currently all enabled — user unchecks one → produce array of all others
        nextEnabled = allSlugs.filter((s) => s !== slug);
      } else {
        // Toggle slug presence in the array
        const inList = current.enabledOperations.includes(slug);
        nextEnabled = inList
          ? current.enabledOperations.filter((s) => s !== slug)
          : [...current.enabledOperations, slug];
      }

      // Auto-collapse to null: if array now contains all slugs, treat as "all enabled"
      if (nextEnabled !== null && nextEnabled.length === allSlugs.length) {
        nextEnabled = null;
      }

      const m = new Map(prev);

      // Auto-deassign: if array is empty → same as unassigning the connector
      if (nextEnabled !== null && nextEnabled.length === 0) {
        m.set(connectorId, { assigned: false, enabledOperations: null });
        persist(connectorId, false, null);
        // Collapse the row too
        setExpanded((prev2) => {
          const s = new Set(prev2);
          s.delete(connectorId);
          return s;
        });
        return m;
      }

      m.set(connectorId, { ...current, enabledOperations: nextEnabled });
      persist(connectorId, true, nextEnabled);
      return m;
    });
  }

  function enableAll(connectorId: string) {
    setStates((prev) => {
      const m = new Map(prev);
      m.set(connectorId, { assigned: true, enabledOperations: null });
      persist(connectorId, true, null);
      return m;
    });
  }

  function uncheckAll(connectorId: string) {
    // Unchecking all = same as deassigning (no "0 of N enabled" state)
    setStates((prev) => {
      const m = new Map(prev);
      m.set(connectorId, { assigned: false, enabledOperations: null });
      persist(connectorId, false, null);
      return m;
    });
    setExpanded((prev) => {
      const s = new Set(prev);
      s.delete(connectorId);
      return s;
    });
  }

  function toggleExpand(connectorId: string) {
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(connectorId)) s.delete(connectorId);
      else s.add(connectorId);
      return s;
    });
  }

  if (connectors.length === 0) {
    return (
      <p className="text-xs text-ink-4">
        No connected adapters found.{' '}
        <a href="/connectors" className="underline hover:text-ink-3 transition-colors">
          Connect a service first.
        </a>
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {connectors.map((c) => {
        const state = states.get(c.connectorId) ?? {
          assigned: c.assigned,
          enabledOperations: c.enabledOperations,
        };
        const isExpanded = expanded.has(c.connectorId);
        const ops = c.availableOperations;

        // Summary text
        const summary = !state.assigned
          ? null
          : state.enabledOperations === null
            ? 'all enabled'
            : `${state.enabledOperations.length} of ${ops.length} enabled`;

        return (
          <div key={c.connectorId} className="rounded-lg border border-rule-2 overflow-hidden">
            {/* Connector row */}
            <div className="flex items-center gap-2 px-3 py-2">
              <input
                type="checkbox"
                checked={state.assigned}
                onChange={() => toggleConnector(c.connectorId)}
                className="accent-violet-500 shrink-0"
              />
              <button
                type="button"
                onClick={() => toggleExpand(c.connectorId)}
                className="flex-1 text-left flex items-center gap-2 min-w-0"
              >
                <span className="text-ink-3 text-xs w-3 shrink-0">{isExpanded ? '▾' : '▸'}</span>
                <span className="text-sm text-ink font-medium truncate">
                  {c.label}
                  {c.credentialName ? (
                    <span className="text-ink-3 font-normal"> ({c.credentialName})</span>
                  ) : null}
                </span>
                {summary ? (
                  <span className="text-xs text-ink-3 shrink-0 ml-auto">{summary}</span>
                ) : null}
              </button>
            </div>

            {/* Operation grid — only when assigned and expanded */}
            {state.assigned && isExpanded && (
              <div className="border-t border-rule-2 px-3 py-2 bg-canvas/40 space-y-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => enableAll(c.connectorId)}
                    className="text-xs px-2 py-1 rounded border border-rule text-ink-3 hover:text-ink hover:border-ink-3 transition-colors"
                  >
                    Enable all
                  </button>
                  <button
                    type="button"
                    onClick={() => uncheckAll(c.connectorId)}
                    className="text-xs px-2 py-1 rounded border border-rule text-ink-3 hover:text-ink hover:border-ink-3 transition-colors"
                  >
                    Uncheck all
                  </button>
                </div>
                <div className="space-y-0.5">
                  {ops.map((op) => {
                    const checked =
                      state.enabledOperations === null || state.enabledOperations.includes(op.slug);
                    return (
                      <label
                        key={op.slug}
                        className="flex items-center gap-2 px-1 py-1 rounded text-sm cursor-pointer hover:bg-hover"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOperation(c.connectorId, op.slug, ops)}
                          className="accent-violet-500 shrink-0"
                        />
                        <code className="font-mono text-xs text-ink-2 shrink-0">{op.slug}</code>
                        {riskBadge(op)}
                        {op.description ? (
                          <span className="text-xs text-ink-4 italic truncate">
                            {op.description}
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
