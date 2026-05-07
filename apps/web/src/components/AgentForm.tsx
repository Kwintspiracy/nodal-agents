'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  createAgentAction,
  updateAgentAction,
  type AgentRow,
  type AgentEditRow,
  type LlmKeyUiRow,
} from '@/lib/actions.ts';
import { prettyProviderName } from '@/lib/provider-names.ts';

type AgentRole = 'worker' | 'router' | 'planner';

interface CreateProps {
  mode?: 'create';
  llmKeys: LlmKeyUiRow[];
  agents?: AgentRow[];
  initial?: undefined;
}

interface EditProps {
  mode: 'edit';
  llmKeys: LlmKeyUiRow[];
  agents?: AgentRow[];
  initial: AgentEditRow;
}

type Props = CreateProps | EditProps;

// Map DB role columns back to the UX-level enum for pre-filling edit form.
function dbRoleToUiRole(
  role: string | null,
  orchestratorMode: string | null | undefined,
): AgentRole {
  if (role === 'orchestrator' && orchestratorMode === 'planner') return 'planner';
  if (role === 'orchestrator') return 'router';
  return 'worker';
}

export default function AgentForm(props: Props) {
  const isEdit = props.mode === 'edit';
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  // In edit mode, the form is always open (it IS the page content).
  const [open, setOpen] = useState(isEdit);

  // Derive initial role state from initial prop (edit) or default (create).
  const initialRole: AgentRole = isEdit
    ? dbRoleToUiRole(props.initial.role ?? null, props.initial.orchestratorMode ?? null)
    : 'worker';

  const [role, setRole] = useState<AgentRole>(initialRole);
  const [subAgentIds, setSubAgentIds] = useState<string[]>(isEdit ? props.initial.subAgentIds : []);

  // LLM provider + model state. In edit mode, prefill from initial.llmKeyId
  // (if set) or fall back to the first active key. In create mode, default to
  // the first active key.
  const activeKeys = useMemo(() => props.llmKeys.filter((k) => k.isActive), [props.llmKeys]);
  const initialLlmKeyId: string =
    (isEdit ? (props.initial.llmKeyId ?? null) : null) ?? activeKeys[0]?.id ?? '';
  const [llmKeyId, setLlmKeyId] = useState<string>(initialLlmKeyId);
  const [model, setModel] = useState<string>(isEdit ? (props.initial.model ?? '') : '');

  const selectedKey = useMemo(
    () => props.llmKeys.find((k) => k.id === llmKeyId) ?? null,
    [props.llmKeys, llmKeyId],
  );

  function handleLlmKeyChange(id: string) {
    const newKey = props.llmKeys.find((row) => row.id === id);
    const oldDefaultModel = selectedKey?.defaultModel ?? null;
    setLlmKeyId(id);
    // Auto-fill model with the new provider's defaultModel if (a) model is empty,
    // OR (b) the current model exactly matches the previous provider's default
    // (= user hadn't customized it, so switching providers can safely refresh).
    // Preserves a user's hand-typed custom model across provider switches.
    if (newKey?.defaultModel && (!model || model === oldDefaultModel)) {
      setModel(newKey.defaultModel);
    }
  }

  useEffect(() => {
    if (!open || isEdit) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isEdit]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    if (isEdit && props.mode === 'edit') {
      const payload = {
        id: props.initial.id,
        name: fd.get('name'),
        personality: fd.get('personality'),
        model,
        llmKeyId: llmKeyId || null,
        role,
        subAgentIds: role === 'worker' ? [] : subAgentIds,
      };
      startTransition(async () => {
        const result = await updateAgentAction(payload);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        toast.success('Agent updated');
        router.push('/agents');
      });
    } else {
      const payload = {
        slug: fd.get('slug'),
        name: fd.get('name'),
        personality: fd.get('personality'),
        model,
        llmKeyId: llmKeyId || undefined,
        role,
        subAgentIds: role === 'worker' ? [] : subAgentIds,
      };
      startTransition(async () => {
        const result = await createAgentAction(payload);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        toast.success('Agent created');
        formRef.current?.reset();
        setRole('worker');
        setSubAgentIds([]);
        setLlmKeyId(activeKeys[0]?.id ?? '');
        setModel('');
        setOpen(false);
      });
    }
  }

  function toggleSubAgent(id: string) {
    setSubAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const agents = props.agents ?? [];
  const noLlmKeys = activeKeys.length === 0;
  const showSubAgents = role !== 'worker';
  const noAgentsForPicker = agents.length === 0;

  // ─── Edit mode: form rendered inline (no modal/portal) ─────────────────────

  if (isEdit) {
    const initial = props.initial;

    return (
      <form ref={formRef} onSubmit={handleSubmit} className="w-full max-w-lg space-y-4">
        <h3 className="text-sm font-semibold text-white">Edit agent</h3>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-slug">
              Slug
            </label>
            <input
              id="agent-slug"
              name="slug"
              readOnly
              defaultValue={initial.slug}
              title="Slug is not editable"
              className="w-full bg-neutral-800/40 border border-neutral-700/50 rounded-lg px-3 py-2 text-sm text-neutral-500 cursor-not-allowed"
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
              defaultValue={initial.name}
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
            rows={6}
            defaultValue={initial.personality}
            placeholder="You are a helpful assistant..."
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none resize-y"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-llm-key">
              LLM provider
            </label>
            {noLlmKeys ? (
              <p className="text-xs text-amber-400 mt-1">
                No active LLM providers. Add one in{' '}
                <a href="/settings" className="underline">
                  Settings → LLM providers
                </a>
                .
              </p>
            ) : (
              <select
                id="agent-llm-key"
                value={llmKeyId}
                onChange={(e) => handleLlmKeyChange(e.target.value)}
                required
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
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
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-model">
              Model
            </label>
            <input
              id="agent-model"
              name="model"
              type="text"
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={selectedKey?.defaultModel ?? 'e.g. claude-haiku-4-5-20251001'}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-role">
            Role
          </label>
          <select
            id="agent-role"
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
          >
            <option value="worker">Worker — runs its own tools and tasks</option>
            <option value="router">Router — delegates to one sub-agent at a time</option>
            <option value="planner">Planner — creates parallel tasks for sub-agents</option>
          </select>
        </div>

        {showSubAgents && (
          <div>
            <label className="block text-xs text-neutral-500 mb-1">
              Sub-agents <span className="text-neutral-600">({subAgentIds.length} selected)</span>
            </label>
            {noAgentsForPicker ? (
              <p className="text-xs text-amber-400 mt-1">
                Create at least one worker agent first — orchestrators need someone to delegate to.
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto bg-neutral-800/60 border border-neutral-700 rounded-lg divide-y divide-neutral-800">
                {agents.map((a) => {
                  const checked = subAgentIds.includes(a.id);
                  return (
                    <label
                      key={a.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-neutral-800/80"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSubAgent(a.id)}
                        className="accent-violet-500"
                      />
                      <span className="text-white">{a.name}</span>
                      <span className="font-mono text-xs text-neutral-500 ml-auto">{a.slug}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={isPending || noLlmKeys}
            className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors disabled:opacity-50"
          >
            {isPending ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/agents')}
            className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-400 rounded-lg hover:border-neutral-600 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  // ─── Create mode: toggle button + portal modal ──────────────────────────────

  const modal = open
    ? createPortal(
        <>
          <div
            className="fixed inset-0 bg-black/60 z-40 animate-[fadeIn_150ms_ease]"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="New agent"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <form
              ref={formRef}
              onSubmit={handleSubmit}
              className="pointer-events-auto w-full max-w-lg max-h-[90vh] overflow-y-auto bg-neutral-900 border border-neutral-800/60 rounded-xl p-6 space-y-4 shadow-2xl animate-[scaleIn_150ms_ease]"
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
                    pattern="[a-z0-9\-]+"
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-llm-key">
                    LLM provider
                  </label>
                  {noLlmKeys ? (
                    <p className="text-xs text-amber-400 mt-1">
                      No active LLM providers. Add one in{' '}
                      <a href="/settings" className="underline">
                        Settings → LLM providers
                      </a>
                      .
                    </p>
                  ) : (
                    <select
                      id="agent-llm-key"
                      value={llmKeyId}
                      onChange={(e) => handleLlmKeyChange(e.target.value)}
                      required
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
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
                </div>
                <div>
                  <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-model">
                    Model
                  </label>
                  <input
                    id="agent-model"
                    name="model"
                    type="text"
                    required
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={selectedKey?.defaultModel ?? 'e.g. claude-haiku-4-5-20251001'}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-neutral-500 mb-1" htmlFor="agent-role">
                  Role
                </label>
                <select
                  id="agent-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as AgentRole)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
                >
                  <option value="worker">Worker — runs its own tools and tasks</option>
                  <option value="router">Router — delegates to one sub-agent at a time</option>
                  <option value="planner">Planner — creates parallel tasks for sub-agents</option>
                </select>
              </div>

              {showSubAgents && (
                <div>
                  <label className="block text-xs text-neutral-500 mb-1">
                    Sub-agents{' '}
                    <span className="text-neutral-600">({subAgentIds.length} selected)</span>
                  </label>
                  {noAgentsForPicker ? (
                    <p className="text-xs text-amber-400 mt-1">
                      Create at least one worker agent first — orchestrators need someone to
                      delegate to.
                    </p>
                  ) : (
                    <div className="max-h-40 overflow-y-auto bg-neutral-800/60 border border-neutral-700 rounded-lg divide-y divide-neutral-800">
                      {agents.map((a) => {
                        const checked = subAgentIds.includes(a.id);
                        return (
                          <label
                            key={a.id}
                            className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-neutral-800/80"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSubAgent(a.id)}
                              className="accent-violet-500"
                            />
                            <span className="text-white">{a.name}</span>
                            <span className="font-mono text-xs text-neutral-500 ml-auto">
                              {a.slug}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={isPending || noLlmKeys}
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
