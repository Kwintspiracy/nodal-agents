'use client';

/**
 * RootAgentSection — settings block for configuring the workspace ROOT agent.
 *
 * The ROOT is NOT chosen here. Under the "origin orchestrator" model (Brique F),
 * the first orchestrator created in the workspace is automatically the ROOT —
 * the single top-level orchestrator. This block shows which agent that is and
 * lets the user tune its powers: per-grant meta-tool toggles (create_agent /
 * create_skill / update_skill / attach_skill) and an autonomy level controlling
 * when those tools require approval. Auto-designated ROOTs start with all powers
 * OFF — enable them here.
 *
 * Wave 2b — V4 ROOT agent, 2026-05-29. Picker removed — Brique F, 2026-06-01.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { setRootAgentAction, type AgentRow } from '@/lib/actions.ts';
import { type RootGrants, type AutonomyLevel, DEFAULT_ROOT_GRANTS } from '@nodal-agents/shared';
import { SetBlock } from '@/components/ui/SetBlock.tsx';
import { SetForm } from '@/components/ui/SetForm.tsx';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import { OptionRadio } from '@/components/ui/OptionRadio.tsx';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  /** All agents in the entity — pre-filtered to orchestrators in the component. */
  agents: AgentRow[];
  /** Current ROOT agent id, or null if none is designated. */
  initialRootAgentId: string | null;
  /** Current grants — falls back to DEFAULT_ROOT_GRANTS when none saved. */
  initialGrants: RootGrants;
}

// ─── Autonomy options ──────────────────────────────────────────────────────────

const AUTONOMY_OPTIONS: { value: AutonomyLevel; name: string; description: string }[] = [
  {
    value: 'propose_confirm',
    name: 'Propose & confirm',
    description:
      'Everything waits for your approval: meta-tools (create agent, skill…) AND tool actions — shell commands, skill scripts, connector writes all pause in the Approvals queue before running.',
  },
  {
    value: 'destructive_gate',
    name: 'Autonomous, gate destructive',
    description:
      'Ordinary work runs automatically (normal commands, scripts, meta-tools — no prompts). But destructive or heavy actions still ask first: deletions, software installs / large downloads, killing processes, disk operations. The sweet spot — no friction for routine work, a checkpoint before anything risky.',
  },
  {
    value: 'fully_autonomous',
    name: 'Fully autonomous',
    description:
      'Nothing asks for approval — meta-tools AND every command, script and connector action run on their own. Only truly catastrophic shell commands (wiping the disk, etc.) still force a confirmation. Maximum power, no friction: an agent could e.g. install large software by itself, so use only if you fully trust it.',
  },
];

// ─── Component ─────────────────────────────────────────────────────────────────

export default function RootAgentSection({ agents, initialRootAgentId, initialGrants }: Props) {
  const router = useRouter();
  const [isSaving, startSaveTransition] = useTransition();

  // The ROOT is the entity's origin orchestrator, designated automatically.
  // This block only configures its powers.
  const rootAgent = agents.find((a) => a.id === initialRootAgentId) ?? null;

  const [grants, setGrants] = useState<RootGrants>(initialGrants ?? DEFAULT_ROOT_GRANTS);

  function toggleGrant(key: keyof Omit<RootGrants, 'autonomy'>) {
    setGrants((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function setAutonomy(level: AutonomyLevel) {
    setGrants((prev) => ({ ...prev, autonomy: level }));
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    startSaveTransition(async () => {
      const res = await setRootAgentAction({ grants });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success('ROOT agent configuration saved');
      router.refresh();
    });
  }

  function handleCancel() {
    setGrants(initialGrants ?? DEFAULT_ROOT_GRANTS);
  }

  return (
    <SetBlock
      label="ROOT agent"
      lede="Your first orchestrator is automatically this workspace's ROOT — the single top-level agent that can manage it (create skills/agents, assign skills) on your behalf. Tune its powers below."
    >
      {rootAgent === null ? (
        /* Empty state — no ROOT yet (no orchestrator has been created) */
        <div className="mt-3.5 rounded-xl border border-rule-2 bg-paper px-[18px] py-4">
          <p className="text-[14px] text-ink-3">
            No ROOT agent yet.{' '}
            <a
              href="/agents"
              className="font-medium text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
            >
              Create an orchestrator agent
            </a>{' '}
            — the first one you create becomes this workspace&apos;s ROOT automatically.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSave}>
          <SetForm>
            {/* ── ROOT agent (read-only — designated automatically) ─────────── */}
            <div className="mb-4">
              <div className="mb-1.5 text-[14px] leading-none text-ink-3">ROOT agent</div>
              <div className="flex items-center gap-2 rounded-lg border border-rule bg-paper px-3 py-2">
                <span className="text-[14px] font-medium text-ink">{rootAgent.name}</span>
                <span className="rounded-full border border-rule-2 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-4">
                  Origin orchestrator
                </span>
                <a
                  href="/settings/root-context"
                  className="ml-auto text-[13px] font-medium text-ink-3 underline decoration-rule underline-offset-[3px] hover:text-ink hover:decoration-ink-3"
                >
                  View &amp; edit context →
                </a>
              </div>
            </div>

            {/* ── Grant toggles + autonomy ─────────────────────────────────── */}
            <>
              {/* Grant toggles */}
              <div className="mb-4">
                <div className="mb-2 text-[14px] leading-none text-ink-3">Allowed actions</div>
                <div className="flex flex-col gap-1.5">
                  {(
                    [
                      { key: 'createAgent', label: 'Create agents' },
                      { key: 'updateAgent', label: 'Edit agents (model, personality, name)' },
                      { key: 'attachAgent', label: 'Attach / detach sub-agents' },
                      { key: 'createSkill', label: 'Create skills' },
                      { key: 'updateSkill', label: 'Update skills' },
                      { key: 'assignSkill', label: 'Assign / unassign skills' },
                      { key: 'createMcp', label: 'Create MCP servers' },
                      { key: 'attachMcp', label: 'Attach / detach MCP servers' },
                      { key: 'createConnector', label: 'Create connectors' },
                      { key: 'attachConnector', label: 'Attach / detach connectors' },
                      {
                        key: 'manageSchedules',
                        label: 'Manage schedules (create / edit / pause cron)',
                      },
                    ] as const
                  ).map(({ key, label }) => (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-2.5 select-none"
                    >
                      <input
                        type="checkbox"
                        checked={grants[key]}
                        onChange={() => toggleGrant(key)}
                        disabled={isSaving}
                        className="h-4 w-4 cursor-pointer rounded border border-rule bg-canvas accent-conn-vivid disabled:opacity-50"
                      />
                      <span className="text-[14px] text-ink-2">{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Autonomy level */}
              <div className="mb-1">
                <div className="mb-2.5 text-[14px] leading-none text-ink-3">Autonomy level</div>
                <div role="radiogroup" aria-label="Autonomy level">
                  {AUTONOMY_OPTIONS.map((opt) => (
                    <OptionRadio
                      key={opt.value}
                      active={grants.autonomy === opt.value}
                      onClick={() => setAutonomy(opt.value)}
                      name={opt.name}
                      description={opt.description}
                    />
                  ))}
                </div>
              </div>
            </>

            <SetCtaRow onCancel={handleCancel} pending={isSaving} saveLabel="Save" />
          </SetForm>
        </form>
      )}
    </SetBlock>
  );
}
