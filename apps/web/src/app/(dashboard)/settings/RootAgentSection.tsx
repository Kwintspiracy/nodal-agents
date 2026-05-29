'use client';

/**
 * RootAgentSection — settings block for designating a ROOT agent.
 *
 * Lets the user pick an orchestrator agent to act as the workspace ROOT:
 * it receives meta-tools (create_agent / create_skill / assign_skill) subject
 * to per-grant toggles and an autonomy level that controls when those tools
 * require human approval before executing.
 *
 * Wave 2b — V4 ROOT agent, 2026-05-29.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  setRootAgentAction,
  type AgentRow,
  type RootGrants,
  type AutonomyLevel,
  DEFAULT_ROOT_GRANTS,
} from '@/lib/actions.ts';
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
      'The ROOT agent proposes each meta-tool call (create agent, skill, etc.) and waits for your approval in the Approvals queue before executing.',
  },
  {
    value: 'destructive_gate',
    name: 'Autonomous, gate destructive',
    description:
      'Non-destructive meta-tools execute automatically. Destructive ones (none exist yet in the MVT toolset) would still require approval.',
  },
  {
    value: 'fully_autonomous',
    name: 'Fully autonomous',
    description:
      'All enabled meta-tools execute without any approval step. Use only for agents you fully trust.',
  },
];

// ─── Component ─────────────────────────────────────────────────────────────────

export default function RootAgentSection({ agents, initialRootAgentId, initialGrants }: Props) {
  const router = useRouter();
  const [isSaving, startSaveTransition] = useTransition();

  // Filter to orchestrators only — only they may be ROOT.
  const orchestrators = agents.filter((a) => a.role === 'orchestrator');

  const [rootAgentId, setRootAgentId] = useState<string | null>(initialRootAgentId);
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
      const res = await setRootAgentAction({ rootAgentId, grants });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success('ROOT agent configuration saved');
      router.refresh();
    });
  }

  function handleCancel() {
    setRootAgentId(initialRootAgentId);
    setGrants(initialGrants ?? DEFAULT_ROOT_GRANTS);
  }

  return (
    <SetBlock
      label="ROOT agent"
      lede="Designate an orchestrator that can manage this workspace (create skills/agents, assign skills) on your behalf."
    >
      {orchestrators.length === 0 ? (
        /* Empty state — no orchestrators exist yet */
        <div className="mt-3.5 rounded-xl border border-rule-2 bg-paper px-[18px] py-4">
          <p className="text-[13px] text-ink-3">
            No orchestrator agents found.{' '}
            <a
              href="/agents"
              className="font-medium text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
            >
              Create an orchestrator agent
            </a>{' '}
            first, then come back to designate it as ROOT.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSave}>
          <SetForm>
            {/* ── Agent picker ─────────────────────────────────────────────── */}
            <div className="mb-4">
              <label
                htmlFor="root-agent-select"
                className="mb-1.5 block text-[13px] leading-none text-ink-3"
              >
                Orchestrator agent
              </label>
              <select
                id="root-agent-select"
                value={rootAgentId ?? ''}
                onChange={(e) => setRootAgentId(e.target.value === '' ? null : e.target.value)}
                disabled={isSaving}
                className="w-full rounded-lg border border-rule bg-canvas px-3 py-2 text-[13px] text-ink focus:border-ink-3 focus:outline-none disabled:opacity-50"
              >
                <option value="">None — disable ROOT agent</option>
                {orchestrators.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            {/* ── Grant toggles + autonomy (only visible when an agent is selected) */}
            {rootAgentId !== null && (
              <>
                {/* Grant toggles */}
                <div className="mb-4">
                  <div className="mb-2 text-[13px] leading-none text-ink-3">Allowed actions</div>
                  <div className="flex flex-col gap-1.5">
                    {(
                      [
                        { key: 'createAgent', label: 'Create agents' },
                        { key: 'createSkill', label: 'Create skills' },
                        { key: 'assignSkill', label: 'Assign skills' },
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
                        <span className="text-[13.5px] text-ink-2">{label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Autonomy level */}
                <div className="mb-1">
                  <div className="mb-2.5 text-[13px] leading-none text-ink-3">Autonomy level</div>
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
            )}

            <SetCtaRow onCancel={handleCancel} pending={isSaving} saveLabel="Save" />
          </SetForm>
        </form>
      )}
    </SetBlock>
  );
}
