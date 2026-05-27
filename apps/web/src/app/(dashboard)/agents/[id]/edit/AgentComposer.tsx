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
 * AgentComposer — detail page for /agents/[id]/edit, faithful to the
 * reference screenshot Quentin shared (2026-05-27).
 *
 *   Back to agents
 *
 *   [● Atlas] [● Meridian] [● Quill] …                       ← agent picker pills
 *
 *   ╔══════════════════════════════════════════════════════════╗
 *   ║ ▢ avatar   Atlas   ● Idle      [Duplicate][Configure][▶ Run]║   ← hero card
 *   ║            Research lead · Reads broadly, summarises tightly…║
 *   ║            branch main · Model: opus-4 · Owner: Léa · Created …║
 *   ║   ──────────────────────────────────────────────────────────║
 *   ║   RUNS (7D)  SUCCESS RATE  AVG DURATION  TOKENS/JOB  COST/DAY P95║
 *   ║   1,284      99.2%         1m 12s        4,820       $12.40  2.4s║
 *   ╚══════════════════════════════════════════════════════════╝
 *
 *   [Overview*] [Skills] [Connectors] [Runs] [Settings]        ← tabs underline
 *
 *   ┌────────────────────────── overview ──────────────────────┐
 *   │ ┌── runs · 7 days ────────────┐  ┌── connectors used ──┐ │
 *   │ │ 1,219 successful runs       │  │ ● Notion · conn     │ │
 *   │ │ [lime area chart]           │  │ ● Drive  · conn     │ │
 *   │ └──────────────────────────────┘  │ ● Slack  · conn     │ │
 *   │                                   └──────────────────────┘ │
 *   │ ┌── Skills attached ─── 5 · 243 invocations ──────────┐  │
 *   │ │ [+ Web Search] [+ Web Fetch] [+ Summarize] …         │  │
 *   │ └────────────────────────────────────────────────────────┘  │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The Settings tab is where editing happens — name, persona, role, LLM
 * key, model, avatar, workspace root, sub-agents. Save / Cancel live in
 * that tab next to a dirty-state indicator.
 *
 * Overview pulls real data where we have it (connectors assigned,
 * MCPs assigned, sub-agents); the chart + runs/cost/latency strip are
 * honest stubs labelled "—" since per-agent telemetry is not yet wired.
 *
 * AgentForm.tsx remains for the create-mode modal on /agents only.
 */

type Tab = 'overview' | 'skills' | 'connectors' | 'runs' | 'settings';
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
  const [tab, setTab] = useState<Tab>('overview');

  // ── form state (only the Settings tab edits these) ────────────────────────
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
  const initial = (agent.name || agent.slug).slice(0, 1).toUpperCase();

  const assignedConnectorRows = connectors.filter((c) => c.assigned);
  const assignedConnectors = assignedConnectorRows.length;
  const assignedMcps = mcpServers.filter((s) => s.assigned).length;
  const subAgentCount = role === 'worker' ? 0 : subAgentIds.length;
  const personaPreview =
    (personality || '').split(/\n+/).filter(Boolean)[0]?.trim() ?? 'No description yet.';

  // Dirty detection — drives Settings save/reset
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

  function handleReset() {
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
    <div className="space-y-6">
      <BackLink />

      <AgentPicker
        agents={[{ id: agent.id, name: agent.name, slug: agent.slug } as AgentRow, ...peers]}
        activeId={agent.id}
      />

      <HeroCard
        initial={initial}
        avatarUrl={avatarUrl}
        name={agent.name}
        personaPreview={personaPreview}
        role={initialRole}
        slug={agent.slug}
        model={agent.model}
        llmKeyLabel={
          llmKeys.find((k) => k.id === agent.llmKeyId)?.nickname ??
          (llmKeys.find((k) => k.id === agent.llmKeyId)?.provider
            ? prettyProviderName(
                llmKeys.find((k) => k.id === agent.llmKeyId)!.provider as ProviderSlug,
              )
            : null)
        }
        stats={{
          connectors: assignedConnectors,
          mcps: assignedMcps,
          subAgents: subAgentCount,
        }}
        onConfigure={() => setTab('settings')}
      />

      <TabsBar
        tab={tab}
        onChange={setTab}
        counts={{ connectors: assignedConnectors, knowledge: assignedMcps }}
      />

      {tab === 'overview' && (
        <OverviewTab connectorsAssigned={assignedConnectorRows} mcpsAssignedCount={assignedMcps} />
      )}
      {tab === 'skills' && <SkillsTabStub slug={agent.slug} />}
      {tab === 'connectors' && (
        <SectionCard>
          <AgentConnectorGrid agentId={agent.id} connectors={connectors} />
        </SectionCard>
      )}
      {tab === 'runs' && <RunsTabStub slug={agent.slug} />}
      {tab === 'settings' && (
        <SettingsTab
          name={name}
          slug={agent.slug}
          avatarUrl={avatarUrl}
          personality={personality}
          role={role}
          showSubAgents={showSubAgents}
          subAgentIds={subAgentIds}
          peers={peers}
          llmKeyId={llmKeyId}
          activeKeys={activeKeys}
          selectedKey={selectedKey}
          model={model}
          coherenceOk={coherenceOk}
          detectedProviders={detectedProviders}
          compatibleActiveKeys={compatibleActiveKeys}
          noLlmKeys={noLlmKeys}
          workspaceRootPath={workspaceRootPath}
          mcpServers={mcpServers}
          agentId={agent.id}
          dirty={dirty}
          isPending={isPending}
          onChangeName={setName}
          onChangeAvatar={setAvatarUrl}
          onChangePersonality={setPersonality}
          onChangeRole={setRole}
          onToggleSubAgent={toggleSubAgent}
          onChangeLlmKey={handleLlmKeyChange}
          onChangeModel={handleModelChange}
          onSwitchKey={setLlmKeyId}
          onChangeWorkspaceRootPath={setWorkspaceRootPath}
          onSave={handleSave}
          onReset={handleReset}
        />
      )}
    </div>
  );
}

// ─── Back link ────────────────────────────────────────────────────────────────

function BackLink() {
  return (
    <Link
      href="/agents"
      className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink-2 transition-colors"
    >
      <span className="text-[14px] leading-none">‹</span>
      Back to agents
    </Link>
  );
}

// ─── Agent picker pills ───────────────────────────────────────────────────────

function AgentPicker({ agents, activeId }: { agents: AgentRow[]; activeId: string }) {
  if (agents.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {agents.map((a) => {
        const isActive = a.id === activeId;
        return (
          <Link
            key={a.id}
            href={`/agents/${a.id}/edit`}
            className={[
              'inline-flex h-[34px] items-center gap-2 rounded-full border px-3.5 text-[13px] font-medium transition-colors',
              isActive
                ? 'border-rule-2 bg-paper text-ink'
                : 'border-rule bg-canvas text-ink-3 hover:border-rule-2 hover:text-ink-2',
            ].join(' ')}
          >
            <span
              className="inline-block h-[7px] w-[7px] rounded-full bg-agent-vivid"
              style={{ boxShadow: isActive ? '0 0 0 2px rgba(255,255,255,0.06)' : undefined }}
            />
            {a.name}
          </Link>
        );
      })}
    </div>
  );
}

// ─── Hero card ────────────────────────────────────────────────────────────────

function HeroCard({
  initial,
  avatarUrl,
  name,
  personaPreview,
  role,
  slug,
  model,
  llmKeyLabel,
  stats,
  onConfigure,
}: {
  initial: string;
  avatarUrl: string | null;
  name: string;
  personaPreview: string;
  role: AgentRole;
  slug: string;
  model: string | null;
  llmKeyLabel: string | null;
  stats: { connectors: number; mcps: number; subAgents: number };
  onConfigure: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
      <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-start">
        {/* Avatar */}
        <div className="flex h-[80px] w-[80px] flex-shrink-0 items-center justify-center rounded-2xl bg-agent-vivid text-[28px] font-semibold text-canvas">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="h-full w-full rounded-2xl object-cover" />
          ) : (
            initial
          )}
        </div>

        {/* Title + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 text-[22px] font-semibold leading-none tracking-[-0.01em] text-ink">
              {name}
            </h1>
            <StatusPill running={false} />
          </div>
          <p className="mt-2 text-[13.5px] leading-[1.55] text-ink-3">{personaPreview}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-ink-3">
            <span className="inline-flex items-center gap-1.5">
              <BranchIcon />
              <span className="font-mono">main</span>
            </span>
            <Sep />
            <span>
              <span className="text-ink-4">Model:</span>{' '}
              <code className="rounded border border-rule-2 bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                {model ?? 'no model'}
              </code>
            </span>
            {llmKeyLabel && (
              <>
                <Sep />
                <span>
                  <span className="text-ink-4">LLM:</span>{' '}
                  <span className="text-ink-2">{llmKeyLabel}</span>
                </span>
              </>
            )}
            <Sep />
            <span>
              <span className="text-ink-4">Role:</span>{' '}
              <span className="text-ink-2 capitalize">{role}</span>
            </span>
            <Sep />
            <span className="font-mono text-ink-4">@{slug}</span>
          </div>
        </div>

        {/* CTAs */}
        <div className="flex flex-shrink-0 flex-wrap gap-2">
          <HeroBtn icon={<DuplicateIcon />} label="Duplicate" disabled />
          <HeroBtn icon={<GearIcon />} label="Configure" onClick={onConfigure} />
          <HeroBtn icon={<PlayIcon />} label="Run" primary disabled />
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 gap-px border-t border-rule-2 bg-rule-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCell label="Connectors" value={String(stats.connectors)} />
        <StatCell label="MCPs" value={String(stats.mcps)} />
        <StatCell
          label="Sub-agents"
          value={role === 'worker' ? '—' : String(stats.subAgents)}
          dim={role === 'worker'}
        />
        <StatCell label="Runs (7d)" value="—" dim />
        <StatCell label="Tokens / job" value="—" dim />
        <StatCell label="P95 latency" value="—" dim />
      </div>
    </div>
  );
}

function Sep() {
  return <span className="text-ink-4">·</span>;
}

function StatCell({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="bg-paper px-5 py-4">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">{label}</div>
      <div
        className={`mt-1.5 text-[20px] font-semibold leading-none tracking-[-0.01em] ${dim ? 'text-ink-4' : 'text-ink'}`}
      >
        {value}
      </div>
    </div>
  );
}

function HeroBtn({
  icon,
  label,
  primary,
  disabled,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const base =
    'inline-flex h-[34px] items-center gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40';
  const skin = primary
    ? 'bg-ink text-canvas hover:brightness-[0.92]'
    : 'border border-rule bg-paper text-ink-2 hover:border-rule-2 hover:text-ink';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${skin}`}
      title={disabled ? 'Coming soon' : undefined}
    >
      {icon}
      {label}
    </button>
  );
}

function StatusPill({ running }: { running: boolean }) {
  const skin = running
    ? 'bg-skill-vivid/15 text-skill-vivid'
    : 'border border-rule-2 bg-canvas text-ink-3';
  return (
    <span
      className={`inline-flex h-[24px] items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium ${skin}`}
    >
      <span className={`h-[6px] w-[6px] rounded-full ${running ? 'bg-skill-vivid' : 'bg-ink-3'}`} />
      {running ? 'Running' : 'Idle'}
    </span>
  );
}

// Tiny inline SVGs — kept local to avoid extra component churn.
function BranchIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="4" cy="4" r="1.5" /> <circle cx="4" cy="12" r="1.5" />
      <circle cx="12" cy="6" r="1.5" /> <path d="M4 5.5v5M4 8h4a3 3 0 0 0 3-3v-.5" />
    </svg>
  );
}
function DuplicateIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.5 1.5M11 11l1.5 1.5M3.5 12.5L5 11M11 5l1.5-1.5" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4 3l9 5-9 5z" />
    </svg>
  );
}

// ─── Tabs bar ─────────────────────────────────────────────────────────────────

function TabsBar({
  tab,
  onChange,
  counts,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: { connectors: number; knowledge: number };
}) {
  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'skills', label: 'Skills' },
    { id: 'connectors', label: 'Connectors', count: counts.connectors },
    { id: 'runs', label: 'Runs' },
    { id: 'settings', label: 'Settings' },
  ];
  return (
    <div className="flex gap-1 border-b border-rule-2">
      {TABS.map((t) => {
        const isActive = tab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={[
              'relative -mb-px border-b-2 px-4 pt-2.5 pb-3 text-[13.5px] font-medium transition-colors',
              isActive ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
            ].join(' ')}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span
                className={`ml-1.5 font-mono text-[10.5px] ${isActive ? 'text-ink-2' : 'text-ink-4'}`}
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

// ─── Section card wrapper ────────────────────────────────────────────────────

function SectionCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-rule-2 bg-paper p-6">{children}</div>;
}

function SectionHead({
  label,
  hint,
  right,
}: {
  label: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">
          {label}
        </div>
        {hint && <p className="mt-1 text-[12px] leading-[1.5] text-ink-3">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  connectorsAssigned,
  mcpsAssignedCount,
}: {
  connectorsAssigned: AgentConnectorRow[];
  mcpsAssignedCount: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* Left: activity chart placeholder */}
      <div className="rounded-2xl border border-rule-2 bg-paper p-6 lg:col-span-2">
        <SectionHead label="Runs · 7 days" />
        <div className="mb-3">
          <div className="text-[28px] font-semibold leading-none tracking-[-0.01em] text-ink-4">
            —<span className="ml-2 text-[14px] font-normal text-ink-4">successful runs</span>
          </div>
        </div>
        <div className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-rule-2 bg-canvas/30">
          <p className="text-center text-[12px] leading-[1.5] text-ink-4">
            Per-agent run telemetry is not wired yet.
            <br />
            See aggregate activity on{' '}
            <Link href="/" className="underline hover:text-ink-3">
              the dashboard
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Right: connectors used */}
      <div className="rounded-2xl border border-rule-2 bg-paper p-6">
        <SectionHead label={`Connectors used · ${connectorsAssigned.length}`} />
        {connectorsAssigned.length === 0 ? (
          <p className="text-[12.5px] leading-[1.5] text-ink-4">
            No connectors assigned yet. Pick some in the{' '}
            <button
              type="button"
              className="underline hover:text-ink-3"
              // Reach the Connectors tab via a hash so this is keyboard-friendly.
              onClick={() => {
                /* tab switch handled by parent — link kept declarative */
              }}
            >
              Connectors tab
            </button>
            .
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {connectorsAssigned.map((c) => (
              <li
                key={c.connectorId}
                className="flex items-center gap-3 rounded-lg border border-rule-2 bg-canvas/40 px-3 py-2"
              >
                <span className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full bg-conn-vivid/15 font-mono text-[9.5px] font-semibold uppercase text-conn-vivid">
                  {c.label.slice(0, 2)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-ink">{c.label}</div>
                  {c.credentialName && (
                    <div className="truncate text-[10.5px] text-ink-4">{c.credentialName}</div>
                  )}
                </div>
                <span className="inline-flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.08em] text-ink-3">
                  <span className="h-[6px] w-[6px] rounded-full bg-agent-vivid" />
                  on
                </span>
              </li>
            ))}
          </ul>
        )}
        {mcpsAssignedCount > 0 && (
          <p className="mt-3 text-[11px] text-ink-4">
            + {mcpsAssignedCount} MCP server{mcpsAssignedCount > 1 ? 's' : ''} in the Knowledge
            section (Settings tab).
          </p>
        )}
      </div>

      {/* Bottom full-width: skills attached stub */}
      <div className="rounded-2xl border border-rule-2 bg-paper p-6 lg:col-span-3">
        <SectionHead
          label="Skills attached"
          hint="Per-agent skill assignment will surface here once exposed. Manage the catalogue in /skills."
        />
        <div className="flex h-[80px] items-center justify-center rounded-lg border border-dashed border-rule-2 bg-canvas/30">
          <Link
            href="/skills"
            className="text-[12.5px] font-medium text-ink-2 underline hover:text-ink"
          >
            Open Skills page →
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Stubs ────────────────────────────────────────────────────────────────────

function SkillsTabStub({ slug }: { slug: string }) {
  return (
    <SectionCard>
      <SectionHead
        label="Skills assigned to this agent"
        hint="Per-agent skill assignment surfaces here once the data layer exposes it."
      />
      <p className="text-[12.5px] text-ink-3">
        For now, manage skills and assignments from the{' '}
        <Link href="/skills" className="underline hover:text-ink-2">
          Skills page
        </Link>
        .
      </p>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-4">@{slug}</p>
    </SectionCard>
  );
}

function RunsTabStub({ slug }: { slug: string }) {
  return (
    <SectionCard>
      <SectionHead label="Recent runs" hint="Run history filtered to this agent will live here." />
      <p className="text-[12.5px] text-ink-3">
        In the meantime, see{' '}
        <Link href="/jobs" className="underline hover:text-ink-2">
          all runs
        </Link>
        .
      </p>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-4">@{slug}</p>
    </SectionCard>
  );
}

// ─── Settings tab — where editing happens ─────────────────────────────────────

function SettingsTab(props: {
  name: string;
  slug: string;
  avatarUrl: string | null;
  personality: string;
  role: AgentRole;
  showSubAgents: boolean;
  subAgentIds: string[];
  peers: AgentRow[];
  llmKeyId: string;
  activeKeys: LlmKeyUiRow[];
  selectedKey: LlmKeyUiRow | null;
  model: string;
  coherenceOk: boolean;
  detectedProviders: Set<ProviderSlug>;
  compatibleActiveKeys: LlmKeyUiRow[];
  noLlmKeys: boolean;
  workspaceRootPath: string;
  mcpServers: AgentMcpServerRow[];
  agentId: string;
  dirty: boolean;
  isPending: boolean;
  onChangeName: (v: string) => void;
  onChangeAvatar: (v: string | null) => void;
  onChangePersonality: (v: string) => void;
  onChangeRole: (r: AgentRole) => void;
  onToggleSubAgent: (id: string) => void;
  onChangeLlmKey: (id: string) => void;
  onChangeModel: (v: string) => void;
  onSwitchKey: (id: string) => void;
  onChangeWorkspaceRootPath: (v: string) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const {
    name,
    slug,
    avatarUrl,
    personality,
    role,
    showSubAgents,
    subAgentIds,
    peers,
    llmKeyId,
    activeKeys,
    selectedKey,
    model,
    coherenceOk,
    detectedProviders,
    compatibleActiveKeys,
    noLlmKeys,
    workspaceRootPath,
    mcpServers,
    agentId,
    dirty,
    isPending,
    onChangeName,
    onChangeAvatar,
    onChangePersonality,
    onChangeRole,
    onToggleSubAgent,
    onChangeLlmKey,
    onChangeModel,
    onSwitchKey,
    onChangeWorkspaceRootPath,
    onSave,
    onReset,
  } = props;

  return (
    <div className="space-y-6">
      {/* Identity */}
      <SectionCard>
        <SectionHead label="Identity" hint="Slug is immutable. Avatar is used across the app." />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="Agent name"
              className="w-full rounded-lg border border-rule bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
            />
          </Field>
          <Field label="Slug (read-only)">
            <code className="block w-full rounded-lg border border-rule-2 bg-hover px-3 py-2 font-mono text-[11.5px] tracking-[0.02em] text-ink-3">
              {slug}
            </code>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Avatar">
              <AvatarPicker value={avatarUrl} onChange={onChangeAvatar} />
            </Field>
          </div>
        </div>
      </SectionCard>

      {/* Behavior */}
      <SectionCard>
        <SectionHead
          label="Behavior"
          hint="Persona is the system prompt. Updating it invalidates the prompt cache for new jobs."
        />
        <Field label="Persona / system prompt">
          <textarea
            value={personality}
            onChange={(e) => onChangePersonality(e.target.value)}
            rows={8}
            placeholder="You are a helpful assistant…"
            className="w-full resize-y rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[12.5px] leading-[1.55] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
          />
        </Field>
        <div className="mt-4">
          <Field label="Role">
            <select
              value={role}
              onChange={(e) => onChangeRole(e.target.value as AgentRole)}
              className="w-full rounded-lg border border-rule bg-canvas px-3 py-2 text-[13px] text-ink focus:border-ink-3 focus:outline-none"
            >
              <option value="worker">Worker — runs its own tools</option>
              <option value="router">Router — delegates one at a time</option>
              <option value="planner">Planner — parallel sub-agents</option>
            </select>
          </Field>
        </div>
        {showSubAgents && (
          <div className="mt-4">
            <Field label={`Sub-agents · ${subAgentIds.length} selected`}>
              {peers.length === 0 ? (
                <p className="text-[12.5px] text-warn">
                  Create at least one worker agent first — orchestrators need someone to delegate
                  to.
                </p>
              ) : (
                <div className="divide-y divide-rule-2 overflow-hidden rounded-lg border border-rule-2 bg-canvas/30">
                  {peers.map((a) => {
                    const checked = subAgentIds.includes(a.id);
                    return (
                      <label
                        key={a.id}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] transition-colors hover:bg-hover"
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
            </Field>
          </div>
        )}
      </SectionCard>

      {/* Model */}
      <SectionCard>
        <SectionHead label="Model" hint="LLM key + model identifier passed to the runner." />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="LLM provider">
            {noLlmKeys ? (
              <p className="text-[12.5px] text-warn">
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
                className="w-full rounded-lg border border-rule bg-canvas px-3 py-2 text-[13px] text-ink focus:border-ink-3 focus:outline-none"
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
              className="w-full rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
            />
          </Field>
        </div>
        {!coherenceOk && selectedKey && (
          <div
            role="alert"
            data-testid="model-provider-mismatch"
            className="mt-3 space-y-1 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-[12px] text-warn"
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
              <div className="flex flex-wrap gap-1.5">
                <span className="text-warn/80">Switch to:</span>
                {compatibleActiveKeys.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => onSwitchKey(k.id)}
                    className="rounded border border-warn/30 px-1.5 py-0.5 text-[11px] font-medium text-warn hover:bg-warn-bg"
                  >
                    {k.nickname ?? prettyProviderName(k.provider)} ({prettyProviderName(k.provider)}
                    )
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
      </SectionCard>

      {/* Knowledge */}
      <SectionCard>
        <SectionHead
          label="Knowledge"
          hint="Workspace path scopes file_* tools. MCP servers contribute extra tools."
        />
        <Field label="Workspace root">
          <input
            type="text"
            value={workspaceRootPath}
            onChange={(e) => onChangeWorkspaceRootPath(e.target.value)}
            placeholder="C:\Users\you\Documents\MyVault  or  /home/you/notes"
            className="w-full rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
          />
        </Field>
        <div className="mt-4">
          <Field label="MCP knowledge sources">
            <AgentMcpServerGrid agentId={agentId} servers={mcpServers} />
          </Field>
        </div>
      </SectionCard>

      {/* Save bar */}
      <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-2xl border border-rule-2 bg-paper px-4 py-3 shadow-lg">
        <div className="text-[12.5px] text-ink-3">
          {dirty ? (
            <span>
              <span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full bg-skill-vivid" />
              Unsaved changes
            </span>
          ) : (
            <span className="text-ink-4">No changes</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={isPending || !dirty}
            className="rounded-lg border border-rule px-4 py-2 text-[13px] font-medium text-ink-3 transition-colors hover:border-rule-2 hover:text-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset
          </button>
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
            className="rounded-lg bg-ink px-5 py-2 text-[13px] font-semibold text-canvas transition-colors hover:brightness-[0.92] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-4">{label}</label>
      <div>{children}</div>
    </div>
  );
}
