'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { setAgentMayChangeTeamAction } from '@/lib/actions.ts';
import Switch from '@/components/ui/Switch';
import { SectionCard, SectionHead } from './SectionCard.tsx';

// ─── May change its own team (issue #137) ─────────────────────────────────────
//
// The screen of `agents.may_change_team`. On the night of 2026-09-15 a request
// asked an orchestrator for a review "with Reviewer C, without going through
// Lead-Dev". Reviewer C was not in its team, so the agent attached it to itself
// and delegated. The owner found the team rearranged the next morning. The
// answer that was missing is the plain one: I cannot, Lead-Dev has a reviewer.
//
// The switch is OFF for every agent that existed before migration 0111 — the
// power is taken back in the open rather than left where nobody set it. With it
// off, create_agent / attach_agent / detach_agent are not in the tool list the
// runner computes for a job, so the model never sees them.
//
// It sits in the Autonomy tab next to the command allowlist, and carries the
// same owner gate: both say what an agent may do without anyone watching.

/** The current state, in the words the owner reads. */
export function teamStateLine(mayChangeTeam: boolean): string {
  return mayChangeTeam
    ? 'On: this agent can create agents, attach them to itself and detach them while it works'
    : 'Off: this agent works with the team you gave it, and says so when it needs someone else';
}

export default function TeamChangeSection({
  agentId,
  mayChangeTeam,
  isOwner,
}: {
  agentId: string;
  /** The saved value of agents.may_change_team. */
  mayChangeTeam: boolean;
  isOwner: boolean;
}) {
  // Same gate shape as CommandAllowlistSection: the server action refuses a
  // non-owner outside local-trust, and the client reads the mode from the
  // CLI-set public env var.
  const isLocalTrust = (process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'local-trust') === 'local-trust';
  const canEdit = isLocalTrust || isOwner;

  const [enabled, setEnabled] = useState<boolean>(mayChangeTeam);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle() {
    const next = !enabled;
    setSaving(true);
    setError(null);
    setEnabled(next); // optimistic
    const result = await setAgentMayChangeTeamAction({ agentId, mayChangeTeam: next });
    setSaving(false);
    if (!result.ok) {
      setEnabled(!next); // revert
      setError(result.message);
      return;
    }
    toast.success('Saved');
  }

  return (
    <SectionCard>
      <SectionHead
        label="May change its own team"
        hint="Lets this agent create an agent, attach one to itself or detach one, on its own, mid-run."
        right={
          <div className="mt-0.5">
            <Switch
              checked={enabled}
              onChange={() => void handleToggle()}
              disabled={saving || !canEdit}
              ariaLabel="May change its own team"
            />
          </div>
        }
      />

      <p className="text-body-13 text-ink" data-testid="may-change-team-state">
        {teamStateLine(enabled)}
      </p>

      {error && (
        <p className="mt-3 text-body-12 text-err" role="alert" data-testid="may-change-team-error">
          {error}
        </p>
      )}

      <p className="mt-4 text-body-12 text-ink-4">
        Off, the three tools are absent from the list the runner builds for each run, so the agent
        answers with what it cannot do and names who can, instead of recruiting.
      </p>

      {!canEdit && (
        <p className="mt-2 text-body-12 text-ink-4">
          Only the workspace owner can change who an agent may recruit.
        </p>
      )}
    </SectionCard>
  );
}
