'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  createAgentAction,
  updateAgentAction,
  setAgentConnectorAssignmentAction,
  type AgentRow,
  type AgentEditRow,
  type LlmKeyUiRow,
  type AgentConnectorRow,
} from '@/lib/actions.ts';
import { prettyProviderName } from '@/lib/provider-names.ts';
import {
  detectModelProviders,
  isModelCompatibleWithProvider,
  type ProviderSlug,
} from '@/lib/model-provider-detect.ts';
import type { OperationDescriptor } from '@nodal-agents/shared';

type AgentRole = 'worker' | 'router' | 'planner';

interface CreateProps {
  mode?: 'create';
  llmKeys: LlmKeyUiRow[];
  agents?: AgentRow[];
  initial?: undefined;
  connectors?: AgentConnectorRow[];
}

interface EditProps {
  mode: 'edit';
  llmKeys: LlmKeyUiRow[];
  agents?: AgentRow[];
  initial: AgentEditRow;
  connectors?: AgentConnectorRow[];
}

type Props = CreateProps | EditProps;

// ─── Connector grid helpers ───────────────────────────────────────────────────

type ConnectorState = {
  assigned: boolean;
  enabledOperations: string[] | null;
};

type ConnectorStates = Map<string, ConnectorState>;

function riskBadge(op: OperationDescriptor): React.ReactNode {
  const base =
    'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider';
  if (op.risk === 'read') {
    return <span className={`${base} text-emerald-400 bg-emerald-400/10`}>read</span>;
  }
  if (op.risk === 'write') {
    return (
      <span className={`${base} text-amber-400 bg-amber-400/10`}>
        {op.requiresApproval ? '⚠ ' : ''}write
      </span>
    );
  }
  // destructive
  return <span className={`${base} text-red-400 bg-red-400/10`}>⚠ destr</span>;
}

interface ConnectorGridProps {
  agentId: string;
  connectors: AgentConnectorRow[];
}

function ConnectorGrid({ agentId, connectors }: ConnectorGridProps) {
  // Local state mirrors the server-provided assigned/enabledOperations per connector
  const [states, setStates] = useState<ConnectorStates>(() => {
    const m = new Map<string, ConnectorState>();
    for (const c of connectors) {
      m.set(c.connectorId, { assigned: c.assigned, enabledOperations: c.enabledOperations });
    }
    return m;
  });
  // Track which connectors are expanded (showing operation grid)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Debounce timers — key: connectorId, value: setTimeout handle
  const debounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const persist = useCallback(
    (connectorId: string, assigned: boolean, enabledOperations: string[] | null) => {
      // Clear existing debounce for this connector
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
      <p className="text-xs text-neutral-600">
        No connected adapters found.{' '}
        <a href="/connectors" className="underline hover:text-neutral-400 transition-colors">
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
          <div key={c.connectorId} className="rounded-lg border border-neutral-800 overflow-hidden">
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
                <span className="text-neutral-500 text-xs w-3 shrink-0">
                  {isExpanded ? '▾' : '▸'}
                </span>
                <span className="text-sm text-white font-medium truncate">
                  {c.label}
                  {c.credentialName ? (
                    <span className="text-neutral-500 font-normal"> ({c.credentialName})</span>
                  ) : null}
                </span>
                {summary ? (
                  <span className="text-xs text-neutral-500 shrink-0 ml-auto">{summary}</span>
                ) : null}
              </button>
            </div>

            {/* Operation grid — only when assigned and expanded */}
            {state.assigned && isExpanded && (
              <div className="border-t border-neutral-800 px-3 py-2 bg-neutral-950/40 space-y-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => enableAll(c.connectorId)}
                    className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 transition-colors"
                  >
                    Enable all
                  </button>
                  <button
                    type="button"
                    onClick={() => uncheckAll(c.connectorId)}
                    className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 transition-colors"
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
                        className="flex items-center gap-2 px-1 py-1 rounded text-sm cursor-pointer hover:bg-neutral-800/40"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOperation(c.connectorId, op.slug, ops)}
                          className="accent-violet-500 shrink-0"
                        />
                        <code className="font-mono text-xs text-neutral-300 shrink-0">
                          {op.slug}
                        </code>
                        {riskBadge(op)}
                        {op.description ? (
                          <span className="text-xs text-neutral-600 italic truncate">
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

// Map DB role columns back to the UX-level enum for pre-filling edit form.
function dbRoleToUiRole(
  role: string | null,
  orchestratorMode: string | null | undefined,
): AgentRole {
  if (role === 'orchestrator' && orchestratorMode === 'planner') return 'planner';
  if (role === 'orchestrator') return 'router';
  return 'worker';
}

export default function AgentForm(props: Props) {
  const isEdit = props.mode === 'edit';
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  // In edit mode, the form is always open (it IS the page content).
  const [open, setOpen] = useState(isEdit);

  // Derive initial role state from initial prop (edit) or default (create).
  const initialRole: AgentRole = isEdit
    ? dbRoleToUiRole(props.initial.role ?? null, props.initial.orchestratorMode ?? null)
    : 'worker';

  const [role, setRole] = useState<AgentRole>(initialRole);
  const [subAgentIds, setSubAgentIds] = useState<string[]>(isEdit ? props.initial.subAgentIds : []);

  // LLM provider + model state. In edit mode, prefill from initial.llmKeyId
  // (if set) or fall back to the first active key. In create mode, default to
  // the first active key.
  const activeKeys = useMemo(() => props.llmKeys.filter((k) => k.isActive), [props.llmKeys]);
  const initialLlmKeyId: string =
    (isEdit ? props.initial.llmKeyId : null) ?? activeKeys[0]?.id ?? '';
  const [llmKeyId, setLlmKeyId] = useState<string>(initialLlmKeyId);
  const [model, setModel] = useState<string>(isEdit ? (props.initial.model ?? '') : '');

  const selectedKey = useMemo(
    () => props.llmKeys.find((k) => k.id === llmKeyId) ?? null,
    [props.llmKeys, llmKeyId],
  );

  // ── Model ↔ key coherence (Brique 34quinquies follow-up) ────────────────────
  // Live bug: changing agent.model without changing agent.llmKeyId leaves the
  // key pointing at the wrong provider — runtime fails silently. We detect the
  // model's expected provider and (a) auto-switch when there's exactly one
  // compatible active key, (b) block save with an inline banner otherwise.

  const detectedProviders = useMemo<Set<ProviderSlug>>(() => detectModelProviders(model), [model]);

  const compatibleActiveKeys = useMemo(
    () =>
      activeKeys.filter((k) => isModelCompatibleWithProvider(model, k.provider as ProviderSlug)),
    [activeKeys, model],
  );

  const coherenceOk = selectedKey
    ? isModelCompatibleWithProvider(model, selectedKey.provider as ProviderSlug)
    : true;

  function handleLlmKeyChange(id: string) {
    const newKey = props.llmKeys.find((row) => row.id === id);
    const oldDefaultModel = selectedKey?.defaultModel ?? null;
    setLlmKeyId(id);
    // Auto-fill model with the new provider's defaultModel if (a) model is empty,
    // OR (b) the current model exactly matches the previous provider's default
    // (= user hadn't customized it, so switching providers can safely refresh).
    // Preserves a user's hand-typed custom model across provider switches.
    if (newKey?.defaultModel && (!model || model === oldDefaultModel)) {
      setModel(newKey.defaultModel);
    }
  }

  function handleModelChange(nextModel: string) {
    setModel(nextModel);
    // Auto-switch the key if (a) the current key is incompatible AND
    // (b) exactly one active key matches the new model. We never auto-switch
    // when multiple keys match (avoid surprise) or when none match (let the
    // user see the warning banner instead).
    if (!selectedKey) return;
    const currentlyCompatible = isModelCompatibleWithProvider(
      nextModel,
      selectedKey.provider as ProviderSlug,
    );
    if (currentlyCompatible) return;
    const candidates = activeKeys.filter((k) =>
      isModelCompatibleWithProvider(nextModel, k.provider as ProviderSlug),
    );
    if (candidates.length === 1 && candidates[0]) {
      setLlmKeyId(candidates[0].id);
      toast.success(
        `Switched provider to ${prettyProviderName(candidates[0].provider)} (matches ${nextModel})`,
      );
    }
  }

  useEffect(() => {
    if (!open || isEdit) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isEdit]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    if (isEdit && props.mode === 'edit') {
      const payload = {
        id: props.initial.id,
        name: fd.get('name'),
        personality: fd.get('personality'),
        model,
        llmKeyId: llmKeyId || null,
        role,
        subAgentIds: role === 'worker' ? [] : subAgentIds,
        workspaceRootPath: fd.get('workspaceRootPath') ?? '',
      };
      startTransition(async () => {
        const result = await updateAgentAction(payload);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        toast.success('Agent updated');
        router.push('/agents');
      });
    } else {
      const payload = {
        slug: fd.get('slug'),
        name: fd.get('name'),
        personality: fd.get('personality'),
        model,
        llmKeyId: llmKeyId || undefined,
        role,
        subAgentIds: role === 'worker' ? [] : subAgentIds,
        workspaceRootPath: fd.get('workspaceRootPath') ?? '',
      };
      startTransition(async () => {
        const result = await createAgentAction(payload);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        toast.success('Agent created');
        formRef.current?.reset();
        setRole('worker');
        setSubAgentIds([]);
        setLlmKeyId(activeKeys[0]?.id ?? '');
        setModel('');
        setOpen(false);
      });
    }
  }

  function toggleSubAgent(id: string) {
    setSubAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const agents = props.agents ?? [];
  const noLlmKeys = activeKeys.length === 0;
  const showSubAgents = role !== 'worker';
  const noAgentsForPicker = agents.length === 0;

  // ── Coherence banner (rendered under Model input in both edit + create) ────
  const coherenceBanner =
    !coherenceOk && selectedKey ? (
      <div
        role="alert"
        data-testid="model-provider-mismatch"
        className="mt-1 px-2 py-1.5 rounded border border-amber-700/50 bg-amber-900/20 text-[11px] text-amber-300 space-y-1"
      >
        <p>
          <span className="font-semibold">Provider mismatch:</span>{' '}
          <span className="font-mono">{model}</span> looks like it needs{' '}
          <span className="font-semibold">
            {Array.from(detectedProviders)
              .map((p) => prettyProviderName(p))
              .join(' or ')}
          </span>
          , but your selected key is{' '}
          <span className="font-semibold">{prettyProviderName(selectedKey.provider)}</span>.
        </p>
        {compatibleActiveKeys.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            <span className="text-amber-400/80">Switch to:</span>
            {compatibleActiveKeys.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => setLlmKeyId(k.id)}
                className="px-1.5 py-0.5 rounded border border-amber-700/60 text-amber-200 hover:bg-amber-800/30 font-medium"
              >
                {k.nickname ?? prettyProviderName(k.provider)} ({prettyProviderName(k.provider)})
              </button>
            ))}
          </div>
        ) : (
          <p>
            No compatible active key.{' '}
            <a href="/settings" className="underline hover:text-amber-100">
              Add one in Settings → LLM providers
            </a>
            .
          </p>
        )}
      </div>
    ) : null;

  // ─── Edit mode: form rendered inline (no modal/portal) ─────────────────────

  const connectorList = props.connectors ?? [];

  if (isEdit) {
    const initial = props.initial;

    return (
      <form ref={formRef} onSubmit={handleSubmit} className="w-full max-w-lg space-y-4">
        <h3 className="text-sm font-semibold text-white">Edit agent</h3>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-slug">
              Slug
            </label>
            <input
              id="agent-slug"
              name="slug"
              readOnly
              defaultValue={initial.slug}
              title="Slug is not editable"
              className="w-full bg-neutral-800/40 border border-neutral-700/50 rounded-lg px-3 py-2 text-sm text-neutral-500 cursor-not-allowed"
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-name">
              Name
            </label>
            <input
              id="agent-name"
              name="name"
              required
              defaultValue={initial.name}
              placeholder="My Agent"
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-personality">
            Personality / System prompt
          </label>
          <textarea
            id="agent-personality"
            name="personality"
            required
            rows={6}
            defaultValue={initial.personality}
            placeholder="You are a helpful assistant..."
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none resize-y"
          />
        </div>

        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-workspace-root">
            Workspace root path{' '}
            <span className="text-neutral-600">(optional — for file_* tools)</span>
          </label>
          <input
            id="agent-workspace-root"
            name="workspaceRootPath"
            type="text"
            defaultValue={isEdit ? (props.initial.workspaceRootPath ?? '') : ''}
            placeholder="C:\Users\you\Documents\MyVault  or  /home/you/notes"
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          <p className="text-[11px] text-neutral-600 mt-1">
            Absolute path. The agent&apos;s <code>file_read</code> / <code>file_write</code> /{' '}
            <code>file_edit</code> / <code>file_list</code> / <code>file_search</code> tools are
            scoped to this directory. Leave empty to disable file access.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-llm-key">
              LLM provider
            </label>
            {noLlmKeys ? (
              <p className="text-xs text-amber-400 mt-1">
                No active LLM providers. Add one in{' '}
                <a href="/settings" className="underline">
                  Settings → LLM providers
                </a>
                .
              </p>
            ) : (
              <select
                id="agent-llm-key"
                value={llmKeyId}
                onChange={(e) => handleLlmKeyChange(e.target.value)}
                required
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
              >
                {activeKeys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {(k.nickname ?? prettyProviderName(k.provider)) +
                      ' (' +
                      prettyProviderName(k.provider) +
                      ')'}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-model">
              Model
            </label>
            <input
              id="agent-model"
              name="model"
              type="text"
              required
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
              placeholder={selectedKey?.defaultModel ?? 'e.g. claude-haiku-4-5-20251001'}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
            />
            {coherenceBanner}
          </div>
        </div>

        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-role">
            Role
          </label>
          <select
            id="agent-role"
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
          >
            <option value="worker">Worker — runs its own tools and tasks</option>
            <option value="router">Router — delegates to one sub-agent at a time</option>
            <option value="planner">Planner — creates parallel tasks for sub-agents</option>
          </select>
        </div>

        {showSubAgents && (
          <div>
            <label className="block text-xs text-neutral-500 mb-1">
              Sub-agents <span className="text-neutral-600">({subAgentIds.length} selected)</span>
            </label>
            {noAgentsForPicker ? (
              <p className="text-xs text-amber-400 mt-1">
                Create at least one worker agent first — orchestrators need someone to delegate to.
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto bg-neutral-800/60 border border-neutral-700 rounded-lg divide-y divide-neutral-800">
                {agents.map((a) => {
                  const checked = subAgentIds.includes(a.id);
                  return (
                    <label
                      key={a.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-neutral-800/80"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSubAgent(a.id)}
                        className="accent-violet-500"
                      />
                      <span className="text-white">{a.name}</span>
                      <span className="font-mono text-xs text-neutral-500 ml-auto">{a.slug}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Tools & Connectors ─────────────────────────────────────── */}
        <div>
          <div className="mb-2">
            <label className="block text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-0.5">
              Tools &amp; Connectors
            </label>
            <p className="text-xs text-neutral-600">
              Choose which tools this agent can use. Fewer tools = smaller prompt + less chance the
              agent picks the wrong one.
            </p>
          </div>
          <ConnectorGrid agentId={initial.id} connectors={connectorList} />
          <p className="mt-2 text-xs text-neutral-600">
            <a href="/connectors" className="underline hover:text-neutral-400 transition-colors">
              Manage credentials in /connectors
            </a>
          </p>
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={isPending || noLlmKeys || !coherenceOk}
            title={!coherenceOk ? 'Pick a key that matches the model first' : undefined}
            className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/agents')}
            className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-400 rounded-lg hover:border-neutral-600 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  // ─── Create mode: toggle button + portal modal ──────────────────────────────

  const modal = open
    ? createPortal(
        <>
          <div
            className="fixed inset-0 bg-black/60 z-40 animate-[fadeIn_150ms_ease]"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="New agent"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <form
              ref={formRef}
              onSubmit={handleSubmit}
              className="pointer-events-auto w-full max-w-lg max-h-[90vh] overflow-y-auto bg-neutral-900 border border-neutral-800/60 rounded-xl p-6 space-y-4 shadow-2xl animate-[scaleIn_150ms_ease]"
            >
              <h3 className="text-sm font-semibold text-white">New agent</h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-slug">
                    Slug
                  </label>
                  <input
                    id="agent-slug"
                    name="slug"
                    required
                    pattern="[a-z0-9\-]+"
                    placeholder="my-agent"
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-name">
                    Name
                  </label>
                  <input
                    id="agent-name"
                    name="name"
                    required
                    placeholder="My Agent"
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-personality">
                  Personality / System prompt
                </label>
                <textarea
                  id="agent-personality"
                  name="personality"
                  required
                  rows={4}
                  placeholder="You are a helpful assistant..."
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none resize-none"
                />
              </div>

              <div>
                <label
                  className="block text-xs text-neutral-500 mb-1"
                  htmlFor="agent-workspace-root-create"
                >
                  Workspace root path{' '}
                  <span className="text-neutral-600">(optional — for file_* tools)</span>
                </label>
                <input
                  id="agent-workspace-root-create"
                  name="workspaceRootPath"
                  type="text"
                  placeholder="C:\Users\you\Documents\MyVault  or  /home/you/notes"
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
                />
                <p className="text-[11px] text-neutral-600 mt-1">
                  Absolute path. Leave empty to disable file access for this agent.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-llm-key">
                    LLM provider
                  </label>
                  {noLlmKeys ? (
                    <p className="text-xs text-amber-400 mt-1">
                      No active LLM providers. Add one in{' '}
                      <a href="/settings" className="underline">
                        Settings → LLM providers
                      </a>
                      .
                    </p>
                  ) : (
                    <select
                      id="agent-llm-key"
                      value={llmKeyId}
                      onChange={(e) => handleLlmKeyChange(e.target.value)}
                      required
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
                    >
                      {activeKeys.map((k) => (
                        <option key={k.id} value={k.id}>
                          {(k.nickname ?? prettyProviderName(k.provider)) +
                            ' (' +
                            prettyProviderName(k.provider) +
                            ')'}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-model">
                    Model
                  </label>
                  <input
                    id="agent-model"
                    name="model"
                    type="text"
                    required
                    value={model}
                    onChange={(e) => handleModelChange(e.target.value)}
                    placeholder={selectedKey?.defaultModel ?? 'e.g. claude-haiku-4-5-20251001'}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
                  />
                  {coherenceBanner}
                </div>
              </div>

              <div>
                <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-role">
                  Role
                </label>
                <select
                  id="agent-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as AgentRole)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
                >
                  <option value="worker">Worker — runs its own tools and tasks</option>
                  <option value="router">Router — delegates to one sub-agent at a time</option>
                  <option value="planner">Planner — creates parallel tasks for sub-agents</option>
                </select>
              </div>

              {showSubAgents && (
                <div>
                  <label className="block text-xs text-neutral-500 mb-1">
                    Sub-agents{' '}
                    <span className="text-neutral-600">({subAgentIds.length} selected)</span>
                  </label>
                  {noAgentsForPicker ? (
                    <p className="text-xs text-amber-400 mt-1">
                      Create at least one worker agent first — orchestrators need someone to
                      delegate to.
                    </p>
                  ) : (
                    <div className="max-h-40 overflow-y-auto bg-neutral-800/60 border border-neutral-700 rounded-lg divide-y divide-neutral-800">
                      {agents.map((a) => {
                        const checked = subAgentIds.includes(a.id);
                        return (
                          <label
                            key={a.id}
                            className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-neutral-800/80"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSubAgent(a.id)}
                              className="accent-violet-500"
                            />
                            <span className="text-white">{a.name}</span>
                            <span className="font-mono text-xs text-neutral-500 ml-auto">
                              {a.slug}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={isPending || noLlmKeys || !coherenceOk}
                  title={!coherenceOk ? 'Pick a key that matches the model first' : undefined}
                  className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPending ? 'Creating…' : 'Create agent'}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-400 rounded-lg hover:border-neutral-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 text-sm font-medium bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors"
      >
        + New agent
      </button>
      {modal}
    </>
  );
}
