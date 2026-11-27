'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { setAgentMaskSecretShapesAction } from '@/lib/actions.ts';
import Switch from '@/components/ui/Switch';
import { SectionHead } from './SectionCard.tsx';

// ─── Hide secret values from this agent (agents.mask_secret_shapes, 0175) ─────
//
// The screen of the setting the engine reads for every tool result of this
// agent (`loadToolResultMaskPolicy`): what is shown here is what is applied.
// On (the default), a value shaped like a key, a token or a password is hidden
// before the model reads it, and Nodal records what the model read. Off, those
// values pass. The keys Nodal itself holds for the workspace are hidden in
// both cases, and the screen says so. For an agent served by a coding CLI, the
// CLI's own tools read files without Nodal: the screen says what Nodal can and
// cannot hide there.

/** The current state, in the words the owner reads. */
export function secretMaskStateLine(on: boolean): string {
  return on
    ? 'On: this agent cannot read a secret value from a tool result. A value shaped like a key, a token or a password is hidden before it reads it, and in what Nodal records of the run.'
    : 'Off: a value shaped like a key reaches this agent as its tools return it, and is recorded as it read it. A past result quoted from the conversation history is still hidden.';
}

/** Always true, whatever the switch: said beside it. */
export const SECRET_MASK_ALWAYS_LINE =
  'The keys Nodal holds for this workspace (model providers, connectors, MCP servers, channels, webhooks) are hidden from every agent in every case.';

/** What Nodal cannot bound for an agent served by a coding CLI. */
export const SECRET_MASK_CLI_LINE =
  'This agent runs on a coding CLI: what the CLI’s own tools read goes to its provider without passing through Nodal. Nodal hides these values only in what it records and shows.';

export default function SecretMaskSection({
  agentId,
  maskSecretShapes,
  isCliRuntime,
  canChange,
}: {
  agentId: string;
  /** The saved value of agents.mask_secret_shapes; undefined = it could not be read. */
  maskSecretShapes: boolean | undefined;
  isCliRuntime: boolean;
  canChange: boolean;
}) {
  const [enabled, setEnabled] = useState<boolean | undefined>(maskSecretShapes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle() {
    if (enabled === undefined) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    setEnabled(next); // optimistic
    const result = await setAgentMaskSecretShapesAction({ agentId, maskSecretShapes: next });
    setSaving(false);
    if (!result.ok) {
      setEnabled(!next); // revert
      setError(result.message);
      return;
    }
    toast.success('Saved');
  }

  return (
    <>
      <SectionHead
        label="Hide secret values from this agent"
        hint="What its tools return is checked before the model reads it."
        right={
          <div className="mt-0.5">
            <Switch
              checked={enabled === true}
              onChange={() => void handleToggle()}
              disabled={saving || !canChange || enabled === undefined}
              ariaLabel="Hide secret values from this agent"
            />
          </div>
        }
      />

      {enabled === undefined ? (
        <p className="text-body-13 text-err" role="alert" data-testid="secret-mask-unread">
          This setting could not be read. Reload the page.
        </p>
      ) : (
        <p className="text-body-13 text-ink" data-testid="secret-mask-state">
          {secretMaskStateLine(enabled)}
        </p>
      )}

      <p className="mt-3 text-body-12 text-ink-4" data-testid="secret-mask-always">
        {SECRET_MASK_ALWAYS_LINE}
      </p>

      {isCliRuntime && (
        <p className="mt-2 text-body-12 text-ink-4" data-testid="secret-mask-cli">
          {SECRET_MASK_CLI_LINE}
        </p>
      )}

      {error && (
        <p className="mt-3 text-body-12 text-err" role="alert" data-testid="secret-mask-error">
          {error}
        </p>
      )}

      {!canChange && (
        <p className="mt-2 text-body-12 text-ink-4">
          Only the workspace owner can change what an agent may read.
        </p>
      )}
    </>
  );
}
