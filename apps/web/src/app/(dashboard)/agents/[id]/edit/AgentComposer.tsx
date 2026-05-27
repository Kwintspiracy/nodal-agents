'use client';

import { useState } from 'react';
import Link from 'next/link';
import type {
  AgentRow,
  AgentEditRow,
  LlmKeyUiRow,
  AgentConnectorRow,
  AgentMcpServerRow,
} from '@/lib/actions.ts';
import AgentForm from '@/components/AgentForm.tsx';
import AgentConnectorGrid from '@/components/AgentConnectorGrid.tsx';
import AgentMcpServerGrid from '@/components/AgentMcpServerGrid.tsx';

/**
 * AgentComposer — three-column editor for /agents/[id]/edit, faithful to
 * the design handoff `screen-composer-v2.jsx`.
 *
 *   ┌──────────────── toolbar (crumbs · PN · Test / Schedule / Run) ──────────────────┐
 *   ┌────────────────────────────── hero (orb + name + status pill + meta) ──────────┐
 *   ┌────────────────────────── agent picker (row of buttons) ───────────────────────┐
 *   ┌────────────┬──────────────────────────────────────────────────────┬────────────┐
 *   │ CONFIG     │ Tabs: Skills · Connectors · Behavior · Knowledge · Runs │ LIVE      │
 *   │ (read-only │                                                       │ · last    │
 *   │  meta)     │ [active tab content]                                  │   hour    │
 *   │            │                                                       │           │
 *   └────────────┴──────────────────────────────────────────────────────┴────────────┘
 *
 * Phase 1 scope (per the user's "structure visuelle uniquement" instruction):
 *  - Shell 3-col + hero + agent picker + tab strip + live panel are present
 *    with the handoff geometry.
 *  - Behavior tab embeds the existing `AgentForm` to preserve every editing
 *    capability (persona / role / LLM key / model / sub-agents / workspace
 *    root / connectors / MCP). Subsequent phases will lift those fields up
 *    into the individual Skills / Connectors / Knowledge tabs to fully
 *    eliminate the embedded legacy form.
 *  - Toolbar buttons (Test / Schedule / Run) and the right "Live" panel are
 *    visual stubs as agreed.
 *
 * `AgentForm` itself still imports the extracted `AgentConnectorGrid` and
 * `AgentMcpServerGrid` — those are the same component instances we surface
 * standalone in the Connectors / Knowledge tabs here.
 */

type Tab = 'skills' | 'connectors' | 'behavior' | 'knowledge' | 'runs';

interface Props {
  agent: AgentEditRow;
  peers: AgentRow[];
  llmKeys: LlmKeyUiRow[];
  connectors: AgentConnectorRow[];
  mcpServers: AgentMcpServerRow[];
}

export default function AgentComposer({ agent, peers, llmKeys, connectors, mcpServers }: Props) {
  const [tab, setTab] = useState<Tab>('behavior');

  const initial = (agent.name || agent.slug).slice(0, 1).toUpperCase();
  const partNumber = `agt-${agent.slug.slice(0, 6)}`.toUpperCase();
  const llmKey = llmKeys.find((k) => k.id === agent.llmKeyId) ?? null;
  const personaPreview = (agent.personality ?? '').split('\n').filter(Boolean)[0] ?? '—';
  const assignedConnectors = connectors.filter((c) => c.assigned).length;
  const assignedMcps = mcpServers.filter((s) => s.assigned).length;

  return (
    <div className="-mx-6 -my-6 flex flex-col lg:-mx-8">
      <Toolbar agentName={agent.name} pn={partNumber} />

      <div className="px-6 pb-10 pt-2 lg:px-8">
        <Hero
          initial={initial}
          name={agent.name}
          slug={agent.slug}
          role={agent.role ?? 'worker'}
          pn={partNumber}
          model={agent.model}
        />

        <AgentPicker
          agents={[{ id: agent.id, name: agent.name, slug: agent.slug } as AgentRow, ...peers]}
          activeId={agent.id}
        />

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
          <ConfigSidebar
            personaPreview={personaPreview}
            model={agent.model ?? '—'}
            llmKeyLabel={llmKey?.nickname ?? llmKey?.provider ?? '—'}
            role={agent.role ?? 'worker'}
            slug={agent.slug}
            pn={partNumber}
            subAgentCount={agent.subAgentIds.length}
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

            {tab === 'skills' && <SkillsTabStub slug={agent.slug} />}
            {tab === 'connectors' && (
              <AgentConnectorGrid agentId={agent.id} connectors={connectors} />
            )}
            {tab === 'behavior' && (
              <div className="rounded-xl border border-rule-2 bg-paper p-6">
                <AgentForm
                  mode="edit"
                  initial={agent}
                  llmKeys={llmKeys}
                  agents={peers}
                  connectors={connectors}
                  mcpServers={mcpServers}
                />
              </div>
            )}
            {tab === 'knowledge' && (
              <KnowledgeTab
                agentId={agent.id}
                mcpServers={mcpServers}
                workspaceRootPath={agent.workspaceRootPath ?? null}
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
  name,
  slug,
  role,
  pn,
  model,
}: {
  initial: string;
  name: string;
  slug: string;
  role: string;
  pn: string;
  model: string | null;
}) {
  return (
    <div className="mb-6 flex items-end gap-[22px]">
      <div className="relative flex h-[96px] w-[96px] flex-shrink-0 items-center justify-center rounded-full bg-agent-vivid text-[28px] font-semibold text-white shadow-[0_6px_18px_rgba(28,35,48,0.18)]">
        {/* Concentric design rings — purely decorative, mirrors handoff `.miniorb` */}
        <span className="pointer-events-none absolute -inset-[14px] rounded-full border border-rule" />
        <span className="pointer-events-none absolute -inset-[26px] rounded-full border border-dashed border-rule" />
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-[32px] font-semibold leading-[1.05] tracking-[-0.02em] text-ink">
          {name}
          <span className="ml-2 font-normal text-ink-3">, {role.toLowerCase()}</span>
        </h1>
        <div className="mt-1.5 font-mono text-[11px] tracking-[0.04em] text-ink-3">
          <b className="font-medium text-ink-2">{pn}</b>
          <Sep />
          {model ?? 'no model'}
          <Sep />
          memory · —
          <Sep />@{slug}
        </div>
      </div>
      <StatusPill running={false} />
    </div>
  );
}

function Sep() {
  return <span className="px-2 text-ink-4">·</span>;
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

// ─── Config sidebar (left) ────────────────────────────────────────────────────

function ConfigSidebar({
  personaPreview,
  model,
  llmKeyLabel,
  role,
  slug,
  pn,
  subAgentCount,
}: {
  personaPreview: string;
  model: string;
  llmKeyLabel: string;
  role: string;
  slug: string;
  pn: string;
  subAgentCount: number;
}) {
  return (
    <aside className="rounded-xl border border-rule-2 bg-paper p-[18px] lg:sticky lg:top-4">
      <div className="mb-2.5 flex items-center justify-between font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
        <span>Configuration</span>
        <span>{pn}</span>
      </div>
      <div className="flex flex-col gap-3.5">
        <Field label="Persona">
          <p className="line-clamp-3 text-[12.5px] leading-[1.5] text-ink-2">{personaPreview}</p>
        </Field>
        <Field label="Model">
          <code className="font-mono text-[11.5px] tracking-[0.02em] text-ink">{model}</code>
        </Field>
        <Field label="LLM key">
          <span className="text-[13px] font-medium text-ink">{llmKeyLabel}</span>
        </Field>
        <Field label="Role">
          <span className="text-[13px] font-medium capitalize text-ink">{role}</span>
        </Field>
        {subAgentCount > 0 && (
          <Field label="Sub-agents">
            <span className="text-[13px] font-medium text-ink">{subAgentCount}</span>
          </Field>
        )}
        <Field label="Slug">
          <code className="font-mono text-[11.5px] tracking-[0.02em] text-ink-2">@{slug}</code>
        </Field>
      </div>
      <p className="mt-4 border-t border-rule-2 pt-3 text-[11px] leading-[1.5] text-ink-4">
        Edit these fields in the <b>Behavior</b> tab. This rail is read-only for now.
      </p>
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
    { id: 'skills', label: 'Skills', count: counts.skills },
    { id: 'connectors', label: 'Connectors', count: counts.connectors },
    { id: 'behavior', label: 'Behavior' },
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

// ─── Tab content stubs ────────────────────────────────────────────────────────

function SkillsTabStub({ slug }: { slug: string }) {
  return (
    <StubPanel
      title="Skills assigned to this agent"
      body={
        <>
          Per-agent skill assignment surfaces here. For now, manage the catalogue and assignments
          from the{' '}
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
          Run history filtered to this agent will live here. In the meantime, see{' '}
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

function KnowledgeTab({
  agentId,
  mcpServers,
  workspaceRootPath,
}: {
  agentId: string;
  mcpServers: AgentMcpServerRow[];
  workspaceRootPath: string | null;
}) {
  return (
    <div className="space-y-6">
      <section>
        <SectionHead label="MCP knowledge sources" />
        <AgentMcpServerGrid agentId={agentId} servers={mcpServers} />
      </section>

      <section>
        <SectionHead label="Workspace root" />
        <div className="rounded-lg border border-rule-2 bg-paper px-4 py-3">
          {workspaceRootPath ? (
            <code className="break-all font-mono text-[12px] text-ink-2">{workspaceRootPath}</code>
          ) : (
            <span className="text-[12.5px] text-ink-4">
              No workspace root configured. Set it in the <b>Behavior</b> tab to enable file_*
              tools.
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function SectionHead({ label }: { label: string }) {
  return (
    <div className="mb-3 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">
      {label}
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
        Visual stub — wire to runner telemetry in a later phase.
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
