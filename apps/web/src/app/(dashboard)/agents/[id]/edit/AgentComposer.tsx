'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Brain } from '@phosphor-icons/react';
import { skillProvenanceIcon, skillProvenanceTag } from '@/components/SkillProvenance.tsx';
import { segmentSkillsByProvenance } from '@/lib/skill-provenance.ts';
import PageShell from '@/components/ui/PageShell';
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
  deleteAgentAction,
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
  setCodeTaskYoloAction,
  setCliDailyBudgetAction,
  getCliUsageTodayAction,
  setReviewerReadOnlyPresetAction,
  setSkillScriptsAuthorizedAction,
  setSkillFilesWritableAction,
  assignSkillAction,
  unassignSkillAction,
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
  type TelegramConfigRow,
  type TelegramAllowedChatView,
  type DiscordConfigRow,
  type SlackConfigRow,
  type ChannelAllowedConversationView,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import {
  MODEL_CATALOG,
  findModelCatalogEntry,
  groupModelCatalog,
  modelOptionLabel,
  modelToolsSupport,
} from '@nodal-agents/shared';
import { prettyProviderName } from '@/lib/provider-names.ts';
import { type ProviderSlug } from '@/lib/model-provider-detect.ts';
import AvatarPicker from '@/components/AvatarPicker.tsx';
import Disc from '@/components/ui/Disc';
import Tabs from '@/components/ui/Tabs';
import AgentPill from '@/components/ui/AgentPill';
import EdRow, { IcBtn } from '@/components/ui/EdRow';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import StatusPill from '@/components/ui/StatusPill';
import RowActionButton from '@/components/ui/RowActionButton';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';
import TextArea from '@/components/ui/TextArea';
import Select from '@/components/ui/Select';
import Checkbox from '@/components/ui/Checkbox';
import Switch from '@/components/ui/Switch';
import SegmentedControl from '@/components/ui/SegmentedControl';
import ModelToolsBadge, { ModelToolsLegend } from '@/components/ui/ModelToolsBadge.tsx';
import RunsTable from '@/app/(dashboard)/jobs/RunsTable';
import { CONN_BRAND_COLORS, connGlyph } from '@/app/(dashboard)/connectors/connector-brand.ts';
import ConnectorsTabContent from './ConnectorsTabContent.tsx';
import ChannelsTabContent from './ChannelsTabContent.tsx';
import ToolsTab from './ToolsTabContent.tsx';
import AgentDangerZone from './AgentDangerZone.tsx';
import type { OperationDescriptor } from '@nodal-agents/shared';
import { isToolGroupSkill } from '@/lib/skill-tool-groups.ts';

/**
 * AgentComposer — detail page for /agents/[id]/edit.
 *
 * Matches the screenshot Quentin shared (2026-05-27): a hero card with
 * avatar + name + status + meta + a Memory CTA, followed by a stat strip
 * (only metrics we actually have are filled), then tabs:
 *
 *   Overview · Channels · Skills · Tools · Connectors · Runs · Autonomy · Settings
 *
 * Tools (added 17/07) surfaces system skills that only exist to gate a bundle
 * of native builtins (office-editing, command-execution) as toggleable tool
 * groups — see ToolsTabContent.tsx and isToolGroupSkill. They're hidden from
 * the Skills tab entirely so a given capability shows up in exactly one place.
 *
 * Channels is a real in-page tab (Quentin's correction: it used to be its
 * own page, then briefly a tab-bar link — it's now the actual channel-cards
 * content rendered right here; see ChannelsTabContent.tsx and its data
 * loaded in page.tsx). Supports deep-linking via `?tab=channels` (read once
 * on mount below) so the old standalone /agents/[id]/channels route and the
 * /agents list's Channels row action can both land here directly. Memory
 * stays a header CTA (entity-wide, not per-agent enough to earn a tab).
 * Configure was removed — it only ever jumped to the Settings tab that
 * already sits right here.
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
 * Settings tab is where editing happens, ending in a danger zone (delete —
 * the sole surface for it now) and a sticky save bar at the bottom.
 */

type Tab =
  | 'overview'
  | 'channels'
  | 'skills'
  | 'tools'
  | 'connectors'
  | 'runs'
  | 'autonomy'
  | 'settings';

/** Tab ids that are valid deep-link targets for `?tab=`. */
const TAB_IDS: readonly Tab[] = [
  'overview',
  'channels',
  'skills',
  'tools',
  'connectors',
  'runs',
  'autonomy',
  'settings',
];
function isTab(value: string | null): value is Tab {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}
type AgentRole = 'worker' | 'router' | 'planner';

function dbRoleToUiRole(
  role: string | null,
  orchestratorMode: string | null | undefined,
): AgentRole {
  if (role === 'orchestrator' && orchestratorMode === 'planner') return 'planner';
  if (role === 'orchestrator') return 'router';
  return 'worker';
}

// ── Reasoning effort options (per-agent effort brick) ─────────────────────────
// The selectable values for a given provider+model, straight from the catalog's
// reasoningControl: the model's declared levels, plus 'off' unless reasoning is
// mandatory. Empty array = nothing controllable → the field is hidden.
const REASONING_BUDGET_ORDER = ['low', 'medium', 'high', 'max'] as const;
function reasoningOptionValues(provider: string, modelId: string): string[] {
  const control = findModelCatalogEntry(provider, modelId)?.capabilities.reasoningControl;
  if (!control) return [];
  const levels =
    control.kind === 'onoff'
      ? []
      : control.kind === 'budget'
        ? REASONING_BUDGET_ORDER.filter((l) => control.budgets?.[l])
        : (control.levels ?? []);
  return control.mandatory ? [...levels] : [...levels, 'off'];
}
const REASONING_LABELS: Record<string, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};

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
  /** Every skill in the entity (Library + custom), used by the Skills tab to
   *  offer attach on top of the already-attached list. */
  allSkills: SkillRow[];
  /** Whether the workspace owner has opted in to Yolo in non-local-trust mode. */
  lanCommandYolo?: boolean;
  /** Whether the current user is the workspace owner. */
  isOwner?: boolean;
  /** Channels tab data (see ChannelsTabContent.tsx) — null cfg fields signal
   *  `channelsError` happened; the tab renders a banner in that case. */
  channelsError: string | null;
  telegramCfg: TelegramConfigRow | null;
  telegramAllowedChats: TelegramAllowedChatView[];
  discordCfg: DiscordConfigRow | null;
  discordAllowedConversations: ChannelAllowedConversationView[];
  slackCfg: SlackConfigRow | null;
  slackAllowedConversations: ChannelAllowedConversationView[];
  whatsappStatus: 'connected' | 'disconnected';
  whatsappAllowedConversations: ChannelAllowedConversationView[];
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
  allSkills,
  lanCommandYolo = false,
  isOwner = false,
  channelsError,
  telegramCfg,
  telegramAllowedChats,
  discordCfg,
  discordAllowedConversations,
  slackCfg,
  slackAllowedConversations,
  whatsappStatus,
  whatsappAllowedConversations,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  // Deep-link: `?tab=channels` (old /channels page redirect, /agents list's
  // Channels row action) opens straight on that tab. Read once on mount —
  // switching tabs afterwards is purely client state, same as every other
  // tab here.
  const [tab, setTab] = useState<Tab>(() => {
    const fromUrl = searchParams.get('tab');
    return isTab(fromUrl) ? fromUrl : 'overview';
  });

  // ── form state (only the Settings tab edits these) ────────────────────────
  const initialRole = dbRoleToUiRole(agent.role ?? null, agent.orchestratorMode ?? null);
  const activeKeys = useMemo(() => llmKeys.filter((k) => k.isActive), [llmKeys]);
  const initialLlmKeyId = agent.llmKeyId ?? activeKeys[0]?.id ?? '';

  const [name, setName] = useState(agent.name);
  const [personality, setPersonality] = useState(agent.personality ?? '');
  const [role, setRole] = useState<AgentRole>(initialRole);
  const [subAgentIds, setSubAgentIds] = useState<string[]>(agent.subAgentIds);
  // Routing instructions per sub-agent (agent_assignments.instructions) —
  // the line the orchestrator reads in its team block to route correctly.
  const [subAgentInstructions, setSubAgentInstructions] = useState<Record<string, string>>(
    agent.subAgentInstructions ?? {},
  );
  const [llmKeyId, setLlmKeyId] = useState<string>(initialLlmKeyId);
  // Guard 2: ordered failover chain (in order) — each link is a (keyId, model)
  // pair so a fallback runs on a chosen model.
  const [fallbackChain, setFallbackChain] = useState<
    Array<{ keyId: string; model: string; reasoningEffort?: string }>
  >(agent.fallbackChain ?? []);
  const [model, setModel] = useState<string>(agent.model ?? '');
  // '' = Auto (provider default). Levels offered come from the catalog.
  const [reasoningEffort, setReasoningEffort] = useState<string>(agent.reasoningEffort ?? '');
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
  // Tool-group skills (office-editing, command-execution…) no longer count
  // as "skills" anywhere in the UI — they're Tools now. Every surface that
  // counts/lists attachedSkills for a human ("Skills" stat, tab badge,
  // Overview, the Skills tab itself) uses this filtered view. The Autonomy
  // tab keeps the RAW attachedSkills — it still needs to detect whether
  // command-execution is assigned to show the Yolo section.
  const attachedNonToolSkills = useMemo(
    () => attachedSkills.filter((s) => !isToolGroupSkill(s)),
    [attachedSkills],
  );
  const nonToolSkills = useMemo(() => allSkills.filter((s) => !isToolGroupSkill(s)), [allSkills]);
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
    JSON.stringify(subAgentInstructions) !== JSON.stringify(agent.subAgentInstructions ?? {}) ||
    llmKeyId !== initialLlmKeyId ||
    JSON.stringify(fallbackChain) !== JSON.stringify(agent.fallbackChain ?? []) ||
    model !== (agent.model ?? '') ||
    reasoningEffort !== (agent.reasoningEffort ?? '') ||
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
    // An effort only makes sense if the new provider+model still offers it.
    if (
      reasoningEffort &&
      !reasoningOptionValues(newKey?.provider ?? '', firstCurated).includes(reasoningEffort)
    ) {
      setReasoningEffort('');
    }
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
    // An effort the new model's control doesn't offer is dropped back to Auto.
    const provider = llmKeys.find((k) => k.id === llmKeyId)?.provider ?? '';
    if (reasoningEffort && !reasoningOptionValues(provider, next).includes(reasoningEffort)) {
      setReasoningEffort('');
    }
  }

  function toggleSubAgent(id: string) {
    setSubAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function setSubAgentInstruction(id: string, text: string) {
    setSubAgentInstructions((prev) => {
      if (!text) {
        const rest = { ...prev };
        delete rest[id];
        return rest;
      }
      return { ...prev, [id]: text };
    });
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
    setFallbackChain((prev) =>
      prev.map((l) => {
        if (l.keyId !== id) return l;
        // A model switch drops an effort its control doesn't offer (back to inherit).
        const provider = llmKeys.find((k) => k.id === id)?.provider ?? '';
        const keepEffort =
          l.reasoningEffort && reasoningOptionValues(provider, model).includes(l.reasoningEffort);
        return keepEffort ? { ...l, model } : { keyId: l.keyId, model };
      }),
    );
  }

  // '' = inherit the agent-level setting (the stored link then has no effort).
  function setFallbackEffort(id: string, effort: string) {
    setFallbackChain((prev) =>
      prev.map((l) =>
        l.keyId === id
          ? effort
            ? { ...l, reasoningEffort: effort }
            : { keyId: l.keyId, model: l.model }
          : l,
      ),
    );
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
      subAgentInstructions,
      avatarUrl,
      reasoningEffort: reasoningEffort || null,
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
    setSubAgentInstructions(agent.subAgentInstructions ?? {});
    setLlmKeyId(initialLlmKeyId);
    setFallbackChain(agent.fallbackChain ?? []);
    setModel(agent.model ?? '');
    setReasoningEffort(agent.reasoningEffort ?? '');
    setAvatarUrl(agent.avatarUrl ?? null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <PageShell title="Edit agent" subtitle={agent.name}>
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
          provider={llmKeys.find((k) => k.id === agent.llmKeyId)?.provider ?? null}
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
            skills: attachedNonToolSkills.length,
            totalRuns,
            successfulRuns,
          }}
        />

        <TabsBar
          tab={tab}
          onChange={setTab}
          counts={{
            skills: attachedNonToolSkills.length,
            // Only ENABLED tool groups count here — attachedSkills already
            // excludes anything not assigned to this agent.
            tools: attachedSkills.filter(isToolGroupSkill).length,
            // Connectors tab now lists API + MCP combined — count both.
            connectors: assignedConnectors + assignedMcps,
            runs: totalRuns,
          }}
        />

        {tab === 'overview' && (
          <OverviewTab
            jobs={jobs}
            attachedSkills={attachedNonToolSkills}
            connectorsAssigned={assignedConnectorRows}
            mcpsAssignedCount={assignedMcps}
            onOpenSkills={() => setTab('skills')}
            onOpenConnectors={() => setTab('connectors')}
          />
        )}
        {tab === 'channels' && (
          <ChannelsTabContent
            agentId={agent.id}
            agentSlug={agent.slug}
            error={channelsError}
            telegramCfg={telegramCfg}
            telegramAllowedChats={telegramAllowedChats}
            discordCfg={discordCfg}
            discordAllowedConversations={discordAllowedConversations}
            slackCfg={slackCfg}
            slackAllowedConversations={slackAllowedConversations}
            whatsappStatus={whatsappStatus}
            whatsappAllowedConversations={whatsappAllowedConversations}
          />
        )}
        {tab === 'skills' && (
          <SkillsTab
            agentId={agent.id}
            attachedSkills={attachedNonToolSkills}
            allSkills={nonToolSkills}
          />
        )}
        {tab === 'tools' && (
          <ToolsTab
            agentId={agent.id}
            attachedSkills={attachedSkills}
            allSkills={allSkills}
            cliDefaults={agent.cliDefaults}
            onChanged={() => router.refresh()}
          />
        )}
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
            mcpServers={mcpServers}
            hasTelegramBot={!!agent.telegramBotToken}
            attachedSkills={attachedSkills}
            lanCommandYolo={lanCommandYolo}
            isOwner={isOwner}
            cliDailyBudgetUsd={agent.cliDailyBudgetUsd}
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
            subAgentInstructions={subAgentInstructions}
            peers={peers}
            llmKeyId={llmKeyId}
            fallbackChain={fallbackChain}
            activeKeys={activeKeys}
            selectedKey={selectedKey}
            model={model}
            reasoningEffort={reasoningEffort}
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
            onChangeSubAgentInstruction={setSubAgentInstruction}
            onToggleFallback={toggleFallback}
            onChangeFallbackModel={setFallbackModel}
            onChangeFallbackEffort={setFallbackEffort}
            onChangeLlmKey={handleLlmKeyChange}
            onChangeModel={handleModelChange}
            onChangeReasoningEffort={setReasoningEffort}
            onSave={handleSave}
            onReset={handleReset}
            liveModelsCache={liveModelsCache}
            liveModelsLoading={liveModelsLoading}
          />
        )}
      </div>
    </PageShell>
  );
}

// ─── Back link ────────────────────────────────────────────────────────────────

function BackLink() {
  return (
    <Link
      href="/agents"
      className="inline-flex items-center gap-1.5 text-body-13 text-ink-3 transition-colors hover:text-ink-2"
    >
      <span className="text-body-15 leading-none!">‹</span>
      Back to agents
    </Link>
  );
}

// ─── Agent picker pills ───────────────────────────────────────────────────────

function AgentPicker({ agents, activeId }: { agents: AgentRow[]; activeId: string }) {
  if (agents.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {agents.map((a) => (
        <AgentPill
          key={a.id}
          name={a.name}
          href={`/agents/${a.id}/edit`}
          active={a.id === activeId}
        />
      ))}
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
  provider,
  llmKeyLabel,
  stats,
}: {
  initial: string;
  avatarUrl: string | null;
  name: string;
  personaPreview: string;
  role: AgentRole;
  slug: string;
  model: string | null;
  /** The saved LLM key's provider slug — drives the tools-capability badge. */
  provider: string | null;
  llmKeyLabel: string | null;
  stats: {
    connectors: number;
    mcps: number;
    subAgents: number;
    skills: number;
    totalRuns: number;
    successfulRuns: number;
  };
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
          <div className="flex h-[80px] w-[80px] flex-shrink-0 items-center justify-center rounded-2xl bg-agent-vivid text-display-28 text-canvas">
            {initial}
          </div>
        )}

        {/* Title + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            {/* h2, pas h1 : la page porte déjà « Edit agent » comme h1. Deux h1
                sur une même page privent un lecteur d'écran du repère qui dit
                DE QUELLE page il s'agit. La classe porte la taille, donc rien
                ne bouge à l'écran. */}
            <h2 className="m-0 text-display-22 leading-none! tracking-[-0.01em] text-ink">
              {name}
            </h2>
            <StatusPill variant="idle" label="Idle" />
          </div>
          <p className="mt-2 text-body-14 leading-[1.55]! text-ink-3">{personaPreview}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-body-12 text-ink-3">
            {model && (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-ink-4">Model:</span>{' '}
                <code className="rounded border border-rule-2 bg-canvas px-1.5 py-0.5 text-mono-12 text-ink-2">
                  {model}
                </code>
                <ModelToolsBadge support={modelToolsSupport(provider ?? '', model)} />
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

        {/* Memory is entity-wide (not per-agent enough to earn a tab), so it
            stays a header CTA linking out to its own page — same icon as the
            /memories sidebar item (Brain) for a consistent "one concept, one
            icon" mapping across the app. */}
        <div className="flex flex-shrink-0 flex-wrap gap-2">
          <Link
            href="/memories"
            className="inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-rule bg-paper px-3.5 text-medium-13 text-ink-2 transition-colors hover:border-rule-2 hover:text-ink"
          >
            <Brain size={14} />
            Memory
          </Link>
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
      <div className="text-mono-11 uppercase tracking-[0.14em] text-ink-4">{label}</div>
      <div
        className={`mt-1.5 text-heading-20 leading-none! tracking-[-0.01em] ${dim ? 'text-ink-4' : 'text-ink'}`}
      >
        {value}
      </div>
    </div>
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
  counts: { skills: number; tools: number; connectors: number; runs: number };
}) {
  // Configure was removed entirely — it only ever jumped to the Settings tab
  // already sitting right here. Memory stays a header CTA (see HeroCard),
  // not a tab.
  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'channels', label: 'Channels' },
    { id: 'skills', label: 'Skills', count: counts.skills },
    { id: 'tools', label: 'Tools', count: counts.tools },
    { id: 'connectors', label: 'Connectors', count: counts.connectors },
    { id: 'runs', label: 'Runs', count: counts.runs },
    { id: 'autonomy', label: 'Autonomy' },
    { id: 'settings', label: 'Settings' },
  ];
  return <Tabs tabs={TABS} value={tab} onChange={onChange} />;
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
        <div className="text-mono-11 uppercase tracking-[0.12em] text-ink-4">{label}</div>
        {hint && <p className="mt-1 text-body-13 leading-[1.5]! text-ink-3">{hint}</p>}
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
                <RowActionButton onClick={onOpenConnectors}>Manage</RowActionButton>
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
            <p className="text-body-13 text-ink-3">
              No connectors assigned yet.{' '}
              <RowActionButton onClick={onOpenConnectors}>Wire one →</RowActionButton>
            </p>
          )}
          {mcpsAssignedCount > 0 && (
            <p className="mt-3 border-t border-rule-2 pt-3 text-body-12 text-ink-4">
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
            hasSkills ? <RowActionButton onClick={onOpenSkills}>Manage</RowActionButton> : undefined
          }
        />
        {hasSkills ? (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 xl:grid-cols-3">
            {attachedSkills.map((s) => (
              <SkillEdRow key={s.id} skill={s} />
            ))}
          </div>
        ) : (
          <p className="text-body-13 text-ink-3">
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
        <span className="text-mono-11 uppercase tracking-[0.12em] text-ink-4">Runs · 7 days</span>
      </div>
      <div className="mb-4 flex items-baseline gap-3">
        <span className="text-legacy-34 font-semibold leading-none! tracking-[-0.015em] text-ink">
          {total.toLocaleString()}
        </span>
        <span className="text-body-14 text-ink-3">successful run{total === 1 ? '' : 's'}</span>
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
              tick={{ fill: 'var(--c-ink-4)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="var(--c-ink-4)"
              tick={{ fill: 'var(--c-ink-4)', fontSize: 12 }}
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
                fontSize: 13,
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
          {skillProvenanceIcon(skill)}
        </Disc>
      }
      name={skill.name}
      description={skill.description ?? undefined}
      meta={`@${skill.slug}`}
      actions={
        <Link
          href={`/skills/${skill.id}/edit`}
          className="flex h-7 items-center gap-1 rounded-md border border-rule px-2 text-medium-12 text-ink-3 transition-colors hover:border-rule-2 hover:text-ink"
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
          <span className="font-mono text-label-11">{connGlyph(row.slug, row.label)}</span>
        </Disc>
      }
      name={
        <>
          {row.label}
          <span className="ml-2 text-mono-11 uppercase tracking-[0.04em] text-ink-4">
            {row.slug.toUpperCase()}
          </span>
        </>
      }
      description={row.credentialName ?? undefined}
      actions={
        <span className="inline-flex items-center gap-1.5 text-mono-11 uppercase tracking-[0.08em] text-ink-3">
          <span className="h-[6px] w-[6px] rounded-full bg-agent-vivid" />
          on
        </span>
      }
    />
  );
}

// ─── Skills tab — attach/detach on place, parity with the Connectors tab ─────
//
// Product decision (audit UX 12/07, HIGH): the agent page is THE entry point
// for everything per-agent — Skills, Connectors, Channels, Memory. Global
// pages (/skills, /connectors, /mcp) are for installing/creating; they are
// NOT where you decide what a given agent uses. This mirrors how Connectors
// already worked (attach/detach here, browse/install there) — Skills was the
// odd one out (read-only, textual "manage on /skills" renvoi) and is now
// brought to parity. The reverse symmetry (assigning agents from /skills) is
// intentionally NOT built here — /skills keeps its own AssignSkillModal for
// bulk/multi-agent assignment, this tab is the single-agent surface.
//
// `allSkills` (entity-wide, from listSkillsAction) is the source of the
// "available to attach" list; `assignedIds` starts from `attachedSkills`
// (this agent's current assignments) and is updated optimistically as the
// user toggles — same pattern as ConnectorsTabContent's connStates/mcpStates.

function SkillsTab({
  agentId,
  attachedSkills,
  allSkills,
}: {
  agentId: string;
  attachedSkills: SkillRow[];
  allSkills: SkillRow[];
}) {
  const [assignedIds, setAssignedIds] = useState<Set<string>>(
    () => new Set(attachedSkills.map((s) => s.id)),
  );

  function toggle(skill: SkillRow, nextAssigned: boolean) {
    // Optimistic update, reverted on failure — same shape as
    // ConnectorsTabContent's connToggleAssigned/mcpToggleAssigned.
    setAssignedIds((prev) => {
      const next = new Set(prev);
      if (nextAssigned) next.add(skill.id);
      else next.delete(skill.id);
      return next;
    });
    const action = nextAssigned ? assignSkillAction : unassignSkillAction;
    void action({ skillId: skill.id, agentId }).then((result) => {
      if (!result.ok) {
        setAssignedIds((prev) => {
          const next = new Set(prev);
          if (nextAssigned) next.delete(skill.id);
          else next.add(skill.id);
          return next;
        });
        toast.error(result.message);
        return;
      }
      toast.success(nextAssigned ? `"${skill.name}" attached` : `"${skill.name}" detached`);
    });
  }

  const byName = (a: SkillRow, b: SkillRow) => a.name.localeCompare(b.name);
  const attached = allSkills.filter((s) => assignedIds.has(s.id)).sort(byName);
  // Provenance segments (shared model, empty ones hidden). Within the attached
  // card provenances mix, so rows there carry the MonoMicroTag instead.
  const segments = segmentSkillsByProvenance(allSkills.filter((s) => !assignedIds.has(s.id)));

  if (allSkills.length === 0) {
    return (
      <SectionCard>
        <SectionHead
          label="No skills in this workspace yet"
          hint="Create a custom skill or install one from the community catalog first — you'll then be able to attach it to this agent."
        />
        <Link
          href="/skills"
          className="inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-rule bg-paper px-3.5 text-medium-13 text-ink-2 transition-colors hover:border-rule-2 hover:text-ink"
        >
          Go to Skills ›
        </Link>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      <SectionCard>
        <SectionHead
          label={`Attached · ${attached.length}`}
          hint="Loaded into this agent's system prompt. Detach to remove."
        />
        {attached.length === 0 ? (
          <p className="text-body-13 text-ink-3">
            No skills attached to this agent yet. Attach one from the list below.
          </p>
        ) : (
          <div className="space-y-2">
            {attached.map((s) => (
              <SkillToggleRow
                key={s.id}
                skill={s}
                assigned
                showProvenance
                onToggle={() => toggle(s, false)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {segments.length > 0 && (
        <SectionCard>
          <SectionHead
            label={`Available on this workspace · ${segments.reduce((n, seg) => n + seg.skills.length, 0)}`}
            hint="Already installed at the workspace level; click + to attach to this agent."
          />
          <div className="space-y-5">
            {segments.map((seg) => (
              <div key={seg.key}>
                <div className="mb-2.5 flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${seg.dot}`} aria-hidden />
                  <span className="text-medium-13 text-ink">{seg.label}</span>
                  <span className="text-mono-11 text-ink-4">{seg.skills.length}</span>
                </div>
                <div className="space-y-2">
                  {seg.skills.map((s) => (
                    <SkillToggleRow
                      key={s.id}
                      skill={s}
                      assigned={false}
                      onToggle={() => toggle(s, true)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <p className="text-body-13 text-ink-3">
        Need something new?{' '}
        <Link href="/skills" className="underline hover:text-ink-2">
          Browse the Community catalog
        </Link>{' '}
        to create or install a skill, then attach it here.
      </p>
    </div>
  );
}

function SkillToggleRow({
  skill,
  assigned,
  showProvenance = false,
  onToggle,
}: {
  skill: SkillRow;
  assigned: boolean;
  showProvenance?: boolean;
  onToggle: () => void;
}) {
  const provenance = showProvenance ? skillProvenanceTag(skill) : null;
  return (
    <EdRow
      glyph={
        <Disc variant="skill" size="lg" shape="square">
          {skillProvenanceIcon(skill)}
        </Disc>
      }
      name={
        provenance ? (
          <span className="inline-flex items-center gap-1.5">
            {skill.name}
            {provenance}
          </span>
        ) : (
          skill.name
        )
      }
      description={skill.description ?? undefined}
      meta={`@${skill.slug}`}
      actions={
        <>
          {/* Every skill — built-ins included — is viewable/editable: the
              skill editor overrides content (contentOverridden) and can reset
              to the catalog default, so no provenance is a dead end. */}
          <Link
            href={`/skills/${skill.id}/edit`}
            className="flex h-7 items-center gap-1 rounded-md border border-rule px-2 text-medium-12 text-ink-3 transition-colors hover:border-rule-2 hover:text-ink"
          >
            Open ›
          </Link>
          {assigned ? (
            <IcBtn title="Detach from this agent" ariaLabel="Detach" onClick={onToggle}>
              <SkillDetachIcon />
            </IcBtn>
          ) : (
            <IcBtn title="Attach to this agent" ariaLabel="Attach" onClick={onToggle}>
              <SkillAttachIcon />
            </IcBtn>
          )}
        </>
      }
    />
  );
}

function SkillAttachIcon() {
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

function SkillDetachIcon() {
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

/** `cogni-cortex` → `cogni_cortex`. Mirrors slugToPrefix in adapter-mcp. */
function mcpSlugToPrefix(slug: string): string {
  return slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

function AutonomyTab({
  agentId,
  connectors,
  mcpServers,
  hasTelegramBot,
  attachedSkills,
  lanCommandYolo,
  isOwner,
  cliDailyBudgetUsd,
}: {
  agentId: string;
  connectors: AgentConnectorRow[];
  mcpServers: AgentMcpServerRow[];
  hasTelegramBot: boolean;
  attachedSkills: SkillRow[];
  lanCommandYolo: boolean;
  isOwner: boolean;
  cliDailyBudgetUsd: number;
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

  const attachedMcpServers = useMemo(() => mcpServers.filter((s) => s.assigned), [mcpServers]);

  function ruleFor(toolName: string): ApprovalAction {
    return rules.find((r) => r.toolName === toolName)?.action ?? 'auto_approve';
  }

  function handleChange(toolName: string, action: ApprovalAction) {
    // Optimistic update. The row is KEPT for auto_approve — it used to be
    // dropped, mirroring the server action's old "no rule needed, the default
    // is already auto_approve" branch. That stopped being true for MCP tools,
    // which default to require_approval, so dropping it made the UI show "ask"
    // on the next load for a server the owner had just trusted.
    setRules((prev) => [
      ...prev.filter((r) => r.toolName !== toolName),
      { id: '', toolName, action },
    ]);

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
        <p className="text-body-13 text-ink-4">Loading…</p>
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
          <p className="text-body-13 text-ink-3">
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
        <p className="mt-4 text-body-12 text-ink-4">
          Default when no rule is set: <span className="font-medium text-ink-3">Autonomous</span>{' '}
          for the tools above. Rules take effect on the next job — already-running jobs are not
          affected.
        </p>
      </SectionCard>

      {/*
        MCP servers were absent from this screen entirely, which left no way to
        say "stop asking" for a server already attached — the only surface was
        the button on an approval card, i.e. you had to be interrupted first in
        order to stop being interrupted. Reported live: repeated prompts just to
        read a CHANGELOG.

        One row per SERVER, not per tool: a server commonly exposes thirty, and
        the decision the owner actually makes is about the server.
      */}
      {attachedMcpServers.length > 0 && (
        <SectionCard>
          <SectionHead
            label="MCP servers"
            hint="Tools from a third-party MCP server ask before running by default — the product cannot vouch for code it did not write. Trust a server here to stop being asked."
          />
          <div
            className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2"
            data-testid="autonomy-mcp-list"
          >
            {attachedMcpServers.map((s) => {
              const pattern = `${mcpSlugToPrefix(s.slug)}__*`;
              return (
                <AutonomyToolRow
                  key={s.mcpServerId}
                  op={{
                    slug: pattern,
                    name: s.label,
                    risk: 'write',
                    requiresApproval: true,
                    description: `All ${s.availableTools.length} tools exposed by this server, including any it adds later.`,
                  }}
                  // Unlike the connector rows above, "no rule" here means ASK:
                  // every MCP tool ships defaultApproval: 'require_approval'.
                  value={rules.find((r) => r.toolName === pattern)?.action ?? 'require_approval'}
                  saving={saving.has(pattern)}
                  onChange={(action) => handleChange(pattern, action)}
                />
              );
            })}
          </div>
        </SectionCard>
      )}

      <CommandExecutionSection
        agentId={agentId}
        attachedSkills={attachedSkills}
        rules={rules}
        onRulesChange={setRules}
        lanCommandYolo={lanCommandYolo}
        isOwner={isOwner}
      />

      <CodeTaskSection
        agentId={agentId}
        attachedSkills={attachedSkills}
        rules={rules}
        onRulesChange={setRules}
        lanCommandYolo={lanCommandYolo}
        isOwner={isOwner}
        cliDailyBudgetUsd={cliDailyBudgetUsd}
      />

      <ReadOnlyAgentSection
        agentId={agentId}
        rules={rules}
        onRulesChange={setRules}
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
            <span className="text-medium-14 text-ink">
              Auto-run commands without approval (Yolo)
            </span>
            <MonoMicroTag tone="err">irreversible</MonoMicroTag>
          </div>
          <p className="mt-1 text-body-13 leading-[1.4]! text-ink-3">
            When on, this agent runs any shell command immediately with no approval gate. Commands
            are still logged. Only enable for agents you fully trust.
          </p>
          {isDormant && canManage && (
            <p className="mt-2 text-body-12 text-warn">
              This agent&apos;s Yolo is <b className="font-semibold">dormant</b> — workspace Yolo is
              off, so its commands still require approval. Turn it off here to clear it, or
              re-enable Yolo in{' '}
              <Link
                href="/settings"
                className="underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
              >
                Settings → Command execution
              </Link>
              .
            </p>
          )}
          {!yoloAllowed && !isDormant && !isLocalTrust && !lanCommandYolo && (
            <p className="mt-2 text-body-12 text-ink-4">
              Yolo is off for this workspace. The owner can enable it in{' '}
              <Link
                href="/settings"
                className="underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
              >
                Settings → Command execution
              </Link>
              , or switch to loopback mode.
            </p>
          )}
          {!yoloAllowed && lanCommandYolo && !isOwner && (
            <p className="mt-2 text-body-12 text-ink-4">
              The workspace owner has enabled Yolo for this workspace, but only the owner can toggle
              it per agent.
            </p>
          )}
        </div>

        {/* Toggle */}
        <Switch
          checked={yoloEnabled}
          onChange={() => handleToggle(!yoloEnabled)}
          disabled={saving || !canToggle}
          // Dormant (rule exists but workspace Yolo is off): show it in the ON
          // position but neutral grey, not active red — it's inert at runtime.
          trackClassName={
            isDormant
              ? 'mt-0.5 border-ink-4/40 bg-ink-4/20'
              : yoloEnabled
                ? 'mt-0.5 border-err/40 bg-err/20'
                : 'mt-0.5 border-rule-2 bg-canvas'
          }
          thumbClassName={[
            yoloEnabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
            isDormant ? 'bg-ink-4' : yoloEnabled ? 'bg-err' : 'bg-ink-3',
          ].join(' ')}
        />
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

// ─── Coding CLI (code_task) section ───────────────────────────────────────────
//
// Visible only when the agent has the `code-task` skill assigned. Mirrors
// CommandExecutionSection's Yolo toggle (same gate, same dormant-rule copy)
// plus the daily USD budget with today's spend. Model/effort defaults and the
// per-provider health check are CAPABILITY CONFIGURATION, not an autonomy
// setting — Quentin's correction moved those to the code-task tool group's
// panel on the Tools tab (ToolsTabContent.tsx, CodeTaskConfigPanel).

const CODE_TASK_SKILL_SLUG = 'code-task';
const CODE_TASK_TOOL = 'code_task';

function CodeTaskSection({
  agentId,
  attachedSkills,
  rules,
  onRulesChange,
  lanCommandYolo,
  isOwner,
  cliDailyBudgetUsd,
}: {
  agentId: string;
  attachedSkills: SkillRow[];
  rules: ApprovalRuleUiRow[];
  onRulesChange: (rules: ApprovalRuleUiRow[]) => void;
  /** Whether the workspace owner has opted into Yolo in non-local-trust mode. */
  lanCommandYolo: boolean;
  /** Whether the current user is the workspace owner. */
  isOwner: boolean;
  /** agents.cli_daily_budget_usd — 0 means no cap. */
  cliDailyBudgetUsd: number;
}) {
  const hasSkill = attachedSkills.some((s) => s.slug === CODE_TASK_SKILL_SLUG);

  // Read auth mode client-side — mirrors CommandExecutionSection.
  const isLocalTrust = (process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'local-trust') === 'local-trust';
  const yoloAllowed = isLocalTrust || (lanCommandYolo && isOwner);

  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const yoloEnabled = rules.some(
    (r) => r.toolName === CODE_TASK_TOOL && r.action === 'auto_approve',
  );
  const canManage = isLocalTrust || isOwner;
  const canToggle = yoloAllowed || (yoloEnabled && canManage);
  const isDormant = yoloEnabled && !yoloAllowed;

  function applyOptimistic(enabled: boolean) {
    onRulesChange(
      enabled
        ? [
            ...rules.filter((r) => r.toolName !== CODE_TASK_TOOL),
            { id: '', toolName: CODE_TASK_TOOL, action: 'auto_approve' as const },
          ]
        : rules.filter((r) => r.toolName !== CODE_TASK_TOOL),
    );
  }

  function handleToggle(next: boolean) {
    if (next) {
      setConfirmOpen(true);
    } else {
      void doSet(false);
    }
  }

  async function doSet(enabled: boolean) {
    setSaving(true);
    applyOptimistic(enabled);
    const result = await setCodeTaskYoloAction({ agentId, enabled });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.message);
      applyOptimistic(!enabled);
    } else {
      toast.success(
        enabled
          ? 'Yolo mode enabled. Coding tasks run without approval.'
          : 'Yolo mode disabled. Coding tasks require approval again.',
      );
    }
  }

  // ── Daily budget + today's spend ───────────────────────────────────────────
  const [budgetInput, setBudgetInput] = useState<string>(String(cliDailyBudgetUsd));
  const [savingBudget, setSavingBudget] = useState(false);
  const [spentUsd, setSpentUsd] = useState<number | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSkill) return;
    getCliUsageTodayAction(agentId).then((result) => {
      if (result.ok) setSpentUsd(result.data.spentUsd);
      else setUsageError(result.message);
    });
  }, [agentId, hasSkill]);

  async function handleSaveBudget() {
    const parsed = Number(budgetInput);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000) {
      toast.error('Enter a number between 0 and 1000');
      return;
    }
    setSavingBudget(true);
    const result = await setCliDailyBudgetAction({ agentId, budgetUsd: parsed });
    setSavingBudget(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success('Daily budget saved');
  }

  if (!hasSkill) {
    return null;
  }

  return (
    <SectionCard>
      <SectionHead
        label="Coding CLI"
        hint="Runs delegate work to the coding CLI installed on this machine, under your subscription. Treat it the same as Command execution."
      />

      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-medium-14 text-ink">
              Auto-run coding tasks without approval (Yolo)
            </span>
            <MonoMicroTag tone="err">irreversible</MonoMicroTag>
          </div>
          <p className="mt-1 text-body-13 leading-[1.4]! text-ink-3">
            When on, this agent runs coding CLI tasks immediately with no approval gate. Runs are
            still logged and count against the daily budget below. Only enable for agents you fully
            trust.
          </p>
          {isDormant && canManage && (
            <p className="mt-2 text-body-12 text-warn">
              This agent&apos;s Yolo is <b className="font-semibold">dormant</b>. Workspace Yolo is
              off, so its coding tasks still require approval. Turn it off here to clear it, or
              re-enable Yolo in{' '}
              <Link
                href="/settings"
                className="underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
              >
                Settings → Command execution
              </Link>
              .
            </p>
          )}
          {!yoloAllowed && !isDormant && !isLocalTrust && !lanCommandYolo && (
            <p className="mt-2 text-body-12 text-ink-4">
              Yolo is off for this workspace. The owner can enable it in{' '}
              <Link
                href="/settings"
                className="underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
              >
                Settings → Command execution
              </Link>
              , or switch to loopback mode.
            </p>
          )}
          {!yoloAllowed && lanCommandYolo && !isOwner && (
            <p className="mt-2 text-body-12 text-ink-4">
              The workspace owner has enabled Yolo for this workspace, but only the owner can toggle
              it per agent.
            </p>
          )}
        </div>

        <Switch
          checked={yoloEnabled}
          onChange={() => handleToggle(!yoloEnabled)}
          disabled={saving || !canToggle}
          trackClassName={
            isDormant
              ? 'mt-0.5 border-ink-4/40 bg-ink-4/20'
              : yoloEnabled
                ? 'mt-0.5 border-err/40 bg-err/20'
                : 'mt-0.5 border-rule-2 bg-canvas'
          }
          thumbClassName={[
            yoloEnabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
            isDormant ? 'bg-ink-4' : yoloEnabled ? 'bg-err' : 'bg-ink-3',
          ].join(' ')}
        />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Enable Yolo mode?"
        message="Yolo mode lets this agent run coding CLI tasks on this machine with no approval, using your subscription. Only enable for an agent you fully trust. Runs are still logged."
        confirmLabel="Enable Yolo"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          void doSet(true);
        }}
        onCancel={() => setConfirmOpen(false)}
      />

      <p className="mt-4 text-body-12 text-ink-4">
        Model, effort and diagnostics live in the Tools tab.
      </p>

      <div className="mt-6">
        <div className="text-mono-11 uppercase tracking-[0.12em] text-ink-4">
          Daily budget (USD)
        </div>
        <p className="mt-1 text-body-12 text-ink-4">0 means no cap.</p>
        <div className="mt-2 flex items-center gap-2">
          <TextInput
            type="number"
            min={0}
            max={1000}
            step={0.5}
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            className="w-28 font-mono"
          />
          <PrimaryButton
            variant="neutral"
            type="button"
            onClick={() => void handleSaveBudget()}
            disabled={savingBudget}
          >
            {savingBudget ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
        <p className="mt-2 text-body-13 text-ink-3">
          {spentUsd !== null
            ? `Spent today: $${spentUsd.toFixed(2)}`
            : (usageError ?? 'Loading spend…')}
        </p>
      </div>
    </SectionCard>
  );
}

// ─── Read-only agent (reviewer preset) ────────────────────────────────────────
//
// Visible for EVERY agent — no skill gate, unlike CommandExecutionSection /
// CodeTaskSection above. Read-only is a posture any agent can adopt, not a
// capability that needs unlocking first. Blocking these 5 tools is exactly
// what code_task's own read-only detection already keys off of
// (assertNotReadOnlyAgent, packages/tools/src/builtin/code-task/db.ts, checks
// file_write specifically) — this section is the UI affordance for that.

const READONLY_PRESET_TOOLS = [
  'file_write',
  'file_edit',
  'skill_file_write',
  'run_command',
  'run_skill_script',
] as const;

function ReadOnlyAgentSection({
  agentId,
  rules,
  onRulesChange,
  isOwner,
}: {
  agentId: string;
  rules: ApprovalRuleUiRow[];
  onRulesChange: (rules: ApprovalRuleUiRow[]) => void;
  /** Whether the current user is the workspace owner. */
  isOwner: boolean;
}) {
  const isLocalTrust = (process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'local-trust') === 'local-trust';
  const canToggle = isLocalTrust || isOwner;

  const blockedCount = READONLY_PRESET_TOOLS.filter((toolName) =>
    rules.some((r) => r.toolName === toolName && r.action === 'block'),
  ).length;
  const allBlocked = blockedCount === READONLY_PRESET_TOOLS.length;
  // Some, but not all, of the 5 tools are already blocked (set individually
  // in the tool list above) — the toggle shows OFF (it didn't create this
  // state) with a note explaining why, rather than a misleading partial ON.
  const partiallyBlocked = blockedCount > 0 && !allBlocked;
  const enabled = allBlocked;

  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function applyOptimistic(next: boolean) {
    const presetTools: readonly string[] = READONLY_PRESET_TOOLS;
    onRulesChange(
      next
        ? [
            ...rules.filter((r) => !presetTools.includes(r.toolName)),
            ...READONLY_PRESET_TOOLS.map((toolName) => ({
              id: '',
              toolName,
              action: 'block' as const,
            })),
          ]
        : rules.filter((r) => !(presetTools.includes(r.toolName) && r.action === 'block')),
    );
  }

  function handleToggle(next: boolean) {
    if (next) {
      setConfirmOpen(true);
    } else {
      void doSet(false);
    }
  }

  async function doSet(next: boolean) {
    setSaving(true);
    applyOptimistic(next);
    const result = await setReviewerReadOnlyPresetAction({ agentId, enabled: next });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.message);
      applyOptimistic(!next);
    } else {
      toast.success(
        next
          ? 'Read-only agent enabled. Write tools are blocked.'
          : 'Read-only agent disabled. Write tools are unblocked.',
      );
    }
  }

  return (
    <SectionCard>
      <SectionHead
        label="Read-only agent"
        hint="Blocks all write tools for this agent. Meant for reviewer agents."
      />

      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <span className="text-medium-14 text-ink">Block write tools</span>
          <p className="mt-1 text-body-13 leading-[1.4]! text-ink-3">
            Blocks file writes, shell commands, and skill scripts for this agent. Reversible any
            time.
          </p>
          {partiallyBlocked && (
            <p className="mt-2 text-body-12 text-ink-4">
              Some write tools are already blocked individually.
            </p>
          )}
        </div>

        <Switch
          checked={enabled}
          onChange={() => handleToggle(!enabled)}
          disabled={saving || !canToggle}
          trackClassName={
            enabled ? 'mt-0.5 border-ok/40 bg-ok/20' : 'mt-0.5 border-rule-2 bg-canvas'
          }
          thumbClassName={enabled ? 'translate-x-[18px] bg-ok' : 'translate-x-[2px] bg-ink-3'}
        />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Make this agent read-only?"
        message="This blocks file writes, shell commands, and skill scripts for this agent. Meant for reviewer agents that should never modify anything."
        confirmLabel="Make read-only"
        destructive={false}
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
      <p className="mt-4 text-body-12 text-ink-4">
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
          <span className="text-medium-14 text-ink">{skill.name}</span>
          <MonoMicroTag tone="skill">community</MonoMicroTag>
          <MonoMicroTag tone="warn">
            {scripts.length} script{scripts.length > 1 ? 's' : ''}
          </MonoMicroTag>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {scripts.map((s) => (
            <code key={s.path} className="text-mono-11 text-ink-4">
              {s.path}
            </code>
          ))}
        </div>
        {!canToggle && (
          <p className="mt-1.5 text-body-12 text-ink-4">
            Only the workspace owner can authorize scripts.
          </p>
        )}
      </div>

      {/* Toggle */}
      <Switch
        checked={authorized}
        onChange={handleToggle}
        disabled={saving || !canToggle}
        ariaLabel={`Allow scripts for ${skill.name}`}
        trackClassName={
          authorized ? 'mt-0.5 border-warn/40 bg-warn/20' : 'mt-0.5 border-rule-2 bg-canvas'
        }
        thumbClassName={authorized ? 'translate-x-[18px] bg-warn' : 'translate-x-[2px] bg-ink-3'}
      />

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
      <p className="mt-4 text-body-12 text-ink-4">
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
          <span className="text-medium-14 text-ink">{skill.name}</span>
          <MonoMicroTag tone="skill">community</MonoMicroTag>
        </div>
        {!canToggle && (
          <p className="mt-1.5 text-body-12 text-ink-4">
            Only the workspace owner can authorize file writes.
          </p>
        )}
      </div>

      <Switch
        checked={writable}
        onChange={handleToggle}
        disabled={saving || !canToggle}
        ariaLabel={`Allow file writes for ${skill.name}`}
        trackClassName={
          writable ? 'mt-0.5 border-warn/40 bg-warn/20' : 'mt-0.5 border-rule-2 bg-canvas'
        }
        thumbClassName={writable ? 'translate-x-[18px] bg-warn' : 'translate-x-[2px] bg-ink-3'}
      />

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
          <span className="text-medium-14 text-ink">{op.name}</span>
          <span
            className={[
              'inline-flex h-[18px] items-center rounded-full px-2 text-mono-11 uppercase tracking-[0.1em]',
              op.risk === 'destructive' ? 'bg-err/10 text-err' : 'bg-warn/10 text-warn',
            ].join(' ')}
          >
            {riskLabel[op.risk] ?? op.risk}
          </span>
        </div>
        {op.description && (
          <p className="mt-0.5 text-body-13 leading-[1.4]! text-ink-3">{op.description}</p>
        )}
        <code className="mt-1 block text-mono-11 text-ink-4">{op.slug}</code>
      </div>

      {/* 3-way control */}
      <SegmentedControl
        value={value}
        onChange={onChange}
        disabled={saving}
        ariaLabel={`Approval policy for ${op.name}`}
        options={[
          {
            value: 'auto_approve' as const,
            label: 'Autonomous',
            activeClassName: 'bg-agent-vivid/15 text-agent-vivid border-agent-vivid/30',
            testId: `autonomy-btn-${op.slug}-auto_approve`,
          },
          {
            value: 'require_approval' as const,
            label: 'Ask first',
            activeClassName: 'bg-warn/15 text-warn border-warn/30',
            testId: `autonomy-btn-${op.slug}-require_approval`,
          },
          {
            value: 'block' as const,
            label: 'Block',
            activeClassName: 'bg-err/15 text-err border-err/30',
            testId: `autonomy-btn-${op.slug}-block`,
          },
        ]}
      />
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
  subAgentInstructions: Record<string, string>;
  peers: AgentRow[];
  llmKeyId: string;
  fallbackChain: Array<{ keyId: string; model: string; reasoningEffort?: string }>;
  activeKeys: LlmKeyUiRow[];
  selectedKey: LlmKeyUiRow | null;
  model: string;
  reasoningEffort: string;
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
  onChangeSubAgentInstruction: (id: string, text: string) => void;
  onToggleFallback: (id: string) => void;
  onChangeFallbackModel: (id: string, model: string) => void;
  onChangeFallbackEffort: (id: string, effort: string) => void;
  onChangeLlmKey: (id: string) => void;
  onChangeModel: (v: string) => void;
  onChangeReasoningEffort: (v: string) => void;
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
    subAgentInstructions,
    peers,
    llmKeyId,
    fallbackChain,
    activeKeys,
    selectedKey,
    model,
    reasoningEffort,
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
    onChangeSubAgentInstruction,
    onToggleFallback,
    onChangeFallbackModel,
    onChangeFallbackEffort,
    onChangeLlmKey,
    onChangeModel,
    onChangeReasoningEffort,
    onSave,
    onReset,
    liveModelsCache,
    liveModelsLoading,
  } = props;

  // Candidate fallback keys = every active key except the current primary.
  const otherKeys = activeKeys.filter((k) => k.id !== llmKeyId);

  // Reasoning levels the selected primary model really offers ([] = hide field).
  const reasoningOptions = reasoningOptionValues(selectedKey?.provider ?? '', model);

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

  // Router/planner delegate via tool calls — a model that can't call tools
  // can't function as an orchestrator. Gates the primary model AND every
  // fallback in the failover chain (all run on the same agent).
  const requireTools = role !== 'worker';

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
            <TextInput
              type="text"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="Agent name"
              className="!rounded-lg !bg-canvas !px-3 !py-2 !text-body-14"
            />
          </Field>
          <Field label="Slug (read-only)">
            <code className="block w-full rounded-lg border border-rule-2 bg-hover px-3 py-2 text-mono-12 tracking-[0.02em] text-ink-3">
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
          <TextArea
            value={personality}
            onChange={(e) => onChangePersonality(e.target.value)}
            rows={24}
            placeholder="You are a helpful assistant…"
            className="min-h-[560px] !rounded-lg !bg-canvas !px-3 !py-2 !text-mono-13 leading-[1.55]!"
          />
        </Field>
        <div className="mt-4">
          <Field label="Role">
            <Select
              value={role}
              onChange={(e) => onChangeRole(e.target.value as AgentRole)}
              className="!rounded-lg !bg-canvas !px-3 !py-2 !text-body-14"
            >
              <option value="worker">Worker (runs its own tools)</option>
              <option value="router">Router (delegates one at a time)</option>
              <option value="planner">Planner (parallel sub-agents)</option>
            </Select>
          </Field>
        </div>
        {showSubAgents && (
          <div className="mt-4">
            <Field label={`Sub-agents · ${subAgentIds.length} selected`}>
              {peers.length === 0 ? (
                <p className="text-body-13 text-warn">
                  Create at least one worker agent first — orchestrators need someone to delegate
                  to.
                </p>
              ) : (
                <div className="divide-y divide-rule-2 overflow-hidden rounded-lg border border-rule-2 bg-canvas/30">
                  {peers.map((a) => {
                    const checked = subAgentIds.includes(a.id);
                    return (
                      <div key={a.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-body-14 transition-colors hover:bg-hover">
                          <Checkbox
                            tone="agent"
                            checked={checked}
                            onChange={() => onToggleSubAgent(a.id)}
                          />
                          <span className="text-ink">{a.name}</span>
                          <span className="ml-auto text-mono-12 text-ink-3">{a.slug}</span>
                        </label>
                        {checked && (
                          <div className="px-3 pb-2 pl-[2.6rem]">
                            <TextInput
                              type="text"
                              value={subAgentInstructions[a.id] ?? ''}
                              onChange={(e) => onChangeSubAgentInstruction(a.id, e.target.value)}
                              placeholder="Routing rule for this teammate, e.g. NSFW requests go here first"
                              maxLength={500}
                              className="w-full !rounded-lg !bg-canvas !px-3 !py-1.5 !text-body-13"
                            />
                          </div>
                        )}
                      </div>
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
              <p className="text-body-13 text-warn">
                No active LLM keys.{' '}
                <Link href="/llm-providers" className="underline">
                  Add one
                </Link>
                .
              </p>
            ) : (
              <Select
                value={llmKeyId}
                onChange={(e) => onChangeLlmKey(e.target.value)}
                className="!rounded-lg !bg-canvas !px-3 !py-2 !text-body-14"
              >
                {activeKeys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {(k.nickname ?? prettyProviderName(k.provider)) +
                      ' (' +
                      prettyProviderName(k.provider) +
                      ')'}
                  </option>
                ))}
              </Select>
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
              <Select
                value={modelInDropdown ? model : '__custom__'}
                onChange={(e) =>
                  onChangeModel(e.target.value === '__custom__' ? '' : e.target.value)
                }
                className="mb-2 !rounded-lg !bg-canvas !px-3 !py-2 !text-body-14"
              >
                {groupModelCatalog(modelCatalog).map(({ group, models }) =>
                  group ? (
                    <optgroup key={group} label={group}>
                      {models.map((m) => (
                        <option
                          key={m.modelId}
                          value={m.modelId}
                          disabled={requireTools && !m.capabilities.tools}
                          title={
                            requireTools && !m.capabilities.tools
                              ? "Can't use tools (required for a router/planner)"
                              : undefined
                          }
                        >
                          {modelOptionLabel(m)}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    models.map((m) => (
                      <option
                        key={m.modelId}
                        value={m.modelId}
                        disabled={requireTools && !m.capabilities.tools}
                        title={
                          requireTools && !m.capabilities.tools
                            ? "Can't use tools (required for a router/planner)"
                            : undefined
                        }
                      >
                        {modelOptionLabel(m)}
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
              </Select>
            )}
            {!modelInDropdown && (
              <TextInput
                type="text"
                value={model}
                onChange={(e) => onChangeModel(e.target.value)}
                placeholder={
                  MODEL_CATALOG[selectedKey?.provider ?? '']?.[0]?.modelId ??
                  'e.g. claude-haiku-4-5-20251001'
                }
                className="!rounded-lg !bg-canvas !px-3 !py-2 !text-mono-13"
              />
            )}
            {(modelCatalog.length > 0 || extraLiveIds.length > 0) && (
              <ModelToolsLegend className="mt-1.5" />
            )}
          </Field>
          {reasoningOptions.length > 0 && (
            <Field label="Reasoning">
              <Select
                value={reasoningOptions.includes(reasoningEffort) ? reasoningEffort : ''}
                onChange={(e) => onChangeReasoningEffort(e.target.value)}
                className="!rounded-lg !bg-canvas !px-3 !py-2 !text-body-14"
              >
                <option value="">Auto</option>
                {reasoningOptions.map((v) => (
                  <option key={v} value={v}>
                    {REASONING_LABELS[v] ?? v}
                  </option>
                ))}
              </Select>
              <p className="mt-1.5 text-body-13 text-ink-4">
                How hard this model thinks before answering. Auto keeps the provider default.
              </p>
            </Field>
          )}
        </div>
        {!noLlmKeys && (
          <div className="mt-3">
            <Field label="Fallback providers (failover order)">
              {otherKeys.length === 0 ? (
                <p className="text-body-13 text-ink-4">
                  Add another LLM key in{' '}
                  <Link href="/llm-providers" className="underline">
                    LLM providers
                  </Link>{' '}
                  to enable failover.
                </p>
              ) : (
                <div className="space-y-2.5">
                  <p className="text-body-13 text-ink-4">
                    If the primary is down (5xx / timeout / quota) mid-job, the runner fails over to
                    these in order. Pick the model each fallback should run on.
                  </p>
                  {otherKeys.map((k) => {
                    const order = fallbackChain.findIndex((l) => l.keyId === k.id);
                    const checked = order !== -1;
                    const fbCatalog = MODEL_CATALOG[k.provider] ?? [];
                    const fbModel = checked ? (fallbackChain[order]?.model ?? '') : '';
                    const fbEffort = checked ? (fallbackChain[order]?.reasoningEffort ?? '') : '';
                    const fbReasoningOptions = checked
                      ? reasoningOptionValues(k.provider, fbModel)
                      : [];
                    return (
                      <div key={k.id} className="space-y-1.5">
                        <label className="flex cursor-pointer items-center gap-2.5 select-none">
                          <Checkbox
                            tone="ink"
                            checked={checked}
                            onChange={() => onToggleFallback(k.id)}
                          />
                          <span className="text-body-14 text-ink-2">
                            {(k.nickname ?? prettyProviderName(k.provider)) +
                              ' (' +
                              prettyProviderName(k.provider) +
                              ')'}
                          </span>
                          {checked && (
                            <span className="ml-auto rounded-full border border-rule-2 px-2 py-0.5 text-micro-11 text-ink-4">
                              #{order + 1}
                            </span>
                          )}
                        </label>
                        {checked &&
                          (fbCatalog.length > 0 ? (
                            <Select
                              value={fbModel}
                              onChange={(e) => onChangeFallbackModel(k.id, e.target.value)}
                              className="ml-[1.6rem] w-[calc(100%-1.6rem)] !rounded-lg !bg-canvas !px-3 !py-1.5 !text-body-13"
                            >
                              {groupModelCatalog(fbCatalog).map(({ group, models }) =>
                                group ? (
                                  <optgroup key={group} label={group}>
                                    {models.map((m) => (
                                      <option
                                        key={m.modelId}
                                        value={m.modelId}
                                        disabled={requireTools && !m.capabilities.tools}
                                        title={
                                          requireTools && !m.capabilities.tools
                                            ? "Can't use tools (required for a router/planner)"
                                            : undefined
                                        }
                                      >
                                        {modelOptionLabel(m)}
                                      </option>
                                    ))}
                                  </optgroup>
                                ) : (
                                  models.map((m) => (
                                    <option
                                      key={m.modelId}
                                      value={m.modelId}
                                      disabled={requireTools && !m.capabilities.tools}
                                      title={
                                        requireTools && !m.capabilities.tools
                                          ? "Can't use tools (required for a router/planner)"
                                          : undefined
                                      }
                                    >
                                      {modelOptionLabel(m)}
                                    </option>
                                  ))
                                ),
                              )}
                            </Select>
                          ) : (
                            <TextInput
                              type="text"
                              value={fbModel}
                              onChange={(e) => onChangeFallbackModel(k.id, e.target.value)}
                              placeholder="model id (e.g. llama-3.3-70b)"
                              className="ml-[1.6rem] w-[calc(100%-1.6rem)] !rounded-lg !bg-canvas !px-3 !py-1.5 !text-mono-13"
                            />
                          ))}
                        {checked && fbReasoningOptions.length > 0 && (
                          <Select
                            value={fbReasoningOptions.includes(fbEffort) ? fbEffort : ''}
                            onChange={(e) => onChangeFallbackEffort(k.id, e.target.value)}
                            className="ml-[1.6rem] w-[calc(100%-1.6rem)] !rounded-lg !bg-canvas !px-3 !py-1.5 !text-body-13"
                          >
                            <option value="">Reasoning: inherit agent setting</option>
                            {fbReasoningOptions.map((v) => (
                              <option key={v} value={v}>
                                {'Reasoning: ' + (REASONING_LABELS[v] ?? v)}
                              </option>
                            ))}
                          </Select>
                        )}
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
          <p className="text-body-13 text-ink-4">Loading…</p>
        ) : workspaces.length === 0 ? (
          <p className="text-body-13 text-ink-4">No folders configured.</p>
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
                    <span className="font-mono text-legacy-12 font-semibold text-ink-2 mr-2">
                      {ws.label}
                    </span>
                    <span className="text-mono-12 text-ink-3 break-all">{ws.path}</span>
                  </div>
                  <RowActionButton
                    tone="danger"
                    onClick={() => setWsRemoveId(ws.id)}
                    disabled={wsIsPending}
                    className="!h-auto shrink-0 !rounded !border-rule !px-2 !py-0.5 !text-body-12 hover:!border-err/40 hover:!bg-err/5"
                  >
                    Remove
                  </RowActionButton>
                </div>

                {/* File list */}
                <div className="px-3 pt-2 pb-1">
                  {!wsFilesLoaded[ws.label] ? (
                    <p className="text-body-12 text-ink-4 py-1">Loading files…</p>
                  ) : (wsFiles[ws.label] ?? []).length === 0 ? (
                    <p className="text-body-12 text-ink-4 py-1">No files uploaded yet.</p>
                  ) : (
                    <div className="space-y-1 mb-2">
                      {(wsFiles[ws.label] ?? []).map((f) => (
                        <div
                          key={f.name}
                          className="flex items-center justify-between gap-2 rounded px-2 py-1 bg-canvas border border-rule-2 text-body-12"
                        >
                          <span className="font-mono text-ink-2 truncate min-w-0">{f.name}</span>
                          <span className="shrink-0 text-ink-4">
                            {f.size >= 1024 * 1024
                              ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                              : f.size >= 1024
                                ? `${(f.size / 1024).toFixed(0)} KB`
                                : `${f.size} B`}
                          </span>
                          <RowActionButton
                            tone="danger"
                            onClick={() => handleDeleteFile(ws.label, f.name)}
                            disabled={wsFilesPending}
                            className="!h-auto shrink-0 !rounded !border-rule !px-1.5 !py-0.5 !text-legacy-11 hover:!border-err/40 hover:!bg-err/5"
                          >
                            Delete
                          </RowActionButton>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Upload button + drag-drop */}
                  <label
                    className={`flex items-center gap-2 cursor-pointer rounded-lg border border-dashed px-3 py-2 text-body-13 transition-colors mb-2
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
                    <TextInput
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
              <TextInput
                type="text"
                value={wsLabel}
                onChange={(e) => setWsLabel(e.target.value)}
                placeholder="Label (e.g. notes)"
                maxLength={80}
                className="w-28 shrink-0 !rounded-lg !bg-canvas !px-3 !py-2 !text-mono-13"
              />
              <TextInput
                type="text"
                value={wsPath}
                onChange={(e) => setWsPath(e.target.value)}
                placeholder="/home/you/notes  or  C:\Users\you\docs"
                className="min-w-0 flex-1 !rounded-lg !bg-canvas !px-3 !py-2 !text-mono-13"
              />
              <PrimaryButton
                variant="neutral"
                onClick={handleAddWorkspace}
                disabled={wsIsPending || wsAdding || !wsLabel.trim() || !wsPath.trim()}
                className="!h-auto shrink-0 !rounded-lg !px-4 !py-2 !text-body-14"
              >
                {wsAdding ? 'Adding…' : 'Add'}
              </PrimaryButton>
            </div>
          </Field>
          <p className="text-body-12 text-ink-4">
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

      {/* Danger zone — the only place an agent can be deleted from now (moved
          off the /agents list, which is browse/organize only). */}
      <AgentDangerZone agentId={agentId} name={name} deleteAction={deleteAgentAction} />

      {/* Sticky save bar */}
      <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-2xl border border-rule-2 bg-paper px-4 py-3 shadow-lg">
        <div className="text-body-13 text-ink-3">
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
          <PrimaryButton
            variant="neutral"
            onClick={onReset}
            disabled={isPending || !dirty}
            className="!h-auto !rounded-lg !border-rule !px-4 !py-2 !text-body-14 !text-ink-3 hover:!text-ink-2"
          >
            Reset
          </PrimaryButton>
          <PrimaryButton
            variant="ink"
            onClick={onSave}
            disabled={isPending || noLlmKeys || !dirty}
            title={!dirty ? 'No changes to save' : undefined}
            className="!h-auto !rounded-lg !px-5 !py-2 !text-body-14"
          >
            {isPending ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-mono-11 uppercase tracking-[0.1em] text-ink-4">{label}</label>
      <div>{children}</div>
    </div>
  );
}
