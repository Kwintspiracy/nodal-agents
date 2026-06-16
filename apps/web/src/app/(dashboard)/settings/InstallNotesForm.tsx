'use client';

/**
 * InstallNotesForm — editable textarea for operator-authored notes injected
 * into every agent's ## Runtime system prompt block.
 *
 * These notes are applied live (no restart required). Use them for
 * machine-specifics that auto-detection can't capture — e.g.
 * "ComfyUI runs on :8188", a local GPU, a local API path, or any
 * service/port the agent should know about.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setInstallNotesAction } from '@/lib/actions.ts';
import { SetForm } from '@/components/ui/SetForm.tsx';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';

interface Props {
  initial: string;
}

export default function InstallNotesForm({ initial }: Props) {
  const [notes, setNotes] = useState(initial);
  const [isPending, startTransition] = useTransition();

  function handleReset() {
    setNotes(initial);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const r = await setInstallNotesAction(notes);
      if (!r.ok) {
        toast.error(r.message);
      } else {
        toast.success('Install notes saved — agents will see them on the next job.');
      }
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <SetForm>
        <div className="space-y-2">
          <p className="text-[12.5px] leading-[1.5] text-ink-3">
            These notes are injected into every agent&apos;s runtime context and apply live (no
            restart needed). Use them for machine-specifics the system can&apos;t auto-detect — for
            example: &ldquo;ComfyUI runs on :8188&rdquo;, a local GPU, a local API path, or services
            the agent should call directly.
          </p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={5}
            maxLength={4000}
            placeholder="e.g. ComfyUI runs on :8188 with no auth. GPU: RTX 4090. Ollama on :11434."
            className="w-full resize-y rounded-[9px] border border-rule-2 bg-canvas px-3 py-2.5 text-[13px] leading-[1.55] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-ink/20"
          />
          <div className="text-right text-[11px] text-ink-4">{notes.length} / 4000</div>
        </div>
        <SetCtaRow onCancel={handleReset} pending={isPending} />
      </SetForm>
    </form>
  );
}
