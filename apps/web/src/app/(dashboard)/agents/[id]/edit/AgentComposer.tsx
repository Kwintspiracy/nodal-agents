'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  updateAgentAction,
  listAgentWorkspacesAction,
  listKeyModelsAction,
  addAgentWorkspaceAction,
  removeAgentWorkspaceAction,
  uploadToWorkspaceAction,
  listWorkspaceFilesAction,
  deleteWorkspaceFileAction,
  listAgentApprovalRulesAction,
  setAgentApprovalRuleAction,
  setRunCommandYoloAction,
  setSkillScriptsAuthorizedAction,
  setSkillFilesWritableAction,
  type AgentRow,
  type AgentEditRow,
  type AgentWorkspaceRow,
  type WorkspaceFileRow,
  type LlmKeyUiRow,
  type AgentConnectorRow,
  type AgentMcpServerRow,
  type JobRow,
  type SkillRow,
  type ApprovalRuleUiRow,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import { MODEL_CATALOG, findModelCatalogEntry, groupModelCatalog } from '@nodal-agents/shared';
import { prettyProviderName } from '@/lib/provider-names.ts';
import { type ProviderSlug } from '@/lib/model-provider-detect.ts';
import AvatarPicker from '@/components/AvatarPicker.tsx';
import Disc from '@/components/ui/Disc';
import EdRow from '@/components/ui/EdRow';
import RunsTable from '@/app/(dashboard)/jobs/RunsTable';
import { CONN_BRAND_COLORS, connGlyph } from '@/app/(dashboard)/connectors/connector-brand.ts';
import ConnectorsTabContent from './ConnectorsTabContent.tsx';
import type { OperationDescriptor } from '@nodal-agents/shared';

/**
 * AgentComposer — detail page for /agents/[id]/edit.
 *
 * Matches the screenshot Quentin shared (2026-05-27): a hero card with
 * avatar + name + status + meta + Configure CTA, followed by a stat strip
 * (only metrics we actually have are filled), then tabs:
 *
 *   Overview · Skills · Connectors · Runs · Settings
 *
 * Per-agent data flows in from page.tsx:
 *   - connectors / mcpServers   → wired to AgentConnectorGrid / AgentMcpServerGrid
 *   - attachedSkills            → fed into Overview + Skills tab
 *   - jobs                      → fed into the shared <RunsTable> (same one /jobs uses)
 *
 * Visual primitives reused (per "use existing components"):
 *   - Disc + CONN_BRAND_COLORS / connGlyph from /connectors → identical
 *     glyph treatment for the "Connectors used" list
 *   - Disc variant="skill" for attached skills (same disc as /skills)
 *   - StatusPill for status chips (same as /jobs, /agents list)
 *   - RunsTable from /jobs for the Runs tab — no second implementation
 *
 * Settings tab is where editing happens. Sticky save bar at the bottom.
 */

type Tab = 'overview' | 'skills' | 'connectors' | 'runs' | 'autonomy' | 'settings';
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
  /** Peers = every OTHER agent (sub-agent picker; excludes self). */
  peers: AgentRow[];
  /** All agents in the entity, canonical order — drives the picker pills so
   *  their order is stable and identical to the /agents page. */
  allAgents: AgentRow[];
  llmKeys: LlmKeyUiRow[];
  connectors: AgentConnectorRow[];
  mcpServers: AgentMcpServerRow[];
  jobs: JobRow[];
  attachedSkills: SkillRow[];
  /** Whether the workspace owner has opted in to Yolo in non-local-trust mode. */
  lanCommandYolo?: boolean;
  /** Whether the current user is the workspace owner. */
  isOwner?: boolean;
}

export default function AgentComposer({
  agent,
  peers,
  allAgents,
  llmKeys,
  connectors,
  mcpServers,
  jobs,
  attachedSkills,
  lanCommandYolo = false,
  isOwner = false,
}: Props) {
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
  // Guard 2: ordered failover chain (in order) — each link is a (keyId, model)
  // pair so a fallback runs on a chosen model.
  const [fallbackChain, setFallbackChain] = useState<Array<{ keyId: string; model: string }>>(
    agent.fallbackChain ?? [],
  );
  const [model, setModel] = useState<string>(agent.model ?? '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(agent.avatarUrl ?? null);
  // Live model ids fetched from the provider's /models endpoint — keyed by keyId
  // so re-selecting a key doesn't re-fetch. undefined = not yet fetched.
  const [liveModelsCache, setLiveModelsCache] = useState<Record<string, string[]>>({});
  const [liveModelsLoading, setLiveModelsLoading] = useState(false);
  // Workspaces list — loaded asynchronously from the DB via server action.
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceRow[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);

  useEffect(() => {
    listAgentWorkspacesAction(agent.id).then((result) => {
      if (result.ok) setWorkspaces(result.data);
      setWorkspacesLoaded(true);
    });
  }, [agent.id]);

  // Prefetch live model list for the initially-selected key.
  useEffect(() => {
    if (!llmKeyId) return;
    if (liveModelsCache[llmKeyId] !== undefined) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLiveModelsLoading(true);
    listKeyModelsAction(llmKeyId).then((res) => {
      setLiveModelsCache((prev) => ({ ...prev, [llmKeyId]: res.ok ? res.data : [] }));
      setLiveModelsLoading(false);
    });
  }, [llmKeyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── derived ──────────────────────────────────────────────────────────────
  const selectedKey = useMemo(
    () => llmKeys.find((k) => k.id === llmKeyId) ?? null,
    [llmKeys, llmKeyId],
  );
  const noLlmKeys = activeKeys.length === 0;
  const showSubAgents = role !== 'worker';
  const initial = (agent.name || agent.slug).slice(0, 1).toUpperCase();

  const assignedConnectorRows = connectors.filter((c) => c.assigned);
  const assignedConnectors = assignedConnectorRows.length;
  const assignedMcps = mcpServers.filter((s) => s.assigned).length;
  const subAgentCount = role === 'worker' ? 0 : subAgentIds.length;
  const personaPreview =
    (personality || '').split(/\n+/).filter(Boolean)[0]?.trim() ?? 'No description yet.';

  // Run aggregates from the jobs prop (already filtered to this agent).
  const totalRuns = jobs.length;
  const successfulRuns = jobs.filter((j) => j.status === 'completed').length;

  // Dirty detection — drives Settings save/reset (workspaces are saved immediately on add/remove)
  const dirty =
    name !== agent.name ||
    personality !== (agent.personality ?? '') ||
    role !== initialRole ||
    JSON.stringify([...subAgentIds].sort()) !== JSON.stringify([...agent.subAgentIds].sort()) ||
    llmKeyId !== initialLlmKeyId ||
    JSON.stringify(fallbackChain) !== JSON.stringify(agent.fallbackChain ?? []) ||
    model !== (agent.model ?? '') ||
    avatarUrl !== (agent.avatarUrl ?? null);

  // ── handlers ─────────────────────────────────────────────────────────────
  function handleLlmKeyChange(id: string) {
    const newKey = llmKeys.find((row) => row.id === id);
    setLlmKeyId(id);
    // Switching provider resets the model to that provider's default (or its
    // first curated model). A model id only makes sense for its own provider —
    // so we never keep a stale, mismatched model around.
    const firstCurated = newKey ? (MODEL_CATALOG[newKey.provider]?.[0]?.modelId ?? '') : '';
    setModel(firstCurated);
    // Prefetch live models for this key if not yet cached.
    if (id && liveModelsCache[id] === undefined) {
      setLiveModelsLoading(true);
      listKeyModelsAction(id).then((res) => {
        setLiveModelsCache((prev) => ({ ...prev, [id]: res.ok ? res.data : [] }));
        setLiveModelsLoading(false);
      });
    }
  }

  function handleModelChange(next: string) {
    setModel(next);
  }

  function toggleSubAgent(id: string) {
    setSubAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // Append on select (failover priority = selection order), remove on deselect.
  // A newly added fallback defaults to its provider's first catalog model.
  function toggleFallback(id: string) {
    setFallbackChain((prev) => {
      if (prev.some((l) => l.keyId === id)) return prev.filter((l) => l.keyId !== id);
      const key = llmKeys.find((k) => k.id === id);
      const defaultModel = key ? (MODEL_CATALOG[key.provider]?.[0]?.modelId ?? '') : '';
      return [...prev, { keyId: id, model: defaultModel }];
    });
  }

  function setFallbackModel(id: string, model: string) {
    setFallbackChain((prev) => prev.map((l) => (l.keyId === id ? { ...l, model } : l)));
  }

  function handleSave() {
    if (noLlmKeys || isPending || !dirty) return;
    const payload = {
      id: agent.id,
      name,
      personality,
      model,
      llmKeyId: llmKeyId || null,
      fallbackChain: fallbackChain.filter((l) => l.keyId !== llmKeyId),
      role,
      subAgentIds: role === 'worker' ? [] : subAgentIds,
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
    setFallbackChain(agent.fallbackChain ?? []);
    setModel(agent.model ?? '');
    setAvatarUrl(agent.avatarUrl ?? null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <BackLink />

      <AgentPicker agents={allAgents} activeId={agent.id} />

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
          skills: attachedSkills.length,
          totalRuns,
          successfulRuns,
        }}
        onConfigure={() => setTab('settings')}
      />

      <TabsBar
        tab={tab}
        onChange={setTab}
        counts={{
          skills: attachedSkills.length,
          // Connectors tab now lists API + MCP combined — count both.
          connectors: assignedConnectors + assignedMcps,
          runs: totalRuns,
        }}
      />

      {tab === 'overview' && (
        <OverviewTab
          jobs={jobs}
          attachedSkills={attachedSkills}
          connectorsAssigned={assignedConnectorRows}
          mcpsAssignedCount={assignedMcps}
          onOpenSkills={() => setTab('skills')}
          onOpenConnectors={() => setTab('connectors')}
        />
      )}
      {tab === 'skills' && <SkillsTab skills={attachedSkills} />}
      {tab === 'connectors' && (
        <SectionCard>
          <ConnectorsTabContent
            key={agent.id}
            agentId={agent.id}
            connectors={connectors}
            mcpServers={mcpServers}
          />
        </SectionCard>
      )}
      {tab === 'runs' && (
        <RunsTable
          jobs={jobs}
          agents={[{ id: agent.id, name: agent.name, slug: agent.slug } as AgentRow, ...peers]}
          agentId={agent.id}
        />
      )}
      {tab === 'autonomy' && (
        <AutonomyTab
          agentId={agent.id}
          connectors={connectors}
          hasTelegramBot={!!agent.telegramBotToken}
          attachedSkills={attachedSkills}
          lanCommandYolo={lanCommandYolo}
          isOwner={isOwner}
        />
      )}
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
          fallbackChain={fallbackChain}
          activeKeys={activeKeys}
          selectedKey={selectedKey}
          model={model}
          noLlmKeys={noLlmKeys}
          workspaces={workspaces}
          workspacesLoaded={workspacesLoaded}
          onWorkspacesChange={setWorkspaces}
          agentId={agent.id}
          dirty={dirty}
          isPending={isPending}
          onChangeName={setName}
          onChangeAvatar={setAvatarUrl}
          onChangePersonality={setPersonality}
          onChangeRole={setRole}
          onToggleSubAgent={toggleSubAgent}
          onToggleFallback={toggleFallback}
          onChangeFallbackModel={setFallbackModel}
          onChangeLlmKey={handleLlmKeyChange}
          onChangeModel={handleModelChange}
          onSave={handleSave}
          onReset={handleReset}
          liveModelsCache={liveModelsCache}
          liveModelsLoading={liveModelsLoading}
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
      className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 transition-colors hover:text-ink-2"
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
            <span className="inline-block h-[7px] w-[7px] rounded-full bg-agent-vivid" />
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
  stats: {
    connectors: number;
    mcps: number;
    subAgents: number;
    skills: number;
    totalRuns: number;
    successfulRuns: number;
  };
  onConfigure: () => void;
}) {
  const successRate =
    stats.totalRuns > 0 ? `${Math.round((stats.successfulRuns / stats.totalRuns) * 100)}%` : '—';
  return (
    <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
      <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-start">
        {/* Avatar — no background plate behind a real avatar; the coloured
            rounded badge is only the fallback for agents without an avatar. */}
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            className="h-[80px] w-[80px] flex-shrink-0 rounded-2xl object-cover"
          />
        ) : (
          <div className="flex h-[80px] w-[80px] flex-shrink-0 items-center justify-center rounded-2xl bg-agent-vivid text-[28px] font-semibold text-canvas">
            {initial}
          </div>
        )}

        {/* Title + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 text-[22px] font-semibold leading-none tracking-[-0.01em] text-ink">
              {name}
            </h1>
            <span className="inline-flex h-[24px] items-center gap-1.5 rounded-full border border-rule-2 bg-canvas px-2.5 text-[11.5px] font-medium text-ink-3">
              <span className="h-[6px] w-[6px] rounded-full bg-ink-3" />
              Idle
            </span>
          </div>
          <p className="mt-2 text-[13.5px] leading-[1.55] text-ink-3">{personaPreview}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-ink-3">
            {model && (
              <span>
                <span className="text-ink-4">Model:</span>{' '}
                <code className="rounded border border-rule-2 bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                  {model}
                </code>
              </span>
            )}
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
              <span className="capitalize text-ink-2">{role}</span>
            </span>
            <Sep />
            <span className="font-mono text-ink-4">@{slug}</span>
          </div>
        </div>

        {/* CTAs — only Configure (Duplicate + Run dropped on request) */}
        <div className="flex flex-shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={onConfigure}
            className="inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-rule bg-paper px-3.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-rule-2 hover:text-ink"
          >
            <GearIcon />
            Configure
          </button>
        </div>
      </div>

      {/* Stat strip — 6 independent rounded mini-cards inside the hero,
          separated by gap (not by border lines). Matches the screenshot. */}
      <div className="grid grid-cols-2 gap-2 px-6 pb-6 sm:grid-cols-3 lg:grid-cols-6">
        <StatCell label="Skills" value={String(stats.skills)} />
        <StatCell label="Connectors" value={String(stats.connectors)} />
        <StatCell label="MCPs" value={String(stats.mcps)} />
        <StatCell
          label="Sub-agents"
          value={role === 'worker' ? '—' : String(stats.subAgents)}
          dim={role === 'worker'}
        />
        <StatCell label="Runs" value={String(stats.totalRuns)} dim={stats.totalRuns === 0} />
        <StatCell label="Success rate" value={successRate} dim={stats.totalRuns === 0} />
      </div>
    </div>
  );
}

function Sep() {
  return <span className="text-ink-4">·</span>;
}

function StatCell({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="rounded-lg border border-rule-2 bg-canvas/40 px-4 py-3">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">{label}</div>
      <div
        className={`mt-1.5 text-[20px] font-semibold leading-none tracking-[-0.01em] ${dim ? 'text-ink-4' : 'text-ink'}`}
      >
        {value}
      </div>
    </div>
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

// ─── Tabs bar ─────────────────────────────────────────────────────────────────

function TabsBar({
  tab,
  onChange,
  counts,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: { skills: number; connectors: number; runs: number };
}) {
  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'skills', label: 'Skills', count: counts.skills },
    { id: 'connectors', label: 'Connectors', count: counts.connectors },
    { id: 'runs', label: 'Runs', count: counts.runs },
    { id: 'autonomy', label: 'Autonomy' },
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

// ─── Overview tab — real data, no empty placeholder boxes ─────────────────────

function OverviewTab({
  jobs,
  attachedSkills,
  connectorsAssigned,
  mcpsAssignedCount,
  onOpenSkills,
  onOpenConnectors,
}: {
  jobs: JobRow[];
  attachedSkills: SkillRow[];
  connectorsAssigned: AgentConnectorRow[];
  mcpsAssignedCount: number;
  onOpenSkills: () => void;
  onOpenConnectors: () => void;
}) {
  const hasSkills = attachedSkills.length > 0;
  const hasConnectors = connectorsAssigned.length > 0;

  return (
    <div className="space-y-6">
      {/* Top row: weekly chart (2/3) + connectors used (1/3) — matches screenshot */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionCard>
            <AgentWeeklyChart jobs={jobs} />
          </SectionCard>
        </div>

        <SectionCard>
          <SectionHead
            label={`Connectors used · ${connectorsAssigned.length}`}
            right={
              hasConnectors ? (
                <button
                  type="button"
                  onClick={onOpenConnectors}
                  className="text-[11.5px] text-ink-3 underline hover:text-ink-2"
                >
                  Manage
                </button>
              ) : undefined
            }
          />
          {hasConnectors ? (
            <div className="space-y-2">
              {connectorsAssigned.map((c) => (
                <ConnectorOverviewRow key={c.connectorId} row={c} />
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-ink-3">
              No connectors assigned yet.{' '}
              <button
                type="button"
                onClick={onOpenConnectors}
                className="underline hover:text-ink-2"
              >
                Wire one →
              </button>
            </p>
          )}
          {mcpsAssignedCount > 0 && (
            <p className="mt-3 border-t border-rule-2 pt-3 text-[11.5px] text-ink-4">
              + {mcpsAssignedCount} MCP server{mcpsAssignedCount > 1 ? 's' : ''} attached (Settings
              → Knowledge).
            </p>
          )}
        </SectionCard>
      </div>

      {/* Skills attached — full-width row underneath */}
      <SectionCard>
        <SectionHead
          label={`Skills attached · ${attachedSkills.length}`}
          right={
            hasSkills ? (
              <button
                type="button"
                onClick={onOpenSkills}
                className="text-[11.5px] text-ink-3 underline hover:text-ink-2"
              >
                Manage
              </button>
            ) : undefined
          }
        />
        {hasSkills ? (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 xl:grid-cols-3">
            {attachedSkills.map((s) => (
              <SkillEdRow key={s.id} skill={s} />
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-3">
            No skills attached yet. Read-only view — manage on the{' '}
            <Link href="/skills" className="underline hover:text-ink-2">
              Skills page
            </Link>
            .
          </p>
        )}
      </SectionCard>
    </div>
  );
}

// ─── AgentWeeklyChart — area chart over the last 7 days of completed jobs ────

function AgentWeeklyChart({ jobs }: { jobs: JobRow[] }) {
  const { data, total } = useMemo(() => {
    // Build 7 buckets (today and the previous 6 days), labelled by short
    // weekday name. Each bucket holds the count of completed jobs whose
    // createdAt falls into that calendar day.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const buckets: { day: string; runs: number; iso: string }[] = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(today.getTime() - i * 86_400_000);
      buckets.push({
        day: d.toLocaleDateString('en-US', { weekday: 'short' }),
        iso: d.toISOString().slice(0, 10),
        runs: 0,
      });
    }
    const byIso = new Map(buckets.map((b) => [b.iso, b]));
    let total = 0;
    for (const j of jobs) {
      if (j.status !== 'completed' || !j.createdAt) continue;
      const created = typeof j.createdAt === 'string' ? new Date(j.createdAt) : j.createdAt;
      const iso = new Date(created.getFullYear(), created.getMonth(), created.getDate())
        .toISOString()
        .slice(0, 10);
      const bucket = byIso.get(iso);
      if (!bucket) continue; // older than 7 days
      bucket.runs += 1;
      total += 1;
    }
    return { data: buckets, total };
  }, [jobs]);

  return (
    <div>
      <div className="mb-3 flex items-baseline gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">
          Runs · 7 days
        </span>
      </div>
      <div className="mb-4 flex items-baseline gap-3">
        <span className="text-[34px] font-semibold leading-none tracking-[-0.015em] text-ink">
          {total.toLocaleString()}
        </span>
        <span className="text-[13.5px] text-ink-3">successful run{total === 1 ? '' : 's'}</span>
      </div>
      <div className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="agentWeeklyFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--c-agent-vivid)" stopOpacity={0.55} />
                <stop offset="100%" stopColor="var(--c-agent-vivid)" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--c-rule-2)" vertical={false} />
            <XAxis
              dataKey="day"
              stroke="var(--c-ink-4)"
              tick={{ fill: 'var(--c-ink-4)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="var(--c-ink-4)"
              tick={{ fill: 'var(--c-ink-4)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ stroke: 'var(--c-ink-4)', strokeDasharray: '3 3' }}
              contentStyle={{
                background: 'var(--c-paper)',
                border: '1px solid var(--c-rule)',
                borderRadius: 10,
                fontSize: 12,
                color: 'var(--c-ink)',
                boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
              }}
              labelStyle={{ color: 'var(--c-ink-3)' }}
            />
            <Area
              type="monotone"
              dataKey="runs"
              stroke="var(--c-agent-vivid)"
              strokeWidth={2}
              fill="url(#agentWeeklyFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Skill row (EdRow with Disc skill glyph + open icon) ──────────────────────

function SkillEdRow({ skill }: { skill: SkillRow }) {
  return (
    <EdRow
      glyph={
        <Disc variant="skill" size="lg" shape="square">
          <span className="font-mono text-[10.5px] font-semibold uppercase">
            {skill.slug.slice(0, 2)}
          </span>
        </Disc>
      }
      name={skill.name}
      description={skill.description ?? undefined}
      meta={`@${skill.slug}`}
      actions={
        <Link
          href={`/skills/${skill.id}/edit`}
          className="flex h-7 items-center gap-1 rounded-md border border-rule px-2 text-[11px] font-medium text-ink-3 transition-colors hover:border-rule-2 hover:text-ink"
        >
          Open ›
        </Link>
      }
    />
  );
}

// ─── Connector row in Overview (compact summary, no expand) ──────────────────

function ConnectorOverviewRow({ row }: { row: AgentConnectorRow }) {
  return (
    <EdRow
      glyph={
        <Disc variant="conn" size="lg" shape="square" background={CONN_BRAND_COLORS[row.slug]}>
          <span className="font-mono text-[10.5px] font-semibold">
            {connGlyph(row.slug, row.label)}
          </span>
        </Disc>
      }
      name={
        <>
          {row.label}
          <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.04em] text-ink-4">
            {row.slug.toUpperCase()}
          </span>
        </>
      }
      description={row.credentialName ?? undefined}
      actions={
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          <span className="h-[6px] w-[6px] rounded-full bg-agent-vivid" />
          on
        </span>
      }
    />
  );
}

// ─── Skills tab (full page list of attached skills) ──────────────────────────

function SkillsTab({ skills }: { skills: SkillRow[] }) {
  if (skills.length === 0) {
    return (
      <SectionCard>
        <SectionHead
          label="No skills attached"
          hint="Read-only view. Manage attachments on the /skills page."
        />
      </SectionCard>
    );
  }
  return (
    <SectionCard>
      <SectionHead label={`Attached · ${skills.length}`} />
      <div className="space-y-2">
        {skills.map((s) => (
          <SkillEdRow key={s.id} skill={s} />
        ))}
      </div>
    </SectionCard>
  );
}

// ─── Autonomy tab — per-tool approval gate controls ───────────────────────────
//
// Gateable tools = write/destructive operations from the agent's assigned
// connectors + telegram_send_message if a Telegram bot is configured.
// Read-only tools (risk='read') are never gated — they're always autonomous and
// are not shown to avoid clutter.
//
// The three-way control maps directly to approval_rules.action:
//   Autonomous   → delete the rule (runtime default = auto_approve)
//   Ask first    → action='require_approval'
//   Block        → action='block'

// Static: always-possible outward tool when a bot is configured.
const TELEGRAM_SEND_OPERATION: OperationDescriptor = {
  slug: 'telegram_send_message',
  name: 'Send Telegram message',
  risk: 'destructive',
  requiresApproval: true,
  description: 'Deliver a message to the user via the configured Telegram bot (irreversible).',
};

type ApprovalAction = 'auto_approve' | 'require_approval' | 'block';

function AutonomyTab({
  agentId,
  connectors,
  hasTelegramBot,
  attachedSkills,
  lanCommandYolo,
  isOwner,
}: {
  agentId: string;
  connectors: AgentConnectorRow[];
  hasTelegramBot: boolean;
  attachedSkills: SkillRow[];
  lanCommandYolo: boolean;
  isOwner: boolean;
}) {
  const [rules, setRules] = useState<ApprovalRuleUiRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<Set<string>>(new Set());

  // Load current rules on mount
  useEffect(() => {
    listAgentApprovalRulesAction(agentId).then((result) => {
      if (result.ok) setRules(result.data);
      setLoaded(true);
    });
  }, [agentId]);

  // Build the list of gateable tools from assigned connectors (write+destructive)
  // plus Telegram if a bot is wired.
  const gateableTools = useMemo<OperationDescriptor[]>(() => {
    const ops: OperationDescriptor[] = [];
    for (const conn of connectors) {
      if (!conn.assigned) continue;
      for (const op of conn.availableOperations) {
        if (op.risk === 'read') continue;
        // If the connector has an enabledOperations whitelist, only show those.
        if (conn.enabledOperations !== null && !conn.enabledOperations.includes(op.slug)) continue;
        ops.push(op);
      }
    }
    if (hasTelegramBot) {
      ops.push(TELEGRAM_SEND_OPERATION);
    }
    return ops;
  }, [connectors, hasTelegramBot]);

  function ruleFor(toolName: string): ApprovalAction {
    return rules.find((r) => r.toolName === toolName)?.action ?? 'auto_approve';
  }

  function handleChange(toolName: string, action: ApprovalAction) {
    // Optimistic update
    setRules((prev) => {
      const without = prev.filter((r) => r.toolName !== toolName);
      if (action === 'auto_approve') return without;
      return [...without, { id: '', toolName, action }];
    });

    setSaving((prev) => new Set([...prev, toolName]));
    void setAgentApprovalRuleAction({ agentId, toolName, action }).then((result) => {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(toolName);
        return next;
      });
      if (!result.ok) {
        toast.error(result.message);
        // Reload from server on error
        listAgentApprovalRulesAction(agentId).then((r) => {
          if (r.ok) setRules(r.data);
        });
      }
    });
  }

  if (!loaded) {
    return (
      <SectionCard>
        <p className="text-[12.5px] text-ink-4">Loading…</p>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      <SectionCard>
        <SectionHead
          label="Autonomy / Approvals"
          hint="Control whether this agent acts freely, must ask you first, or is blocked — per outward tool. Read-only tools are always autonomous and not shown."
        />
        {gateableTools.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">
            No write or destructive tools are currently assigned to this agent. Assign a connector
            (e.g. Gmail) or configure a Telegram bot to see its gateable tools here.
          </p>
        ) : (
          <div
            className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2"
            data-testid="autonomy-tool-list"
          >
            {gateableTools.map((op) => (
              <AutonomyToolRow
                key={op.slug}
                op={op}
                value={ruleFor(op.slug)}
                saving={saving.has(op.slug)}
                onChange={(action) => handleChange(op.slug, action)}
              />
            ))}
          </div>
        )}
        <p className="mt-4 text-[11px] text-ink-4">
          Default when no rule is set: <span className="font-medium text-ink-3">Autonomous</span>.
          Rules take effect on the next job — already-running jobs are not affected.
        </p>
      </SectionCard>

      <CommandExecutionSection
        agentId={agentId}
        attachedSkills={attachedSkills}
        rules={rules}
        onRulesChange={setRules}
        lanCommandYolo={lanCommandYolo}
        isOwner={isOwner}
      />

      <ScriptAuthSection agentId={agentId} attachedSkills={attachedSkills} isOwner={isOwner} />
      <FileWriteAuthSection agentId={agentId} attachedSkills={attachedSkills} isOwner={isOwner} />
    </div>
  );
}

// ─── Command execution section ────────────────────────────────────────────────
//
// Visible only when the agent has the `command-execution` skill assigned.
// run_command declares defaultApproval:'require_approval', so absence of a rule
// means every command pauses for human approval. "Yolo mode" = an explicit
// auto_approve row that bypasses that default.
//
// The toggle is disabled (greyed out) when NOT in local-trust mode: on a shared
// or LAN install, commands always require approval regardless of this setting.
// The server action also enforces this check independently.

const COMMAND_EXECUTION_SKILL_SLUG = 'command-execution';
const RUN_COMMAND_TOOL = 'run_command';

function CommandExecutionSection({
  agentId,
  attachedSkills,
  rules,
  onRulesChange,
  lanCommandYolo,
  isOwner,
}: {
  agentId: string;
  attachedSkills: SkillRow[];
  rules: ApprovalRuleUiRow[];
  onRulesChange: (rules: ApprovalRuleUiRow[]) => void;
  /** Whether the workspace owner has opted into Yolo in non-local-trust mode. */
  lanCommandYolo: boolean;
  /** Whether the current user is the workspace owner. */
  isOwner: boolean;
}) {
  const hasSkill = attachedSkills.some((s) => s.slug === COMMAND_EXECUTION_SKILL_SLUG);

  // Read auth mode client-side from NEXT_PUBLIC_AUTH_MODE (set by the CLI;
  // mirrors AUTH_MODE and is safe to read in client components).
  const isLocalTrust = (process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'local-trust') === 'local-trust';

  // The toggle is enabled when:
  //   - local-trust mode (single-user loopback — no auth; classic behaviour), OR
  //   - The workspace owner has explicitly opted in via lanCommandYolo AND the
  //     current user is that owner.
  const yoloAllowed = isLocalTrust || (lanCommandYolo && isOwner);

  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const yoloEnabled = rules.some(
    (r) => r.toolName === RUN_COMMAND_TOOL && r.action === 'auto_approve',
  );

  // ENABLING is gated by yoloAllowed. DISABLING an existing rule must always be
  // possible for anyone who can manage this workspace (local-trust, or the owner)
  // — otherwise turning the workspace switch off would strand a now-dormant rule
  // that can't be cleared. So the toggle is interactive when Yolo is allowed, or
  // when a rule already exists and the user is permitted to clear it.
  const canManage = isLocalTrust || isOwner;
  const canToggle = yoloAllowed || (yoloEnabled && canManage);
  // A rule exists but Yolo is not allowed here → it is dormant: the runtime
  // master-switch (workspace lan_command_yolo) downgrades it to require-approval.
  const isDormant = yoloEnabled && !yoloAllowed;

  function applyOptimistic(enabled: boolean) {
    onRulesChange(
      enabled
        ? [
            ...rules.filter((r) => r.toolName !== RUN_COMMAND_TOOL),
            { id: '', toolName: RUN_COMMAND_TOOL, action: 'auto_approve' as const },
          ]
        : rules.filter((r) => r.toolName !== RUN_COMMAND_TOOL),
    );
  }

  function handleToggle(next: boolean) {
    if (next) {
      // Enable: show warning confirm first
      setConfirmOpen(true);
    } else {
      // Disable: no confirm needed
      void doSet(false);
    }
  }

  async function doSet(enabled: boolean) {
    setSaving(true);
    applyOptimistic(enabled);
    const result = await setRunCommandYoloAction({ agentId, enabled });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.message);
      // Revert optimistic update
      applyOptimistic(!enabled);
    } else {
      toast.success(
        enabled
          ? 'Yolo mode enabled — commands run without approval.'
          : 'Yolo mode disabled — commands require approval again.',
      );
    }
  }

  if (!hasSkill) {
    return null;
  }

  return (
    <SectionCard>
      <SectionHead
        label="Command execution"
        hint="Controls whether shell commands (run_command) require human approval before running. By default, every command pauses for your approval."
      />

      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">
              Auto-run commands without approval (Yolo)
            </span>
            <span className="inline-flex h-[18px] items-center rounded-full bg-err/10 px-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-err">
              irreversible
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-[1.4] text-ink-3">
            When on, this agent runs any shell command immediately with no approval gate. Commands
            are still logged. Only enable for agents you fully trust.
          </p>
          {isDormant && canManage && (
            <p className="mt-2 text-[11.5px] text-warn">
              This agent&apos;s Yolo is <b className="font-semibold">dormant</b> — workspace Yolo is
              off, so its commands still require approval. Turn it off here to clear it, or
              re-enable Yolo in{' '}
              <a
                href="/settings"
                className="underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
              >
                Settings → Command execution
              </a>
              .
            </p>
          )}
          {!yoloAllowed && !isDormant && !isLocalTrust && !lanCommandYolo && (
            <p className="mt-2 text-[11.5px] text-ink-4">
              Yolo is off for this workspace. The owner can enable it in{' '}
              <a
                href="/settings"
                className="underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
              >
                Settings → Command execution
              </a>
              , or switch to loopback mode.
            </p>
          )}
          {!yoloAllowed && lanCommandYolo && !isOwner && (
            <p className="mt-2 text-[11.5px] text-ink-4">
              The workspace owner has enabled Yolo for this workspace, but only the owner can toggle
              it per agent.
            </p>
          )}
        </div>

        {/* Toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={yoloEnabled}
          disabled={saving || !canToggle}
          onClick={() => handleToggle(!yoloEnabled)}
          className={[
            'relative mt-0.5 inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            // Dormant (rule exists but workspace Yolo is off): show it in the ON
            // position but neutral grey, not active red — it's inert at runtime.
            isDormant
              ? 'border-ink-4/40 bg-ink-4/20'
              : yoloEnabled
                ? 'border-err/40 bg-err/20'
                : 'border-rule-2 bg-canvas',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-[16px] w-[16px] rounded-full shadow-sm transition-transform',
              yoloEnabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
              isDormant ? 'bg-ink-4' : yoloEnabled ? 'bg-err' : 'bg-ink-3',
            ].join(' ')}
          />
        </button>
      </div>

      {/* Confirm dialog — ESLint bans window.confirm; use ConfirmDialog instead */}
      <ConfirmDialog
        open={confirmOpen}
        title="Enable Yolo mode?"
        message="Yolo mode lets this agent run ANY shell command on this machine with no approval. Only enable for an agent you fully trust. The command is still logged."
        confirmLabel="Enable Yolo"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          void doSet(true);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </SectionCard>
  );
}

// ─── Community-skill script authorization section ─────────────────────────────
//
// Shown only when ≥1 attached community skill ships bundled scripts (non-null
// installedScripts with length > 0). One toggle row per such skill. Owner-only
// for enabling (disabling is immediate, no confirm needed). Enabling pops a
// ConfirmDialog listing the exact script paths before granting access.

function ScriptAuthSection({
  agentId,
  attachedSkills,
  isOwner,
}: {
  agentId: string;
  attachedSkills: SkillRow[];
  isOwner: boolean;
}) {
  // Only skills that carry bundled scripts need a toggle.
  const scriptSkills = attachedSkills.filter(
    (s) => s.isCommunity && s.installedScripts && s.installedScripts.length > 0,
  );

  if (scriptSkills.length === 0) return null;

  return (
    <SectionCard>
      <SectionHead
        label="Community skill scripts"
        hint="These community skills ship bundled scripts (Python / shell). By default scripts never run — enable only for skills you trust. The runner will only execute these exact files."
      />
      <div
        className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2"
        data-testid="script-auth-list"
      >
        {scriptSkills.map((skill) => (
          <ScriptAuthRow key={skill.id} skill={skill} agentId={agentId} isOwner={isOwner} />
        ))}
      </div>
      <p className="mt-4 text-[11px] text-ink-4">
        Granting script access lets this agent run the skill&apos;s bundled scripts on your machine
        without per-command approval.
      </p>
    </SectionCard>
  );
}

function ScriptAuthRow({
  skill,
  agentId,
  isOwner,
}: {
  skill: SkillRow;
  agentId: string;
  isOwner: boolean;
}) {
  // Optimistic local state — seed from the SkillRow value (null → false as safe default).
  const [authorized, setAuthorized] = useState<boolean>(skill.scriptsAuthorized ?? false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const scripts = skill.installedScripts ?? [];

  // Read auth mode — mirrors CommandExecutionSection pattern.
  const isLocalTrust = (process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'local-trust') === 'local-trust';
  const canToggle = isLocalTrust || isOwner;

  async function doSet(next: boolean) {
    setSaving(true);
    setAuthorized(next); // optimistic
    const result = await setSkillScriptsAuthorizedAction({
      agentId,
      skillId: skill.id,
      authorized: next,
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.message);
      setAuthorized(!next); // revert
    } else {
      toast.success(
        next ? `Scripts allowed for "${skill.name}"` : `Script access revoked for "${skill.name}"`,
      );
    }
  }

  function handleToggle() {
    if (authorized) {
      // Disabling: immediate, no confirm.
      void doSet(false);
    } else {
      // Enabling: show security confirmation first.
      setConfirmOpen(true);
    }
  }

  const confirmMessage =
    `This lets ${skill.name} run its bundled scripts on your machine without per-command approval:\n\n` +
    scripts.map((s) => `• ${s.path} (${s.language})`).join('\n') +
    '\n\nOnly enable for skills you fully trust.';

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      {/* Skill identity */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{skill.name}</span>
          <span className="inline-flex h-[18px] items-center rounded-full bg-skill-vivid/10 px-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-skill-vivid">
            community
          </span>
          <span className="inline-flex h-[18px] items-center rounded-full bg-warn/10 px-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-warn">
            {scripts.length} script{scripts.length > 1 ? 's' : ''}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {scripts.map((s) => (
            <code key={s.path} className="font-mono text-[10.5px] text-ink-4">
              {s.path}
            </code>
          ))}
        </div>
        {!canToggle && (
          <p className="mt-1.5 text-[11.5px] text-ink-4">
            Only the workspace owner can authorize scripts.
          </p>
        )}
      </div>

      {/* Toggle */}
      <button
        type="button"
        role="switch"
        aria-checked={authorized}
        aria-label={`Allow scripts for ${skill.name}`}
        disabled={saving || !canToggle}
        onClick={handleToggle}
        className={[
          'relative mt-0.5 inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          authorized ? 'border-warn/40 bg-warn/20' : 'border-rule-2 bg-canvas',
        ].join(' ')}
      >
        <span
          className={[
            'inline-block h-[16px] w-[16px] rounded-full shadow-sm transition-transform',
            authorized ? 'translate-x-[18px] bg-warn' : 'translate-x-[2px] bg-ink-3',
          ].join(' ')}
        />
      </button>

      {/* Confirm dialog — window.confirm is banned; ConfirmDialog is the correct replacement */}
      <ConfirmDialog
        open={confirmOpen}
        title={`Allow scripts for "${skill.name}"?`}
        message={confirmMessage}
        confirmLabel="Allow scripts"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          void doSet(true);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

// ─── Community-skill file-write authorization section ─────────────────────────
//
// Shown only when ≥1 attached community skill exists. One toggle row per such
// skill. Lets the agent WRITE files into the skill's bundle (e.g. drop a new
// ComfyUI workflow) via skill_file_write — a bounded alternative to handing it a
// full shell. Owner-only for enabling; disabling is immediate. Enabling pops a
// ConfirmDialog. Default off — an agent can always read its skills' files but
// never modify them until the owner opts in here.

function FileWriteAuthSection({
  agentId,
  attachedSkills,
  isOwner,
}: {
  agentId: string;
  attachedSkills: SkillRow[];
  isOwner: boolean;
}) {
  const writableSkills = attachedSkills.filter((s) => s.isCommunity);

  if (writableSkills.length === 0) return null;

  return (
    <SectionCard>
      <SectionHead
        label="Community skill file writes"
        hint="Let this agent write files into a community skill's bundle (e.g. save a new ComfyUI workflow) without a shell. Reading is always allowed; writing is off until you enable it here."
      />
      <div
        className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2"
        data-testid="file-write-auth-list"
      >
        {writableSkills.map((skill) => (
          <FileWriteAuthRow key={skill.id} skill={skill} agentId={agentId} isOwner={isOwner} />
        ))}
      </div>
      <p className="mt-4 text-[11px] text-ink-4">
        Writes are bounded to the skill&apos;s own folder (no path escape) and require approval by
        default — far narrower than granting shell access.
      </p>
    </SectionCard>
  );
}

function FileWriteAuthRow({
  skill,
  agentId,
  isOwner,
}: {
  skill: SkillRow;
  agentId: string;
  isOwner: boolean;
}) {
  const [writable, setWritable] = useState<boolean>(skill.filesWritable ?? false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isLocalTrust = (process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'local-trust') === 'local-trust';
  const canToggle = isLocalTrust || isOwner;

  async function doSet(next: boolean) {
    setSaving(true);
    setWritable(next); // optimistic
    const result = await setSkillFilesWritableAction({
      agentId,
      skillId: skill.id,
      writable: next,
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.message);
      setWritable(!next); // revert
    } else {
      toast.success(
        next
          ? `File writes allowed for "${skill.name}"`
          : `File writes revoked for "${skill.name}"`,
      );
    }
  }

  function handleToggle() {
    if (writable) {
      void doSet(false);
    } else {
      setConfirmOpen(true);
    }
  }

  const confirmMessage =
    `This lets ${skill.name} create and overwrite files inside its own skill folder ` +
    '(e.g. workflows, references) without per-write approval defaults applying to the toggle ' +
    'itself. Writes can never escape the skill folder.\n\nOnly enable for skills you trust to ' +
    'manage their own bundle.';

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{skill.name}</span>
          <span className="inline-flex h-[18px] items-center rounded-full bg-skill-vivid/10 px-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-skill-vivid">
            community
          </span>
        </div>
        {!canToggle && (
          <p className="mt-1.5 text-[11.5px] text-ink-4">
            Only the workspace owner can authorize file writes.
          </p>
        )}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={writable}
        aria-label={`Allow file writes for ${skill.name}`}
        disabled={saving || !canToggle}
        onClick={handleToggle}
        className={[
          'relative mt-0.5 inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          writable ? 'border-warn/40 bg-warn/20' : 'border-rule-2 bg-canvas',
        ].join(' ')}
      >
        <span
          className={[
            'inline-block h-[16px] w-[16px] rounded-full shadow-sm transition-transform',
            writable ? 'translate-x-[18px] bg-warn' : 'translate-x-[2px] bg-ink-3',
          ].join(' ')}
        />
      </button>

      <ConfirmDialog
        open={confirmOpen}
        title={`Allow file writes for "${skill.name}"?`}
        message={confirmMessage}
        confirmLabel="Allow file writes"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          void doSet(true);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function AutonomyToolRow({
  op,
  value,
  saving,
  onChange,
}: {
  op: OperationDescriptor;
  value: ApprovalAction;
  saving: boolean;
  onChange: (action: ApprovalAction) => void;
}) {
  const riskLabel: Record<string, string> = { write: 'write', destructive: 'irreversible' };

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      {/* Tool identity */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{op.name}</span>
          <span
            className={[
              'inline-flex h-[18px] items-center rounded-full px-2 font-mono text-[9.5px] uppercase tracking-[0.1em]',
              op.risk === 'destructive' ? 'bg-err/10 text-err' : 'bg-warn/10 text-warn',
            ].join(' ')}
          >
            {riskLabel[op.risk] ?? op.risk}
          </span>
        </div>
        {op.description && (
          <p className="mt-0.5 text-[12px] leading-[1.4] text-ink-3">{op.description}</p>
        )}
        <code className="mt-1 block font-mono text-[10.5px] text-ink-4">{op.slug}</code>
      </div>

      {/* 3-way control */}
      <div
        className="flex shrink-0 overflow-hidden rounded-lg border border-rule-2"
        role="group"
        aria-label={`Approval policy for ${op.name}`}
      >
        {(
          [
            { action: 'auto_approve' as const, label: 'Autonomous' },
            { action: 'require_approval' as const, label: 'Ask first' },
            { action: 'block' as const, label: 'Block' },
          ] as { action: ApprovalAction; label: string }[]
        ).map(({ action, label }, idx) => {
          const isActive = value === action;
          const activeClass =
            action === 'block'
              ? 'bg-err/15 text-err border-err/30'
              : action === 'require_approval'
                ? 'bg-warn/15 text-warn border-warn/30'
                : 'bg-agent-vivid/15 text-agent-vivid border-agent-vivid/30';
          return (
            <button
              key={action}
              type="button"
              disabled={saving}
              onClick={() => onChange(action)}
              data-testid={`autonomy-btn-${op.slug}-${action}`}
              className={[
                'relative h-[32px] px-3 text-[12px] font-medium transition-colors',
                idx > 0 ? 'border-l border-rule-2' : '',
                isActive ? activeClass : 'bg-canvas text-ink-3 hover:bg-hover hover:text-ink-2',
                saving ? 'cursor-wait opacity-60' : '',
              ].join(' ')}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
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
  fallbackChain: Array<{ keyId: string; model: string }>;
  activeKeys: LlmKeyUiRow[];
  selectedKey: LlmKeyUiRow | null;
  model: string;
  noLlmKeys: boolean;
  workspaces: AgentWorkspaceRow[];
  workspacesLoaded: boolean;
  onWorkspacesChange: (ws: AgentWorkspaceRow[]) => void;
  agentId: string;
  dirty: boolean;
  isPending: boolean;
  onChangeName: (v: string) => void;
  onChangeAvatar: (v: string | null) => void;
  onChangePersonality: (v: string) => void;
  onChangeRole: (r: AgentRole) => void;
  onToggleSubAgent: (id: string) => void;
  onToggleFallback: (id: string) => void;
  onChangeFallbackModel: (id: string, model: string) => void;
  onChangeLlmKey: (id: string) => void;
  onChangeModel: (v: string) => void;
  onSave: () => void;
  onReset: () => void;
  liveModelsCache: Record<string, string[]>;
  liveModelsLoading: boolean;
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
    fallbackChain,
    activeKeys,
    selectedKey,
    model,
    noLlmKeys,
    workspaces,
    workspacesLoaded,
    onWorkspacesChange,
    agentId,
    dirty,
    isPending,
    onChangeName,
    onChangeAvatar,
    onChangePersonality,
    onChangeRole,
    onToggleSubAgent,
    onToggleFallback,
    onChangeFallbackModel,
    onChangeLlmKey,
    onChangeModel,
    onSave,
    onReset,
    liveModelsCache,
    liveModelsLoading,
  } = props;

  // Candidate fallback keys = every active key except the current primary.
  const otherKeys = activeKeys.filter((k) => k.id !== llmKeyId);

  // Curated models for the selected key's provider (T2). The agent's model is a
  // free string; the dropdown just helps pick a known-good id (capability flags
  // live on the KEY, not here). Derive "custom" from whether `model` is curated.
  const modelCatalog = selectedKey ? (MODEL_CATALOG[selectedKey.provider] ?? []) : [];
  const modelInCatalog = !!findModelCatalogEntry(selectedKey?.provider ?? '', model);

  // Live model ids from the provider's /models endpoint for this key.
  const liveModelIds: string[] = selectedKey ? (liveModelsCache[selectedKey.id] ?? []) : [];

  // Union: catalog first, then extra live ids not already in catalog.
  const catalogModelIds = new Set(modelCatalog.map((m) => m.modelId));
  const extraLiveIds = liveModelIds.filter((id) => !catalogModelIds.has(id));

  // The model is "in the dropdown" if it matches a catalog entry OR a live id.
  const modelInDropdown = modelInCatalog || liveModelIds.includes(model);

  // ── Workspace management local state ─────────────────────────────────────
  const [wsLabel, setWsLabel] = useState('');
  const [wsPath, setWsPath] = useState('');
  const [wsAdding, setWsAdding] = useState(false);
  const [wsRemoveId, setWsRemoveId] = useState<string | null>(null);
  const [wsIsPending, startWsTransition] = useTransition();

  // ── Workspace file upload / list local state ───────────────────────────────
  // Per-workspace file lists: { [label]: WorkspaceFileRow[] }
  const [wsFiles, setWsFiles] = useState<Record<string, WorkspaceFileRow[]>>({});
  const [wsFilesLoaded, setWsFilesLoaded] = useState<Record<string, boolean>>({});
  const [wsUploadLabel, setWsUploadLabel] = useState<string>('');
  const [wsUploading, setWsUploading] = useState(false);
  const [wsDeleteTarget, setWsDeleteTarget] = useState<{ label: string; name: string } | null>(
    null,
  );
  const [wsFilesPending, startWsFileTransition] = useTransition();

  // Load files for all workspaces when workspace list changes
  useEffect(() => {
    for (const ws of workspaces) {
      if (!wsFilesLoaded[ws.label]) {
        listWorkspaceFilesAction(agentId, ws.label).then((res) => {
          if (res.ok) {
            setWsFiles((prev) => ({ ...prev, [ws.label]: res.data }));
          }
          setWsFilesLoaded((prev) => ({ ...prev, [ws.label]: true }));
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, agentId]);

  async function handleUploadFile(label: string, file: File) {
    setWsUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    const result = await uploadToWorkspaceAction(agentId, label, fd);
    setWsUploading(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(`Uploaded ${result.data.filename}`);
    const listResult = await listWorkspaceFilesAction(agentId, label);
    if (listResult.ok) setWsFiles((prev) => ({ ...prev, [label]: listResult.data }));
  }

  function handleDeleteFile(label: string, name: string) {
    setWsDeleteTarget({ label, name });
  }

  function confirmDeleteFile() {
    if (!wsDeleteTarget) return;
    const { label, name } = wsDeleteTarget;
    startWsFileTransition(async () => {
      setWsDeleteTarget(null);
      const result = await deleteWorkspaceFileAction(agentId, label, name);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Deleted ${name}`);
      const listResult = await listWorkspaceFilesAction(agentId, label);
      if (listResult.ok) setWsFiles((prev) => ({ ...prev, [label]: listResult.data }));
    });
  }

  function handleAddWorkspace() {
    if (!wsLabel.trim() || !wsPath.trim()) return;
    startWsTransition(async () => {
      setWsAdding(true);
      const result = await addAgentWorkspaceAction(agentId, wsLabel.trim(), wsPath.trim());
      setWsAdding(false);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      // Reload folder list
      const listResult = await listAgentWorkspacesAction(agentId);
      if (listResult.ok) onWorkspacesChange(listResult.data);
      setWsLabel('');
      setWsPath('');
      toast.success('Folder added');
    });
  }

  function handleRemoveWorkspace(id: string) {
    startWsTransition(async () => {
      const result = await removeAgentWorkspaceAction(id);
      setWsRemoveId(null);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      const listResult = await listAgentWorkspacesAction(agentId);
      if (listResult.ok) onWorkspacesChange(listResult.data);
      toast.success('Folder removed');
    });
  }

  return (
    <div className="space-y-6 pb-24">
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
            rows={24}
            placeholder="You are a helpful assistant…"
            className="min-h-[560px] w-full resize-y rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[12.5px] leading-[1.55] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
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
          <Field
            label={
              liveModelsLoading &&
              selectedKey?.id !== undefined &&
              liveModelsCache[selectedKey.id] === undefined
                ? 'Model (loading…)'
                : 'Model'
            }
          >
            {(modelCatalog.length > 0 || extraLiveIds.length > 0) && (
              <select
                value={modelInDropdown ? model : '__custom__'}
                onChange={(e) =>
                  onChangeModel(e.target.value === '__custom__' ? '' : e.target.value)
                }
                className="mb-2 w-full rounded-lg border border-rule bg-canvas px-3 py-2 text-[13px] text-ink focus:border-ink-3 focus:outline-none"
              >
                {groupModelCatalog(modelCatalog).map(({ group, models }) =>
                  group ? (
                    <optgroup key={group} label={group}>
                      {models.map((m) => (
                        <option key={m.modelId} value={m.modelId}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    models.map((m) => (
                      <option key={m.modelId} value={m.modelId}>
                        {m.label}
                      </option>
                    ))
                  ),
                )}
                {extraLiveIds.length > 0 && (
                  <optgroup label="Live from provider">
                    {extraLiveIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="__custom__">Custom…</option>
              </select>
            )}
            {!modelInDropdown && (
              <input
                type="text"
                value={model}
                onChange={(e) => onChangeModel(e.target.value)}
                placeholder={
                  MODEL_CATALOG[selectedKey?.provider ?? '']?.[0]?.modelId ??
                  'e.g. claude-haiku-4-5-20251001'
                }
                className="w-full rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
              />
            )}
          </Field>
        </div>
        {!noLlmKeys && (
          <div className="mt-3">
            <Field label="Fallback providers (failover order)">
              {otherKeys.length === 0 ? (
                <p className="text-[12px] text-ink-4">
                  Add another LLM key in{' '}
                  <Link href="/llm-providers" className="underline">
                    LLM providers
                  </Link>{' '}
                  to enable failover.
                </p>
              ) : (
                <div className="space-y-2.5">
                  <p className="text-[12px] text-ink-4">
                    If the primary is down (5xx / timeout / quota) mid-job, the runner fails over to
                    these in order. Pick the model each fallback should run on.
                  </p>
                  {otherKeys.map((k) => {
                    const order = fallbackChain.findIndex((l) => l.keyId === k.id);
                    const checked = order !== -1;
                    const fbCatalog = MODEL_CATALOG[k.provider] ?? [];
                    const fbModel = checked ? (fallbackChain[order]?.model ?? '') : '';
                    return (
                      <div key={k.id} className="space-y-1.5">
                        <label className="flex cursor-pointer items-center gap-2.5 select-none">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => onToggleFallback(k.id)}
                            className="accent-ink"
                          />
                          <span className="text-[13px] text-ink-2">
                            {(k.nickname ?? prettyProviderName(k.provider)) +
                              ' (' +
                              prettyProviderName(k.provider) +
                              ')'}
                          </span>
                          {checked && (
                            <span className="ml-auto rounded-full border border-rule-2 px-2 py-0.5 text-[10px] font-medium text-ink-4">
                              #{order + 1}
                            </span>
                          )}
                        </label>
                        {checked &&
                          (fbCatalog.length > 0 ? (
                            <select
                              value={fbModel}
                              onChange={(e) => onChangeFallbackModel(k.id, e.target.value)}
                              className="ml-[1.6rem] w-[calc(100%-1.6rem)] rounded-lg border border-rule bg-canvas px-3 py-1.5 text-[12.5px] text-ink focus:border-ink-3 focus:outline-none"
                            >
                              {groupModelCatalog(fbCatalog).map(({ group, models }) =>
                                group ? (
                                  <optgroup key={group} label={group}>
                                    {models.map((m) => (
                                      <option key={m.modelId} value={m.modelId}>
                                        {m.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                ) : (
                                  models.map((m) => (
                                    <option key={m.modelId} value={m.modelId}>
                                      {m.label}
                                    </option>
                                  ))
                                ),
                              )}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={fbModel}
                              onChange={(e) => onChangeFallbackModel(k.id, e.target.value)}
                              placeholder="model id (e.g. llama-3.3-70b)"
                              className="ml-[1.6rem] w-[calc(100%-1.6rem)] rounded-lg border border-rule bg-canvas px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
                            />
                          ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </Field>
          </div>
        )}
      </SectionCard>

      {/* Knowledge — folder list + file upload. MCP servers live in Connectors tab. */}
      <SectionCard>
        <SectionHead
          label="Knowledge"
          hint="Folders scope file_* tools. Add multiple paths with distinct labels."
        />

        {/* Existing folders with per-folder file lists + upload */}
        {!workspacesLoaded ? (
          <p className="text-[12.5px] text-ink-4">Loading…</p>
        ) : workspaces.length === 0 ? (
          <p className="text-[12.5px] text-ink-4">No folders configured.</p>
        ) : (
          <div className="space-y-4 mb-4">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className="rounded-lg border border-rule bg-hover/50 overflow-hidden"
              >
                {/* Folder header row */}
                <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-rule">
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-[11px] font-semibold text-ink-2 mr-2">
                      {ws.label}
                    </span>
                    <span className="font-mono text-[11.5px] text-ink-3 break-all">{ws.path}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setWsRemoveId(ws.id)}
                    disabled={wsIsPending}
                    className="shrink-0 rounded border border-rule px-2 py-0.5 text-[11px] text-err hover:border-err/40 hover:bg-err/5 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>

                {/* File list */}
                <div className="px-3 pt-2 pb-1">
                  {!wsFilesLoaded[ws.label] ? (
                    <p className="text-[11.5px] text-ink-4 py-1">Loading files…</p>
                  ) : (wsFiles[ws.label] ?? []).length === 0 ? (
                    <p className="text-[11.5px] text-ink-4 py-1">No files uploaded yet.</p>
                  ) : (
                    <div className="space-y-1 mb-2">
                      {(wsFiles[ws.label] ?? []).map((f) => (
                        <div
                          key={f.name}
                          className="flex items-center justify-between gap-2 rounded px-2 py-1 bg-canvas border border-rule-2 text-[11.5px]"
                        >
                          <span className="font-mono text-ink-2 truncate min-w-0">{f.name}</span>
                          <span className="shrink-0 text-ink-4">
                            {f.size >= 1024 * 1024
                              ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                              : f.size >= 1024
                                ? `${(f.size / 1024).toFixed(0)} KB`
                                : `${f.size} B`}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleDeleteFile(ws.label, f.name)}
                            disabled={wsFilesPending}
                            className="shrink-0 rounded border border-rule px-1.5 py-0.5 text-[10px] text-err hover:border-err/40 hover:bg-err/5 disabled:opacity-50"
                          >
                            Delete
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Upload button + drag-drop */}
                  <label
                    className={`flex items-center gap-2 cursor-pointer rounded-lg border border-dashed px-3 py-2 text-[12px] transition-colors mb-2
                      ${
                        wsUploading && wsUploadLabel === ws.label
                          ? 'border-ink-3 text-ink-3 bg-hover'
                          : 'border-rule text-ink-4 hover:border-ink-3 hover:text-ink-3'
                      }`}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="shrink-0"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    {wsUploading && wsUploadLabel === ws.label
                      ? 'Uploading…'
                      : 'Upload file (.docx .xlsx .pptx .pdf .txt .md .csv — max 25 MB)'}
                    <input
                      type="file"
                      className="sr-only"
                      accept=".docx,.xlsx,.pptx,.pdf,.txt,.md,.csv"
                      disabled={wsUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        // reset so the same file can be re-selected after an error
                        e.target.value = '';
                        setWsUploadLabel(ws.label);
                        void handleUploadFile(ws.label, file);
                      }}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add folder form */}
        <div className="flex flex-col gap-2">
          <Field label="Add folder">
            <div className="flex gap-2">
              <input
                type="text"
                value={wsLabel}
                onChange={(e) => setWsLabel(e.target.value)}
                placeholder="Label (e.g. notes)"
                maxLength={80}
                className="w-28 shrink-0 rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
              />
              <input
                type="text"
                value={wsPath}
                onChange={(e) => setWsPath(e.target.value)}
                placeholder="/home/you/notes  or  C:\Users\you\docs"
                className="min-w-0 flex-1 rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddWorkspace}
                disabled={wsIsPending || wsAdding || !wsLabel.trim() || !wsPath.trim()}
                className="shrink-0 rounded-lg border border-rule px-4 py-2 text-[13px] font-medium text-ink-2 hover:border-rule-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {wsAdding ? 'Adding…' : 'Add'}
              </button>
            </div>
          </Field>
          <p className="text-[11px] text-ink-4">
            Absolute path. Label is the prefix the agent uses (e.g.{' '}
            <code className="font-mono">notes/file.md</code>). Leave label blank if a single folder
            — label is then optional.
          </p>
        </div>

        {/* Confirm folder removal dialog — never window.confirm (ESLint-enforced ban) */}
        <ConfirmDialog
          open={wsRemoveId !== null}
          title="Remove folder"
          message="The agent will lose file access to this path. Existing files are NOT deleted."
          confirmLabel="Remove"
          destructive
          onConfirm={() => wsRemoveId && handleRemoveWorkspace(wsRemoveId)}
          onCancel={() => setWsRemoveId(null)}
        />

        {/* Confirm file deletion dialog */}
        <ConfirmDialog
          open={wsDeleteTarget !== null}
          title="Delete file"
          message={
            wsDeleteTarget
              ? `Delete "${wsDeleteTarget.name}" from folder "${wsDeleteTarget.label}"? This cannot be undone.`
              : ''
          }
          confirmLabel="Delete"
          destructive
          onConfirm={confirmDeleteFile}
          onCancel={() => setWsDeleteTarget(null)}
        />
      </SectionCard>

      {/* Sticky save bar */}
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
            disabled={isPending || noLlmKeys || !dirty}
            title={!dirty ? 'No changes to save' : undefined}
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
