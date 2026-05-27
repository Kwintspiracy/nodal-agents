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
  type JobRow,
  type SkillRow,
} from '@/lib/actions.ts';
import { prettyProviderName } from '@/lib/provider-names.ts';
import {
  detectModelProviders,
  isModelCompatibleWithProvider,
  type ProviderSlug,
} from '@/lib/model-provider-detect.ts';
import AvatarPicker from '@/components/AvatarPicker.tsx';
import Disc from '@/components/ui/Disc';
import EdRow, { IcBtn } from '@/components/ui/EdRow';
import EdAddButton from '@/components/ui/EdAddButton';
import RunsTable from '@/app/(dashboard)/jobs/RunsTable';
import { CONN_BRAND_COLORS, connGlyph } from '@/app/(dashboard)/connectors/connector-brand.ts';
import ConnectorsTabContent from './ConnectorsTabContent.tsx';
import KnowledgeMcpRows from './KnowledgeMcpRows.tsx';

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
  jobs: JobRow[];
  attachedSkills: SkillRow[];
}

export default function AgentComposer({
  agent,
  peers,
  llmKeys,
  connectors,
  mcpServers,
  jobs,
  attachedSkills,
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

  // Run aggregates from the jobs prop (already filtered to this agent).
  const totalRuns = jobs.length;
  const successfulRuns = jobs.filter((j) => j.status === 'completed').length;

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
          connectors: assignedConnectors,
          runs: totalRuns,
        }}
      />

      {tab === 'overview' && (
        <OverviewTab
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
          <ConnectorsTabContent agentId={agent.id} connectors={connectors} />
        </SectionCard>
      )}
      {tab === 'runs' && (
        <RunsTable
          jobs={jobs}
          agents={[{ id: agent.id, name: agent.name, slug: agent.slug } as AgentRow, ...peers]}
          agentId={agent.id}
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

      {/* Stat strip — only metrics we actually have, the rest dropped to avoid empty cells */}
      <div className="grid grid-cols-2 gap-px border-t border-rule-2 bg-rule-2 sm:grid-cols-3 lg:grid-cols-6">
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
  attachedSkills,
  connectorsAssigned,
  mcpsAssignedCount,
  onOpenSkills,
  onOpenConnectors,
}: {
  attachedSkills: SkillRow[];
  connectorsAssigned: AgentConnectorRow[];
  mcpsAssignedCount: number;
  onOpenSkills: () => void;
  onOpenConnectors: () => void;
}) {
  const hasSkills = attachedSkills.length > 0;
  const hasConnectors = connectorsAssigned.length > 0;

  // If no skills + no connectors, show a single empty state instead of two empty cards.
  if (!hasSkills && !hasConnectors) {
    return (
      <SectionCard>
        <SectionHead
          label="Nothing wired yet"
          hint="Attach skills and connectors to make this agent useful."
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onOpenSkills}
            className="rounded-lg border border-rule bg-canvas px-3.5 py-2 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-rule-2 hover:text-ink"
          >
            Attach skills →
          </button>
          <button
            type="button"
            onClick={onOpenConnectors}
            className="rounded-lg border border-rule bg-canvas px-3.5 py-2 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-rule-2 hover:text-ink"
          >
            Attach connectors →
          </button>
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* Skills attached — 2 cols wide */}
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
          <div className="space-y-2">
            {attachedSkills.slice(0, 6).map((s) => (
              <SkillEdRow key={s.id} skill={s} />
            ))}
            {attachedSkills.length > 6 && (
              <button
                type="button"
                onClick={onOpenSkills}
                className="mt-1 text-[11.5px] text-ink-3 underline hover:text-ink-2"
              >
                + {attachedSkills.length - 6} more
              </button>
            )}
          </div>
        ) : (
          <EdAddButton onClick={onOpenSkills}>Add skill from marketplace</EdAddButton>
        )}
      </SectionCard>

      {/* Connectors used */}
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
          <EdAddButton onClick={onOpenConnectors}>Connect from marketplace</EdAddButton>
        )}
        {mcpsAssignedCount > 0 && (
          <p className="mt-3 border-t border-rule-2 pt-3 text-[11.5px] text-ink-4">
            + {mcpsAssignedCount} MCP server{mcpsAssignedCount > 1 ? 's' : ''} attached (Settings →
            Knowledge).
          </p>
        )}
      </SectionCard>
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
          hint="Skills are the agent's reusable capabilities. Attach some from the library."
        />
        <EdAddButton href="/skills">Add skill from marketplace</EdAddButton>
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
      <div className="mt-4">
        <EdAddButton href="/skills">Add skill from marketplace</EdAddButton>
      </div>
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
            rows={16}
            placeholder="You are a helpful assistant…"
            className="min-h-[320px] w-full resize-y rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[12.5px] leading-[1.55] text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
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
            <KnowledgeMcpRows agentId={agentId} servers={mcpServers} />
          </Field>
        </div>
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
