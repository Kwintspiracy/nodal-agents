'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  updateAgentAction,
  type AgentRow,
  type AgentEditRow,
  type LlmKeyUiRow,
  type AgentConnectorRow,
  type AgentMcpServerRow,
} from '@/lib/actions.ts';
import { prettyProviderName } from '@/lib/provider-names.ts';
import {
  detectModelProviders,
  isModelCompatibleWithProvider,
  type ProviderSlug,
} from '@/lib/model-provider-detect.ts';
import AvatarPicker from '@/components/AvatarPicker.tsx';
import AgentConnectorGrid from '@/components/AgentConnectorGrid.tsx';
import AgentMcpServerGrid from '@/components/AgentMcpServerGrid.tsx';

/**
 * AgentComposer — three-column editor for /agents/[id]/edit, faithful to
 * the design handoff `screen-composer-v2.jsx`.
 *
 *   ┌──────── toolbar (crumbs · PN · Test / Schedule / Run stubs) ────────────┐
 *   ┌──────── hero (orb + name + role + stats meta + status pill) ───────────┐
 *   ┌──────── agent picker row ───────────────────────────────────────────────┐
 *   ┌────────────┬──────────────────────────────────────────────────────┬─────┐
 *   │ Identity   │ Tabs: Behavior · Skills · Connectors · Knowledge ·   │Live │
 *   │  sidebar   │       Run history                                    │panel│
 *   │ (form)     │ [active tab content]                                 │stub │
 *   └────────────┴──────────────────────────────────────────────────────┴─────┘
 *
 * Every editing capability previously living in `AgentForm.tsx` is ported
 * here, distributed across the handoff zones:
 *
 *  - IDENTITY sidebar (left) → name, slug (read-only), avatar, LLM key,
 *    model + coherence banner, role. Save / Cancel at the bottom.
 *  - BEHAVIOR tab → persona textarea, sub-agents picker (if role≠worker).
 *  - CONNECTORS tab → AgentConnectorGrid (per-agent connector + ops list).
 *  - KNOWLEDGE tab → workspace root path + AgentMcpServerGrid.
 *  - SKILLS tab + RUN HISTORY tab → honest stubs (no per-agent data yet).
 *  - TOOLBAR Test/Schedule/Run + LIVE panel → visual stubs as agreed.
 *
 * AgentForm.tsx is no longer rendered here — it is reserved for create-mode
 * (the "+ New agent" modal on /agents).
 */

type Tab = 'behavior' | 'skills' | 'connectors' | 'knowledge' | 'runs';
type AgentRole = 'worker' | 'router' | 'planner';

function dbRoleToUiRole(
  role: string | null,
  orchestratorMode: string | null | undefined,
): AgentRole {
  if (role === 'orchestrator' && orchestratorMode === 'planner') return 'planner';
  if (role === 'orchestrator') return 'router';
  return 'worker';
}

interface Props {
  agent: AgentEditRow;
  peers: AgentRow[];
  llmKeys: LlmKeyUiRow[];
  connectors: AgentConnectorRow[];
  mcpServers: AgentMcpServerRow[];
}

export default function AgentComposer({ agent, peers, llmKeys, connectors, mcpServers }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>('behavior');

  // ── form state (centralised — no nested form component) ───────────────────
  const initialRole = dbRoleToUiRole(agent.role ?? null, agent.orchestratorMode ?? null);
  const activeKeys = useMemo(() => llmKeys.filter((k) => k.isActive), [llmKeys]);
  const initialLlmKeyId = agent.llmKeyId ?? activeKeys[0]?.id ?? '';

  const [name, setName] = useState(agent.name);
  const [personality, setPersonality] = useState(agent.personality ?? '');
  const [role, setRole] = useState<AgentRole>(initialRole);
  const [subAgentIds, setSubAgentIds] = useState<string[]>(agent.subAgentIds);
  const [llmKeyId, setLlmKeyId] = useState<string>(initialLlmKeyId);
  const [model, setModel] = useState<string>(agent.model ?? '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(agent.avatarUrl ?? null);
  const [workspaceRootPath, setWorkspaceRootPath] = useState<string>(agent.workspaceRootPath ?? '');

  // ── derived ──────────────────────────────────────────────────────────────
  const selectedKey = useMemo(
    () => llmKeys.find((k) => k.id === llmKeyId) ?? null,
    [llmKeys, llmKeyId],
  );
  const detectedProviders = useMemo<Set<ProviderSlug>>(() => detectModelProviders(model), [model]);
  const compatibleActiveKeys = useMemo(
    () =>
      activeKeys.filter((k) => isModelCompatibleWithProvider(model, k.provider as ProviderSlug)),
    [activeKeys, model],
  );
  const coherenceOk = selectedKey
    ? isModelCompatibleWithProvider(model, selectedKey.provider as ProviderSlug)
    : true;
  const noLlmKeys = activeKeys.length === 0;
  const showSubAgents = role !== 'worker';
  const partNumber = `agt-${agent.slug.slice(0, 8)}`.toUpperCase();
  const initial = (agent.name || agent.slug).slice(0, 1).toUpperCase();

  const assignedConnectors = connectors.filter((c) => c.assigned).length;
  const assignedMcps = mcpServers.filter((s) => s.assigned).length;

  // Dirty detection — drives Save/Cancel enabled state
  const dirty =
    name !== agent.name ||
    personality !== (agent.personality ?? '') ||
    role !== initialRole ||
    JSON.stringify([...subAgentIds].sort()) !== JSON.stringify([...agent.subAgentIds].sort()) ||
    llmKeyId !== initialLlmKeyId ||
    model !== (agent.model ?? '') ||
    avatarUrl !== (agent.avatarUrl ?? null) ||
    workspaceRootPath !== (agent.workspaceRootPath ?? '');

  // ── handlers ─────────────────────────────────────────────────────────────
  function handleLlmKeyChange(id: string) {
    const newKey = llmKeys.find((row) => row.id === id);
    const oldDefault = selectedKey?.defaultModel ?? null;
    setLlmKeyId(id);
    if (newKey?.defaultModel && (!model || model === oldDefault)) {
      setModel(newKey.defaultModel);
    }
  }

  function handleModelChange(next: string) {
    setModel(next);
    if (!selectedKey) return;
    if (isModelCompatibleWithProvider(next, selectedKey.provider as ProviderSlug)) return;
    const candidates = activeKeys.filter((k) =>
      isModelCompatibleWithProvider(next, k.provider as ProviderSlug),
    );
    if (candidates.length === 1 && candidates[0]) {
      setLlmKeyId(candidates[0].id);
      toast.success(
        `Switched provider to ${prettyProviderName(candidates[0].provider)} (matches ${next})`,
      );
    }
  }

  function toggleSubAgent(id: string) {
    setSubAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleSave() {
    if (!coherenceOk || noLlmKeys || isPending || !dirty) return;
    const payload = {
      id: agent.id,
      name,
      personality,
      model,
      llmKeyId: llmKeyId || null,
      role,
      subAgentIds: role === 'worker' ? [] : subAgentIds,
      workspaceRootPath,
      avatarUrl,
    };
    startTransition(async () => {
      const result = await updateAgentAction(payload);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success('Agent updated');
      router.refresh();
    });
  }

  function handleCancel() {
    setName(agent.name);
    setPersonality(agent.personality ?? '');
    setRole(initialRole);
    setSubAgentIds(agent.subAgentIds);
    setLlmKeyId(initialLlmKeyId);
    setModel(agent.model ?? '');
    setAvatarUrl(agent.avatarUrl ?? null);
    setWorkspaceRootPath(agent.workspaceRootPath ?? '');
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="-mx-6 -my-6 flex flex-col lg:-mx-8">
      <Toolbar agentName={agent.name} pn={partNumber} />

      <div className="px-6 pt-4 pb-10 lg:px-8">
        <Hero
          initial={initial}
          avatarUrl={avatarUrl}
          name={name}
          slug={agent.slug}
          role={role}
          stats={{
            subAgents: role === 'worker' ? 0 : subAgentIds.length,
            connectors: assignedConnectors,
            mcps: assignedMcps,
          }}
        />

        <AgentPicker
          agents={[{ id: agent.id, name: agent.name, slug: agent.slug } as AgentRow, ...peers]}
          activeId={agent.id}
        />

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
          <IdentitySidebar
            pn={partNumber}
            name={name}
            slug={agent.slug}
            avatarUrl={avatarUrl}
            llmKeyId={llmKeyId}
            llmKeys={llmKeys}
            activeKeys={activeKeys}
            selectedKey={selectedKey}
            model={model}
            role={role}
            coherenceOk={coherenceOk}
            detectedProviders={detectedProviders}
            compatibleActiveKeys={compatibleActiveKeys}
            noLlmKeys={noLlmKeys}
            dirty={dirty}
            isPending={isPending}
            onChangeName={setName}
            onChangeAvatar={setAvatarUrl}
            onChangeLlmKey={handleLlmKeyChange}
            onChangeModel={handleModelChange}
            onChangeRole={setRole}
            onSwitchToCompatibleKey={setLlmKeyId}
            onSave={handleSave}
            onCancel={handleCancel}
          />

          <section className="min-w-0">
            <TabsStrip
              tab={tab}
              onChange={setTab}
              counts={{
                skills: 0,
                connectors: assignedConnectors,
                knowledge: assignedMcps,
                runs: 0,
              }}
            />

            {tab === 'behavior' && (
              <BehaviorTab
                personality={personality}
                onChangePersonality={setPersonality}
                showSubAgents={showSubAgents}
                subAgentIds={subAgentIds}
                peers={peers}
                onToggleSubAgent={toggleSubAgent}
              />
            )}
            {tab === 'skills' && <SkillsTabStub slug={agent.slug} />}
            {tab === 'connectors' && (
              <AgentConnectorGrid agentId={agent.id} connectors={connectors} />
            )}
            {tab === 'knowledge' && (
              <KnowledgeTab
                agentId={agent.id}
                mcpServers={mcpServers}
                workspaceRootPath={workspaceRootPath}
                onChangeWorkspaceRootPath={setWorkspaceRootPath}
              />
            )}
            {tab === 'runs' && <RunsTabStub slug={agent.slug} />}
          </section>

          <LivePanel />
        </div>
      </div>
    </div>
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

function Toolbar({ agentName, pn }: { agentName: string; pn: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-rule-2 bg-canvas px-6 py-3.5 lg:px-8">
      <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
        <Link href="/agents" className="hover:text-ink-2 transition-colors">
          Agents
        </Link>
        <span className="text-ink-4">/</span>
        <span className="font-medium text-ink">{agentName}</span>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-4">{pn}</span>
      <div className="flex-1" />
      <ToolbarBtn label="Test" disabled />
      <ToolbarBtn label="Schedule" disabled />
      <ToolbarBtn label="Run" primary disabled />
    </div>
  );
}

function ToolbarBtn({
  label,
  primary,
  disabled,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
}) {
  const base =
    'inline-flex h-[30px] items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const skin = primary
    ? 'bg-ink text-canvas hover:brightness-[0.92]'
    : 'border border-rule text-ink-3 hover:border-rule-2 hover:text-ink-2';
  return (
    <button type="button" className={`${base} ${skin}`} disabled={disabled} title="Coming soon">
      {label}
    </button>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

function Hero({
  initial,
  avatarUrl,
  name,
  slug,
  role,
  stats,
}: {
  initial: string;
  avatarUrl: string | null;
  name: string;
  slug: string;
  role: AgentRole;
  stats: { subAgents: number; connectors: number; mcps: number };
}) {
  return (
    <div className="mb-6 flex items-end gap-[22px]">
      <div className="relative flex h-[96px] w-[96px] flex-shrink-0 items-center justify-center rounded-full bg-agent-vivid text-[28px] font-semibold text-white shadow-[0_6px_18px_rgba(28,35,48,0.18)]">
        <span className="pointer-events-none absolute -inset-[14px] rounded-full border border-rule" />
        <span className="pointer-events-none absolute -inset-[26px] rounded-full border border-dashed border-rule" />
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
        ) : (
          initial
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-[32px] font-semibold leading-[1.05] tracking-[-0.02em] text-ink">
          {name || 'Untitled agent'}
          <span className="ml-2 font-normal text-ink-3">, {role}</span>
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11px] tracking-[0.04em] text-ink-3">
          <Stat n={stats.connectors} label="connectors" />
          <Stat n={stats.mcps} label="MCPs" />
          {role !== 'worker' && <Stat n={stats.subAgents} label="sub-agents" />}
          <span className="text-ink-4">@{slug}</span>
        </div>
      </div>
      <StatusPill running={false} />
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span>
      <b className="font-medium text-ink-2">{n}</b>
      <span className="ml-1">{label}</span>
    </span>
  );
}

function StatusPill({ running }: { running: boolean }) {
  const skin = running
    ? 'bg-skill-vivid/10 text-skill-vivid'
    : 'bg-agent-vivid/10 text-agent-vivid';
  return (
    <div
      className={`inline-flex h-[26px] items-center gap-1.5 rounded-full px-3 text-[11.5px] font-medium ${skin}`}
    >
      <span
        className={`h-[7px] w-[7px] rounded-full ${running ? 'bg-skill-vivid' : 'bg-agent-vivid'}`}
      />
      {running ? 'RUNNING' : 'IDLE'}
    </div>
  );
}

// ─── Agent picker ─────────────────────────────────────────────────────────────

function AgentPicker({ agents, activeId }: { agents: AgentRow[]; activeId: string }) {
  if (agents.length <= 1) return null;
  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {agents.map((a) => {
        const isActive = a.id === activeId;
        return (
          <Link
            key={a.id}
            href={`/agents/${a.id}/edit`}
            className={[
              'inline-flex h-[30px] items-center gap-1.5 rounded-[7px] border px-3 text-[12.5px] font-medium transition-colors',
              isActive
                ? 'border-agent-vivid bg-agent-vivid text-white'
                : 'border-rule bg-paper text-ink-2 hover:border-rule-2 hover:text-ink',
            ].join(' ')}
          >
            <span
              className={`inline-block h-[7px] w-[7px] rounded-full ${isActive ? 'bg-white' : 'bg-agent-vivid'}`}
            />
            {a.name}
          </Link>
        );
      })}
    </div>
  );
}

// ─── Identity sidebar (form) ─────────────────────────────────────────────────

function IdentitySidebar(props: {
  pn: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  llmKeyId: string;
  llmKeys: LlmKeyUiRow[];
  activeKeys: LlmKeyUiRow[];
  selectedKey: LlmKeyUiRow | null;
  model: string;
  role: AgentRole;
  coherenceOk: boolean;
  detectedProviders: Set<ProviderSlug>;
  compatibleActiveKeys: LlmKeyUiRow[];
  noLlmKeys: boolean;
  dirty: boolean;
  isPending: boolean;
  onChangeName: (v: string) => void;
  onChangeAvatar: (v: string | null) => void;
  onChangeLlmKey: (id: string) => void;
  onChangeModel: (v: string) => void;
  onChangeRole: (r: AgentRole) => void;
  onSwitchToCompatibleKey: (id: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const {
    pn,
    name,
    slug,
    avatarUrl,
    llmKeyId,
    activeKeys,
    selectedKey,
    model,
    role,
    coherenceOk,
    detectedProviders,
    compatibleActiveKeys,
    noLlmKeys,
    dirty,
    isPending,
    onChangeName,
    onChangeAvatar,
    onChangeLlmKey,
    onChangeModel,
    onChangeRole,
    onSwitchToCompatibleKey,
    onSave,
    onCancel,
  } = props;

  return (
    <aside className="rounded-xl border border-rule-2 bg-paper p-[18px] lg:sticky lg:top-4">
      <div className="mb-3 flex items-center justify-between font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
        <span>Identity</span>
        <span>{pn}</span>
      </div>

      <div className="flex flex-col gap-3.5">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder="Agent name"
            className="w-full rounded-md border border-rule bg-canvas px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
          />
        </Field>

        <Field label="Slug">
          <code className="block w-full rounded-md border border-rule-2 bg-hover px-2.5 py-1.5 font-mono text-[11.5px] tracking-[0.02em] text-ink-3">
            {slug}
          </code>
        </Field>

        <Field label="Avatar">
          <AvatarPicker value={avatarUrl} onChange={onChangeAvatar} />
        </Field>

        <Field label="LLM provider">
          {noLlmKeys ? (
            <p className="text-[11.5px] text-warn">
              No active LLM keys.{' '}
              <Link href="/llm-providers" className="underline">
                Add one
              </Link>
              .
            </p>
          ) : (
            <select
              value={llmKeyId}
              onChange={(e) => onChangeLlmKey(e.target.value)}
              className="w-full rounded-md border border-rule bg-canvas px-2 py-1.5 text-[13px] text-ink focus:border-ink-3 focus:outline-none"
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
        </Field>

        <Field label="Model">
          <input
            type="text"
            value={model}
            onChange={(e) => onChangeModel(e.target.value)}
            placeholder={selectedKey?.defaultModel ?? 'e.g. claude-haiku-4-5-20251001'}
            className="w-full rounded-md border border-rule bg-canvas px-2.5 py-1.5 font-mono text-[11.5px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
          />
          {!coherenceOk && selectedKey && (
            <div
              role="alert"
              data-testid="model-provider-mismatch"
              className="mt-1 space-y-1 rounded border border-warn/30 bg-warn-bg px-2 py-1.5 text-[11px] text-warn"
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
                  <span className="text-warn/80">Switch to:</span>
                  {compatibleActiveKeys.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      onClick={() => onSwitchToCompatibleKey(k.id)}
                      className="rounded border border-warn/30 px-1.5 py-0.5 font-medium text-warn hover:bg-warn-bg"
                    >
                      {k.nickname ?? prettyProviderName(k.provider)} (
                      {prettyProviderName(k.provider)})
                    </button>
                  ))}
                </div>
              ) : (
                <p>
                  No compatible active key.{' '}
                  <Link href="/llm-providers" className="underline hover:text-warn">
                    Add one
                  </Link>
                  .
                </p>
              )}
            </div>
          )}
        </Field>

        <Field label="Role">
          <select
            value={role}
            onChange={(e) => onChangeRole(e.target.value as AgentRole)}
            className="w-full rounded-md border border-rule bg-canvas px-2 py-1.5 text-[13px] text-ink focus:border-ink-3 focus:outline-none"
          >
            <option value="worker">Worker — runs its own tools</option>
            <option value="router">Router — delegates one at a time</option>
            <option value="planner">Planner — parallel sub-agents</option>
          </select>
        </Field>
      </div>

      <div className="mt-5 flex gap-2 border-t border-rule-2 pt-4">
        <button
          type="button"
          onClick={onSave}
          disabled={isPending || noLlmKeys || !coherenceOk || !dirty}
          title={
            !coherenceOk
              ? 'Pick a key that matches the model first'
              : !dirty
                ? 'No changes to save'
                : undefined
          }
          className="flex-1 rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-canvas transition-colors hover:brightness-[0.92] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending || !dirty}
          className="rounded-lg border border-rule px-4 py-2 text-[13px] font-medium text-ink-3 transition-colors hover:border-rule-2 hover:text-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-4">
        {label}
      </label>
      <div>{children}</div>
    </div>
  );
}

// ─── Tabs strip ───────────────────────────────────────────────────────────────

function TabsStrip({
  tab,
  onChange,
  counts,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: { skills: number; connectors: number; knowledge: number; runs: number };
}) {
  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'behavior', label: 'Behavior' },
    { id: 'skills', label: 'Skills', count: counts.skills },
    { id: 'connectors', label: 'Connectors', count: counts.connectors },
    { id: 'knowledge', label: 'Knowledge', count: counts.knowledge },
    { id: 'runs', label: 'Run history', count: counts.runs },
  ];
  return (
    <div className="-mb-px mb-[18px] flex gap-0 border-b border-rule-2">
      {TABS.map((t) => {
        const isActive = tab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={[
              'border-b-2 px-3.5 pt-2.5 pb-3 text-[13px] font-medium transition-colors',
              isActive ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
            ].join(' ')}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={`ml-1 font-mono text-[10px] ${isActive ? 'text-ink-2' : 'text-ink-4'}`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Behavior tab ─────────────────────────────────────────────────────────────

function BehaviorTab({
  personality,
  onChangePersonality,
  showSubAgents,
  subAgentIds,
  peers,
  onToggleSubAgent,
}: {
  personality: string;
  onChangePersonality: (v: string) => void;
  showSubAgents: boolean;
  subAgentIds: string[];
  peers: AgentRow[];
  onToggleSubAgent: (id: string) => void;
}) {
  return (
    <div className="space-y-6">
      <section>
        <SectionHead label="Personality / system prompt" />
        <textarea
          value={personality}
          onChange={(e) => onChangePersonality(e.target.value)}
          rows={10}
          placeholder="You are a helpful assistant…"
          className="w-full resize-y rounded-lg border border-rule-2 bg-paper px-4 py-3 font-mono text-[12.5px] leading-[1.55] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
        />
        <p className="mt-1.5 text-[11px] text-ink-4">
          Updating the persona invalidates the system-prompt cache for active jobs — the new prompt
          applies to runs started after Save.
        </p>
      </section>

      {showSubAgents && (
        <section>
          <SectionHead
            label={`Sub-agents · ${subAgentIds.length} selected`}
            hint="The orchestrator can delegate to any sub-agent you check below."
          />
          {peers.length === 0 ? (
            <p className="text-[12.5px] text-warn">
              Create at least one worker agent first — orchestrators need someone to delegate to.
            </p>
          ) : (
            <div className="divide-y divide-rule-2 overflow-hidden rounded-lg border border-rule-2 bg-paper">
              {peers.map((a) => {
                const checked = subAgentIds.includes(a.id);
                return (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleSubAgent(a.id)}
                      className="accent-agent-vivid"
                    />
                    <span className="text-ink">{a.name}</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-3">{a.slug}</span>
                  </label>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ─── Tab stubs ────────────────────────────────────────────────────────────────

function SkillsTabStub({ slug }: { slug: string }) {
  return (
    <StubPanel
      title="Skills assigned to this agent"
      body={
        <>
          Per-agent skill assignment surfaces here once the data layer exposes it. In the meantime,
          manage the skill catalogue and assignments from the{' '}
          <Link href="/skills" className="underline hover:text-ink-2">
            Skills page
          </Link>
          .
        </>
      }
      hint={`@${slug}`}
    />
  );
}

function RunsTabStub({ slug }: { slug: string }) {
  return (
    <StubPanel
      title="Recent runs"
      body={
        <>
          Run history filtered to this agent will live here. For now, see{' '}
          <Link href="/jobs" className="underline hover:text-ink-2">
            all runs
          </Link>
          .
        </>
      }
      hint={`@${slug}`}
    />
  );
}

// ─── Knowledge tab ────────────────────────────────────────────────────────────

function KnowledgeTab({
  agentId,
  mcpServers,
  workspaceRootPath,
  onChangeWorkspaceRootPath,
}: {
  agentId: string;
  mcpServers: AgentMcpServerRow[];
  workspaceRootPath: string;
  onChangeWorkspaceRootPath: (v: string) => void;
}) {
  return (
    <div className="space-y-6">
      <section>
        <SectionHead
          label="Workspace root"
          hint="Absolute path. Scopes file_read/write/edit/list/search tools. Empty = no file access."
        />
        <input
          type="text"
          value={workspaceRootPath}
          onChange={(e) => onChangeWorkspaceRootPath(e.target.value)}
          placeholder="C:\Users\you\Documents\MyVault  or  /home/you/notes"
          className="w-full rounded-md border border-rule bg-paper px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
        />
      </section>

      <section>
        <SectionHead
          label="MCP knowledge sources"
          hint="Tools from connected MCP servers. Expand a server to whitelist individual tools."
        />
        <AgentMcpServerGrid agentId={agentId} servers={mcpServers} />
        <p className="mt-2 text-[11px] text-ink-4">
          <Link href="/mcp" className="underline hover:text-ink-3">
            Manage MCP servers in /mcp
          </Link>
        </p>
      </section>
    </div>
  );
}

// ─── Section head ─────────────────────────────────────────────────────────────

function SectionHead({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="mb-3">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">{label}</div>
      {hint && <p className="mt-1 text-[11.5px] leading-[1.5] text-ink-3">{hint}</p>}
    </div>
  );
}

function StubPanel({ title, body, hint }: { title: string; body: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-rule-2 bg-paper px-6 py-10 text-center">
      <p className="mb-1 text-[13px] font-medium text-ink">{title}</p>
      <p className="mx-auto max-w-[420px] text-[12.5px] leading-[1.55] text-ink-3">{body}</p>
      {hint && (
        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-4">{hint}</p>
      )}
    </div>
  );
}

// ─── Live panel (right) — stub ────────────────────────────────────────────────

const LIVE_STUB = [
  { t: '00:42', lbl: 'summarize → email.send', sub: '5 threads · sent draft', st: 'ok' as const },
  { t: '01:18', lbl: 'web.search → summarize', sub: 'Q3 press · 8 sources', st: 'ok' as const },
  { t: '02:04', lbl: 'approval pending', sub: 'awaiting elena.m@', st: 'warn' as const },
  { t: '04:11', lbl: 'vec.search', sub: '312 ctx tokens', st: 'ok' as const },
  { t: '06:30', lbl: 'summarize', sub: 'truncated at 800 tok', st: 'warn' as const },
  { t: '09:51', lbl: 'email.send', sub: '4 sent · 0 failed', st: 'ok' as const },
  { t: '12:00', lbl: 'sql.query failed', sub: 'timeout @ 30s', st: 'err' as const },
  { t: '14:22', lbl: 'vec.search → summarize', sub: 'draft generated', st: 'ok' as const },
];

function LivePanel() {
  return (
    <aside className="rounded-xl border border-rule-2 bg-paper px-3.5 pt-3.5 pb-1.5 lg:sticky lg:top-4">
      <div className="mb-2 flex items-center justify-between font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
        <span>Live · last hour</span>
        <span>stub</span>
      </div>
      {LIVE_STUB.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-[60px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-dashed border-rule-2 py-2 text-[11.5px] last:border-b-0"
        >
          <span className="font-mono text-[10px] tracking-[0.04em] text-ink-4">−{r.t}</span>
          <span className="leading-[1.3] text-ink-2">
            {r.lbl}
            <span className="block font-mono text-[9.5px] text-ink-4">{r.sub}</span>
          </span>
          <LiveStatusPill st={r.st} />
        </div>
      ))}
      <p className="border-t border-rule-2 px-1 py-3 text-[10.5px] leading-[1.5] text-ink-4">
        Visual stub — will wire to runner telemetry.
      </p>
    </aside>
  );
}

function LiveStatusPill({ st }: { st: 'ok' | 'warn' | 'err' }) {
  const skin =
    st === 'ok'
      ? 'bg-agent-vivid/10 text-agent-vivid'
      : st === 'warn'
        ? 'bg-skill-vivid/10 text-skill-vivid'
        : 'bg-warn-bg text-err';
  return (
    <span className={`rounded-full px-1.5 py-0.5 font-mono text-[9.5px] tracking-[0.06em] ${skin}`}>
      {st.toUpperCase()}
    </span>
  );
}
