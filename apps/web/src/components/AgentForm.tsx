'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { createAgentAction } from '@/lib/actions.ts';
import type { ConfiguredLlmProvider } from '@/lib/llm-providers.ts';

interface AgentFormProps {
  models: ConfiguredLlmProvider[];
}

export default function AgentForm({ models }: AgentFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    startTransition(async () => {
      const result = await createAgentAction(data);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success('Agent created');
      formRef.current?.reset();
      setOpen(false);
    });
  }

  const noModels = models.length === 0;

  const modal = open
    ? createPortal(
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 z-40 animate-[fadeIn_150ms_ease]"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          {/* Panel */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="New agent"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <form
              ref={formRef}
              onSubmit={handleSubmit}
              className="pointer-events-auto w-full max-w-lg bg-neutral-900 border border-neutral-800/60 rounded-xl p-6 space-y-4 shadow-2xl animate-[scaleIn_150ms_ease]"
            >
              <h3 className="text-sm font-semibold text-white">New agent</h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-slug">
                    Slug
                  </label>
                  <input
                    id="agent-slug"
                    name="slug"
                    required
                    pattern="[a-z0-9-]+"
                    placeholder="my-agent"
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-name">
                    Name
                  </label>
                  <input
                    id="agent-name"
                    name="name"
                    required
                    placeholder="My Agent"
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-personality">
                  Personality / System prompt
                </label>
                <textarea
                  id="agent-personality"
                  name="personality"
                  required
                  rows={4}
                  placeholder="You are a helpful assistant..."
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-model">
                  Model
                </label>
                {noModels ? (
                  <p className="text-xs text-amber-400 mt-1">
                    No LLM provider configured — run <code className="font-mono">nodalai init</code>{' '}
                    first.
                  </p>
                ) : (
                  <select
                    id="agent-model"
                    name="model"
                    required
                    defaultValue={models[0]?.model}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.model}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={isPending || noModels}
                  className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors disabled:opacity-50"
                >
                  {isPending ? 'Creating…' : 'Create agent'}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-400 rounded-lg hover:border-neutral-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 text-sm font-medium bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors"
      >
        + New agent
      </button>
      {modal}
    </>
  );
}
