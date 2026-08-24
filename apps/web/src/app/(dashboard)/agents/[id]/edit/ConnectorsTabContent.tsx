'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  setAgentConnectorAssignmentAction,
  setAgentMcpServerAssignmentAction,
  setAgentApprovalRuleAction,
  type AgentConnectorRow,
  type AgentMcpServerRow,
} from '@/lib/actions.ts';
import type { OperationDescriptor } from '@nodal-agents/shared';
import EdRow, { IcBtn } from '@/components/ui/EdRow';
import EdAddButton from '@/components/ui/EdAddButton';
import Disc from '@/components/ui/Disc';
import RowActionButton from '@/components/ui/RowActionButton';
import Checkbox from '@/components/ui/Checkbox';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import PrimaryButton from '@/components/ui/PrimaryButton';
import PageSearchInput from '@/components/ui/PageSearchInput';
import { CONN_BRAND_COLORS, connGlyph } from '@/app/(dashboard)/connectors/connector-brand.ts';

/**
 * ConnectorsTabContent — unified Connectors tab for /agents/[id]/edit.
 *
 * Per the design handoff (`screen-composer-v2.jsx` ConnectorsTab) and
 * Quentin's explicit ask ("qu'ils soient API ou MCP"), this single tab
 * lists BOTH API connectors AND MCP servers together. Each row carries
 * a mono "API" or "MCP" tag in the PN slot to distinguish kind.
 *
 * Layout : two stacked sections —
 *   1. "Connected · N" — everything currently attached to the agent.
 *   2. "Available on this workspace · M" — installed but not attached;
 *      `+` IcBtn attaches.
 *
 * Per-op (API) and per-tool (MCP) whitelisting both surface as an inline
 * expand under the row, triggered by the gear `IcBtn`. Same UX, different
 * data layer (setAgentConnectorAssignmentAction vs
 * setAgentMcpServerAssignmentAction, both debounced 300ms).
 */

type ConnState = { assigned: boolean; enabledOperations: string[] | null };
type McpState = { assigned: boolean; enabledTools: string[] | null };

type Item = { kind: 'api'; row: AgentConnectorRow } | { kind: 'mcp'; row: AgentMcpServerRow };

type Props = {
  agentId: string;
  connectors: AgentConnectorRow[];
  mcpServers: AgentMcpServerRow[];
};

export default function ConnectorsTabContent({ agentId, connectors, mcpServers }: Props) {
  // ── per-type state maps ───────────────────────────────────────────────────
  const [connStates, setConnStates] = useState<Map<string, ConnState>>(() => {
    const m = new Map<string, ConnState>();
    for (const c of connectors) {
      m.set(c.connectorId, { assigned: c.assigned, enabledOperations: c.enabledOperations });
    }
    return m;
  });
  const [mcpStates, setMcpStates] = useState<Map<string, McpState>>(() => {
    const m = new Map<string, McpState>();
    for (const s of mcpServers) {
      m.set(s.mcpServerId, { assigned: s.assigned, enabledTools: s.enabledTools });
    }
    return m;
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Décision Quentin 24/08 (même geste que l'onglet Skills) : l'onglet ne
  // montre que ce qui est CONNECTÉ à cet agent ; la bibliothèque du workspace
  // vit dans la modale « Attach connectors », cherchable.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  // Server awaiting the trust question, and how wide the grant should reach.
  const [trustAsk, setTrustAsk] = useState<string | null>(null);
  const [trustAllAgents, setTrustAllAgents] = useState(false);
  const debounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── persist (debounced) ──────────────────────────────────────────────────
  //
  // `notify`: fires a toast.success on the whole-assignment attach/detach
  // gesture (the +/✕ IcBtn) — audit UX finding #7: attach/detach was the only
  // silent action in the dashboard (per-op whitelist edits inside the expanded
  // panel stay quiet on purpose; the checkbox itself is the feedback there).
  const persistConn = useCallback(
    (
      connectorId: string,
      assigned: boolean,
      enabledOperations: string[] | null,
      notify = false,
    ) => {
      const key = `conn:${connectorId}`;
      const existing = debounceRef.current.get(key);
      if (existing) clearTimeout(existing);
      const handle = setTimeout(() => {
        debounceRef.current.delete(key);
        void setAgentConnectorAssignmentAction(
          agentId,
          connectorId,
          assigned,
          enabledOperations,
        ).then((r) => {
          if (!r.ok) {
            toast.error(r.message);
            return;
          }
          if (notify) {
            const label =
              connectors.find((c) => c.connectorId === connectorId)?.label ?? 'Connector';
            toast.success(assigned ? `${label} attached` : `${label} detached`);
          }
        });
      }, 300);
      debounceRef.current.set(key, handle);
    },
    [agentId, connectors],
  );

  const persistMcp = useCallback(
    (mcpServerId: string, assigned: boolean, enabledTools: string[] | null, notify = false) => {
      const key = `mcp:${mcpServerId}`;
      const existing = debounceRef.current.get(key);
      if (existing) clearTimeout(existing);
      const handle = setTimeout(() => {
        debounceRef.current.delete(key);
        void setAgentMcpServerAssignmentAction(agentId, mcpServerId, assigned, enabledTools).then(
          (r) => {
            if (!r.ok) {
              toast.error(r.message);
              return;
            }
            if (notify) {
              const label =
                mcpServers.find((s) => s.mcpServerId === mcpServerId)?.label ?? 'MCP server';
              toast.success(assigned ? `${label} attached` : `${label} detached`);
            }
          },
        );
      }, 300);
      debounceRef.current.set(key, handle);
    },
    [agentId, mcpServers],
  );

  // ── API connector toggles ────────────────────────────────────────────────
  function connToggleAssigned(connectorId: string, nextAssigned: boolean) {
    setConnStates((prev) => {
      const m = new Map(prev);
      m.set(connectorId, { assigned: nextAssigned, enabledOperations: null });
      persistConn(connectorId, nextAssigned, null, true);
      return m;
    });
    if (!nextAssigned) collapse(connectorId);
  }

  function connToggleOp(connectorId: string, slug: string, allOps: OperationDescriptor[]) {
    setConnStates((prev) => {
      const current = prev.get(connectorId) ?? { assigned: true, enabledOperations: null };
      const allSlugs = allOps.map((o) => o.slug);
      let next: string[] | null;
      if (current.enabledOperations === null) {
        next = allSlugs.filter((s) => s !== slug);
      } else {
        const has = current.enabledOperations.includes(slug);
        next = has
          ? current.enabledOperations.filter((s) => s !== slug)
          : [...current.enabledOperations, slug];
      }
      if (next !== null && next.length === allSlugs.length) next = null;
      const m = new Map(prev);
      if (next !== null && next.length === 0) {
        m.set(connectorId, { assigned: false, enabledOperations: null });
        persistConn(connectorId, false, null);
        collapse(connectorId);
        return m;
      }
      m.set(connectorId, { ...current, enabledOperations: next });
      persistConn(connectorId, true, next);
      return m;
    });
  }

  function connEnableAll(connectorId: string) {
    setConnStates((prev) => {
      const m = new Map(prev);
      m.set(connectorId, { assigned: true, enabledOperations: null });
      persistConn(connectorId, true, null);
      return m;
    });
  }

  // ── MCP server toggles ───────────────────────────────────────────────────
  function attachMcp(mcpServerId: string) {
    setMcpStates((prev) => {
      const m = new Map(prev);
      m.set(mcpServerId, { assigned: true, enabledTools: null });
      persistMcp(mcpServerId, true, null, true);
      return m;
    });
  }

  /**
   * Attaching is the consent moment.
   *
   * Every MCP tool ships `defaultApproval: 'require_approval'` (MCP-001) — the
   * one place foreign code entered with no human checkpoint. But asking again on
   * every CALL adds no security: the owner already decided, here, when they
   * attached the server. It only adds fatigue, and fatigue is what makes people
   * approve without reading — which costs exactly the calls that mattered.
   * Reported live after twelve consecutive prompts for read-only calls, on an
   * install set to "autonomous, gate destructive".
   *
   * So the question is asked ONCE, at the moment a human is deliberately adding
   * the server, with per-call approval still available for a server they want to
   * watch.
   */
  function mcpToggleAssigned(mcpServerId: string, nextAssigned: boolean) {
    if (nextAssigned) {
      setTrustAsk(mcpServerId);
      return;
    }
    setMcpStates((prev) => {
      const m = new Map(prev);
      m.set(mcpServerId, { assigned: false, enabledTools: null });
      persistMcp(mcpServerId, false, null, true);
      return m;
    });
    collapse(mcpServerId);
  }

  /** `cogni-cortex` → `cogni_cortex`. Mirrors slugToPrefix in adapter-mcp. */
  function slugToPrefix(slug: string): string {
    return slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  }

  function confirmTrust(trust: boolean) {
    const serverId = trustAsk;
    if (!serverId) return;
    const server = mcpServers.find((s) => s.mcpServerId === serverId);
    setTrustAsk(null);
    attachMcp(serverId);
    if (!trust || !server) {
      setTrustAllAgents(false);
      return;
    }
    const scope = trustAllAgents ? ('entity' as const) : ('agent' as const);
    setTrustAllAgents(false);
    void setAgentApprovalRuleAction({
      agentId,
      toolName: `${slugToPrefix(server.slug)}__*`,
      action: 'auto_approve',
      scope,
    }).then((r) => {
      if (!r.ok) {
        // Loud: the server IS attached, so silence here would leave the owner
        // believing its calls run freely when every one of them will prompt.
        toast.error(`${server.label} attaché, mais la règle de confiance a échoué : ${r.message}`);
        return;
      }
      toast.success(
        scope === 'entity'
          ? `${server.label} : ses outils s'exécuteront sans demande pour tous vos agents.`
          : `${server.label} : ses outils s'exécuteront sans demande pour cet agent.`,
      );
    });
  }

  function mcpToggleTool(mcpServerId: string, toolName: string, allTools: string[]) {
    setMcpStates((prev) => {
      const current = prev.get(mcpServerId) ?? { assigned: true, enabledTools: null };
      let next: string[] | null;
      if (current.enabledTools === null) {
        next = allTools.filter((t) => t !== toolName);
      } else {
        const has = current.enabledTools.includes(toolName);
        next = has
          ? current.enabledTools.filter((t) => t !== toolName)
          : [...current.enabledTools, toolName];
      }
      if (next !== null && next.length === allTools.length) next = null;
      const m = new Map(prev);
      if (next !== null && next.length === 0) {
        m.set(mcpServerId, { assigned: false, enabledTools: null });
        persistMcp(mcpServerId, false, null);
        collapse(mcpServerId);
        return m;
      }
      m.set(mcpServerId, { assigned: true, enabledTools: next });
      persistMcp(mcpServerId, true, next);
      return m;
    });
  }

  function mcpEnableAll(mcpServerId: string) {
    setMcpStates((prev) => {
      const m = new Map(prev);
      m.set(mcpServerId, { assigned: true, enabledTools: null });
      persistMcp(mcpServerId, true, null);
      return m;
    });
  }

  // ── expand helpers (shared) ──────────────────────────────────────────────
  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }
  function collapse(id: string) {
    setExpanded((prev) => {
      const s = new Set(prev);
      s.delete(id);
      return s;
    });
  }

  // ── compute connected / available (combined) ─────────────────────────────
  const { connected, available } = useMemo(() => {
    const connected: Item[] = [];
    const available: Item[] = [];
    for (const c of connectors) {
      const state = connStates.get(c.connectorId) ?? c;
      const item: Item = { kind: 'api', row: c };
      if (state.assigned) connected.push(item);
      else available.push(item);
    }
    for (const s of mcpServers) {
      const state = mcpStates.get(s.mcpServerId) ?? s;
      const item: Item = { kind: 'mcp', row: s };
      if (state.assigned) connected.push(item);
      else available.push(item);
    }
    return { connected, available };
  }, [connectors, mcpServers, connStates, mcpStates]);

  if (connectors.length === 0 && mcpServers.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-body-13 text-ink-3">
          No connectors or MCP servers installed on this workspace yet. Add some first; you&apos;ll
          then be able to attach them to this agent.
        </p>
        <EdAddButton href="/connectors">Browse connectors marketplace</EdAddButton>
        <EdAddButton href="/mcp">Browse MCP servers</EdAddButton>
      </div>
    );
  }

  // Filtre du picker : label + slug (+ credential pour les API).
  const query = pickerQuery.trim().toLowerCase();
  const pickable = query
    ? available.filter((item) => {
        const haystack =
          item.kind === 'api'
            ? `${item.row.label} ${item.row.slug} ${item.row.credentialName ?? ''}`
            : `${item.row.label} ${item.row.slug}`;
        return haystack.toLowerCase().includes(query);
      })
    : available;

  return (
    <div className="space-y-6">
      <Section
        label={`Connected · ${connected.length}`}
        hint="Revoke any to detach everywhere. Per-op (API) / per-tool (MCP) whitelist via the gear icon."
        action={
          <PrimaryButton
            variant="neutral"
            size="sm"
            onClick={() => {
              setPickerQuery('');
              setPickerOpen(true);
            }}
          >
            + Attach connectors
          </PrimaryButton>
        }
      >
        {connected.length === 0 && (
          <p className="text-body-13 text-ink-3">
            No connectors or MCP servers attached to this agent yet. Use “Attach connectors” to pick
            from the {available.length} installed in this workspace.
          </p>
        )}
        {connected.map((item) => renderRow(item, true))}
      </Section>

      <div className="flex flex-col gap-2">
        <EdAddButton href="/connectors">Browse connectors marketplace</EdAddButton>
        <EdAddButton href="/mcp">Browse MCP servers</EdAddButton>
      </div>

      {/* Picker de la bibliothèque du workspace (API + MCP confondus, comme
          l'onglet). Chaque + attache immédiatement — pour un serveur MCP, la
          question de confiance s'ouvre PAR-DESSUS (ConfirmDialog rendu après
          la Modal dans le JSX : à z-index égal, le portail monté en dernier
          gagne). La modale reste ouverte pour enchaîner. */}
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Attach connectors"
        className="!max-w-2xl"
        footer={
          <ModalFooter>
            <PrimaryButton variant="neutral" onClick={() => setPickerOpen(false)}>
              Close
            </PrimaryButton>
          </ModalFooter>
        }
      >
        <div className="space-y-4">
          <PageSearchInput
            value={pickerQuery}
            onChange={setPickerQuery}
            placeholder="Search installed connectors and MCP servers…"
            minWidth={0}
            className="w-full"
          />
          <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {available.length === 0 ? (
              <p className="text-body-13 text-ink-3">
                Everything installed in this workspace is already connected to this agent.
              </p>
            ) : pickable.length === 0 ? (
              <p className="text-body-13 text-ink-3">
                No installed connector matches “{pickerQuery}”.
              </p>
            ) : (
              pickable.map((item) => renderRow(item, false))
            )}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={trustAsk !== null}
        title={`Faire confiance à ${mcpServers.find((s) => s.mcpServerId === trustAsk)?.label ?? 'ce serveur'} ?`}
        message="Ses outils s'exécuteront sans vous demander à chaque appel. Choisissez plutôt de demander à chaque fois pour un serveur que vous voulez surveiller. Révocable à tout moment dans les règles d'approbation."
        confirmLabel="Faire confiance"
        cancelLabel="Demander à chaque appel"
        destructive={false}
        extra={
          <Checkbox
            checked={trustAllAgents}
            onChange={(e) => setTrustAllAgents(e.target.checked)}
            label={
              <span className="text-body-13 text-ink-2">
                Pour tous mes agents, pas seulement celui-ci
              </span>
            }
          />
        }
        onConfirm={() => confirmTrust(true)}
        // "Cancel" here is a real choice, not an escape: the server still gets
        // attached, it simply keeps asking. Closing with ESC lands here too,
        // which is the safe side.
        onCancel={() => confirmTrust(false)}
      />
    </div>
  );

  // ── row renderer (closes over toggle handlers) ───────────────────────────
  function renderRow(item: Item, isConnected: boolean) {
    if (item.kind === 'api') {
      const c = item.row;
      const state = connStates.get(c.connectorId) ?? c;
      const isExpanded = expanded.has(c.connectorId);
      const ops = c.availableOperations;
      const opsLabel =
        state.enabledOperations === null
          ? `all ${ops.length} ops`
          : `${state.enabledOperations.length} of ${ops.length} ops`;
      return (
        <EdRow
          key={`conn:${c.connectorId}`}
          glyph={
            <Disc variant="conn" size="lg" shape="square" background={CONN_BRAND_COLORS[c.slug]}>
              <span className="font-mono text-label-11">{connGlyph(c.slug, c.label)}</span>
            </Disc>
          }
          name={
            <>
              {c.label}
              <KindTag kind="API" />
            </>
          }
          description={c.credentialName ?? undefined}
          meta={isConnected ? opsLabel : `${ops.length} ops`}
          actions={
            isConnected ? (
              <>
                <IcBtn
                  title={isExpanded ? 'Hide operations' : 'Configure operations'}
                  ariaLabel="Configure"
                  onClick={() => toggleExpand(c.connectorId)}
                >
                  <GearIcon />
                </IcBtn>
                <IcBtn
                  title="Detach from this agent"
                  ariaLabel="Detach"
                  onClick={() => connToggleAssigned(c.connectorId, false)}
                >
                  <CloseIcon />
                </IcBtn>
              </>
            ) : (
              <IcBtn
                title="Attach to this agent"
                ariaLabel="Attach"
                onClick={() => connToggleAssigned(c.connectorId, true)}
              >
                <PlusIcon />
              </IcBtn>
            )
          }
          expanded={
            isConnected && isExpanded ? (
              <>
                <div className="flex gap-2">
                  <MiniBtn onClick={() => connEnableAll(c.connectorId)}>Enable all</MiniBtn>
                  <MiniBtn onClick={() => connToggleAssigned(c.connectorId, false)}>
                    Uncheck all
                  </MiniBtn>
                </div>
                <div className="space-y-0.5">
                  {ops.map((op) => {
                    const checked =
                      state.enabledOperations === null || state.enabledOperations.includes(op.slug);
                    return (
                      <Checkbox
                        key={op.slug}
                        tone="agent"
                        checked={checked}
                        onChange={() => connToggleOp(c.connectorId, op.slug, ops)}
                        containerClassName="rounded px-1 py-1 text-body-13 transition-colors hover:bg-hover"
                        label={
                          <>
                            <code className="shrink-0 text-mono-12 text-ink-2">{op.slug}</code>
                            <RiskBadge op={op} />
                            {op.description && (
                              <span className="truncate text-body-12 italic text-ink-4">
                                {op.description}
                              </span>
                            )}
                          </>
                        }
                      />
                    );
                  })}
                </div>
              </>
            ) : null
          }
        />
      );
    }
    // MCP
    const s = item.row;
    const state = mcpStates.get(s.mcpServerId) ?? s;
    const isExpanded = expanded.has(s.mcpServerId);
    const allTools = s.availableTools.map((t) => t.name);
    const toolsLabel =
      state.enabledTools === null
        ? `all ${allTools.length} tools`
        : `${state.enabledTools.length} of ${allTools.length} tools`;
    return (
      <EdRow
        key={`mcp:${s.mcpServerId}`}
        glyph={
          <Disc variant="conn" size="lg" shape="square">
            <span className="font-mono text-label-11">MCP</span>
          </Disc>
        }
        name={
          <>
            {s.label}
            <KindTag kind="MCP" />
          </>
        }
        meta={isConnected ? toolsLabel : `${allTools.length} tools`}
        actions={
          isConnected ? (
            <>
              <IcBtn
                title={isExpanded ? 'Hide tools' : 'Configure tools'}
                ariaLabel="Configure"
                onClick={() => toggleExpand(s.mcpServerId)}
              >
                <GearIcon />
              </IcBtn>
              <IcBtn
                title="Detach from this agent"
                ariaLabel="Detach"
                onClick={() => mcpToggleAssigned(s.mcpServerId, false)}
              >
                <CloseIcon />
              </IcBtn>
            </>
          ) : (
            <IcBtn
              title="Attach to this agent"
              ariaLabel="Attach"
              onClick={() => mcpToggleAssigned(s.mcpServerId, true)}
            >
              <PlusIcon />
            </IcBtn>
          )
        }
        expanded={
          isConnected && isExpanded ? (
            <>
              <div className="flex gap-2">
                <MiniBtn onClick={() => mcpEnableAll(s.mcpServerId)}>Enable all</MiniBtn>
                <MiniBtn onClick={() => mcpToggleAssigned(s.mcpServerId, false)}>
                  Uncheck all
                </MiniBtn>
              </div>
              <div className="space-y-0.5">
                {s.availableTools.map((tool) => {
                  const checked =
                    state.enabledTools === null || state.enabledTools.includes(tool.name);
                  return (
                    <Checkbox
                      key={tool.name}
                      tone="agent"
                      checked={checked}
                      onChange={() => mcpToggleTool(s.mcpServerId, tool.name, allTools)}
                      containerClassName="rounded px-1 py-1 text-body-13 transition-colors hover:bg-hover"
                      label={
                        <>
                          <code className="shrink-0 text-mono-12 text-ink-2">{tool.name}</code>
                          {tool.description && (
                            <span className="truncate text-body-12 italic text-ink-4">
                              {tool.description}
                            </span>
                          )}
                        </>
                      }
                    />
                  );
                })}
              </div>
            </>
          ) : null
        }
      />
    );
  }
}

// ─── Section + small helpers ─────────────────────────────────────────────────

function Section({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  /** Bouton rendu à droite de l'en-tête (ex. « + Attach connectors »). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-mono-11 uppercase tracking-[0.12em] text-ink-4">{label}</div>
          {hint && <p className="mt-1 text-body-12 leading-[1.5]! text-ink-3">{hint}</p>}
        </div>
        {action}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function KindTag({ kind }: { kind: 'API' | 'MCP' }) {
  return <span className="ml-2 text-mono-11 uppercase tracking-[0.04em] text-ink-4">{kind}</span>;
}

function MiniBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <RowActionButton onClick={onClick}>{children}</RowActionButton>;
}

function RiskBadge({ op }: { op: OperationDescriptor }) {
  const base =
    'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-label-11 uppercase tracking-wider';
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
