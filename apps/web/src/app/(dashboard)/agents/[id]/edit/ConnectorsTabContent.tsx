'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { setAgentConnectorAssignmentAction, type AgentConnectorRow } from '@/lib/actions.ts';
import type { OperationDescriptor } from '@nodal-agents/shared';
import EdRow, { IcBtn } from '@/components/ui/EdRow';
import EdAddButton from '@/components/ui/EdAddButton';
import Disc from '@/components/ui/Disc';
import { CONN_BRAND_COLORS, connGlyph } from '@/app/(dashboard)/connectors/connector-brand.ts';

/**
 * ConnectorsTabContent — Connectors tab body for /agents/[id]/edit, built
 * on the handoff's `.ed-row` + `.ed-add` patterns (screen-composer-v2.jsx
 * ConnectorsTab). Replaces the old `AgentConnectorGrid` that used inline
 * checkboxes.
 *
 * Layout: two sections — "Connected" + "Available" — each a list of EdRow.
 * Click the settings IcBtn on a connected row to reveal an inline per-op
 * whitelist (no modal). The "+ Add" IcBtn on an available row assigns
 * the connector. The bottom EdAddButton routes to /connectors to install
 * new providers.
 *
 * State + persistence behaviour is preserved from the old grid (debounced
 * 300ms, server actions, error toasts).
 */

type ConnState = {
  assigned: boolean;
  enabledOperations: string[] | null;
};

type Props = {
  agentId: string;
  connectors: AgentConnectorRow[];
};

export default function ConnectorsTabContent({ agentId, connectors }: Props) {
  const [states, setStates] = useState<Map<string, ConnState>>(() => {
    const m = new Map<string, ConnState>();
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

  function toggleAssigned(connectorId: string, nextAssigned: boolean) {
    setStates((prev) => {
      const m = new Map(prev);
      m.set(connectorId, { assigned: nextAssigned, enabledOperations: null });
      persist(connectorId, nextAssigned, null);
      return m;
    });
    if (!nextAssigned) {
      setExpanded((prev) => {
        const s = new Set(prev);
        s.delete(connectorId);
        return s;
      });
    }
  }

  function toggleOp(connectorId: string, slug: string, allOps: OperationDescriptor[]) {
    setStates((prev) => {
      const current = prev.get(connectorId) ?? { assigned: true, enabledOperations: null };
      const allSlugs = allOps.map((o) => o.slug);
      let nextEnabled: string[] | null;
      if (current.enabledOperations === null) {
        nextEnabled = allSlugs.filter((s) => s !== slug);
      } else {
        const has = current.enabledOperations.includes(slug);
        nextEnabled = has
          ? current.enabledOperations.filter((s) => s !== slug)
          : [...current.enabledOperations, slug];
      }
      if (nextEnabled !== null && nextEnabled.length === allSlugs.length) nextEnabled = null;
      const m = new Map(prev);
      if (nextEnabled !== null && nextEnabled.length === 0) {
        m.set(connectorId, { assigned: false, enabledOperations: null });
        persist(connectorId, false, null);
        setExpanded((p) => {
          const s = new Set(p);
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
    toggleAssigned(connectorId, false);
  }

  function toggleExpand(connectorId: string) {
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(connectorId)) s.delete(connectorId);
      else s.add(connectorId);
      return s;
    });
  }

  const { connected, available } = useMemo(() => {
    const connected: AgentConnectorRow[] = [];
    const available: AgentConnectorRow[] = [];
    for (const c of connectors) {
      const state = states.get(c.connectorId) ?? c;
      if (state.assigned) connected.push(c);
      else available.push(c);
    }
    return { connected, available };
  }, [connectors, states]);

  if (connectors.length === 0) {
    return (
      <SectionWrapper>
        <p className="mb-3 text-[12.5px] text-ink-3">
          No connectors installed yet. Add some on the Connectors page first; you&apos;ll then be
          able to assign them here.
        </p>
        <EdAddButton href="/connectors">Browse connectors marketplace</EdAddButton>
      </SectionWrapper>
    );
  }

  return (
    <SectionWrapper>
      {connected.length > 0 && (
        <Section
          label={`Connected · ${connected.length}`}
          hint="Revoke any to detach everywhere. Per-operation whitelist lives under the gear icon."
        >
          {connected.map((c) => {
            const state = states.get(c.connectorId) ?? c;
            const isExpanded = expanded.has(c.connectorId);
            const ops = c.availableOperations;
            const enabledOps = state.enabledOperations;
            const opsLabel =
              enabledOps === null
                ? `all ${ops.length} ops`
                : `${enabledOps.length} of ${ops.length} ops`;
            return (
              <ConnectorEdRow
                key={c.connectorId}
                row={c}
                opsLabel={opsLabel}
                expanded={isExpanded}
                state={state}
                onToggleExpand={() => toggleExpand(c.connectorId)}
                onRemove={() => toggleAssigned(c.connectorId, false)}
                onToggleOp={(slug) => toggleOp(c.connectorId, slug, ops)}
                onEnableAll={() => enableAll(c.connectorId)}
                onUncheckAll={() => uncheckAll(c.connectorId)}
              />
            );
          })}
        </Section>
      )}

      {available.length > 0 && (
        <Section label={`Available · ${available.length}`}>
          {available.map((c) => (
            <EdRow
              key={c.connectorId}
              glyph={
                <Disc
                  variant="conn"
                  size="md"
                  shape="square"
                  background={CONN_BRAND_COLORS[c.slug]}
                >
                  <span className="font-mono text-[10.5px] font-semibold">
                    {connGlyph(c.slug, c.label)}
                  </span>
                </Disc>
              }
              name={c.label}
              description={c.credentialName ?? undefined}
              meta={`${c.availableOperations.length} ops`}
              actions={
                <IcBtn
                  title="Add to this agent"
                  ariaLabel="Add"
                  onClick={() => toggleAssigned(c.connectorId, true)}
                >
                  <PlusIcon />
                </IcBtn>
              }
            />
          ))}
        </Section>
      )}

      <EdAddButton href="/connectors">Connect from marketplace</EdAddButton>
    </SectionWrapper>
  );
}

// ─── Connector row with optional per-op expand ────────────────────────────────

function ConnectorEdRow({
  row,
  opsLabel,
  expanded,
  state,
  onToggleExpand,
  onRemove,
  onToggleOp,
  onEnableAll,
  onUncheckAll,
}: {
  row: AgentConnectorRow;
  opsLabel: string;
  expanded: boolean;
  state: ConnState;
  onToggleExpand: () => void;
  onRemove: () => void;
  onToggleOp: (slug: string) => void;
  onEnableAll: () => void;
  onUncheckAll: () => void;
}) {
  const ops = row.availableOperations;
  return (
    <EdRow
      glyph={
        <Disc variant="conn" size="md" shape="square" background={CONN_BRAND_COLORS[row.slug]}>
          <span className="font-mono text-[10.5px] font-semibold">
            {connGlyph(row.slug, row.label)}
          </span>
        </Disc>
      }
      name={row.label}
      description={row.credentialName ?? undefined}
      meta={opsLabel}
      actions={
        <>
          <IcBtn
            title={expanded ? 'Hide operations' : 'Configure operations'}
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
              {ops.map((op) => {
                const checked =
                  state.enabledOperations === null || state.enabledOperations.includes(op.slug);
                return (
                  <label
                    key={op.slug}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12.5px] transition-colors hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleOp(op.slug)}
                      className="shrink-0 accent-agent-vivid"
                    />
                    <code className="shrink-0 font-mono text-[11px] text-ink-2">{op.slug}</code>
                    <RiskBadge op={op} />
                    {op.description && (
                      <span className="truncate text-[11px] italic text-ink-4">
                        {op.description}
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">
          {label}
        </div>
        {hint && <p className="mt-1 text-[11.5px] leading-[1.5] text-ink-3">{hint}</p>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function SectionWrapper({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">{children}</div>;
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

function RiskBadge({ op }: { op: OperationDescriptor }) {
  const base =
    'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider';
  if (op.risk === 'read') {
    return <span className={`${base} bg-agent-vivid/10 text-ok`}>read</span>;
  }
  if (op.risk === 'write') {
    return (
      <span className={`${base} bg-warn/10 text-warn`}>{op.requiresApproval ? '⚠ ' : ''}write</span>
    );
  }
  return <span className={`${base} bg-warn-bg text-err`}>⚠ destr</span>;
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
