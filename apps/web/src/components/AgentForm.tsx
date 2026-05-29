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
import AvatarPicker from './AvatarPicker.tsx';
import {
  detectModelProviders,
  isModelCompatibleWithProvider,
  type ProviderSlug,
} from '@/lib/model-provider-detect.ts';

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

// Per-agent Connector + MCP assignment has moved to AgentComposer (the
// `/agents/[id]/edit` page). This file now only powers the "+ New agent"
// create modal on /agents — agent → connector / MCP wiring happens after
// creation, in the Composer's Connectors and Knowledge tabs.

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
    (isEdit ? props.initial.llmKeyId : null) ?? activeKeys[0]?.id ?? '';
  const [llmKeyId, setLlmKeyId] = useState<string>(initialLlmKeyId);
  const [model, setModel] = useState<string>(isEdit ? (props.initial.model ?? '') : '');
  // Avatar URL — controlled state because the picker is non-FormData (modal).
  // null = no avatar (initials fallback in display components).
  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    isEdit ? (props.initial.avatarUrl ?? null) : null,
  );

  const selectedKey = useMemo(
    () => props.llmKeys.find((k) => k.id === llmKeyId) ?? null,
    [props.llmKeys, llmKeyId],
  );

  // ── Model ↔ key coherence (Brique 34quinquies follow-up) ────────────────────
  // Live bug: changing agent.model without changing agent.llmKeyId leaves the
  // key pointing at the wrong provider — runtime fails silently. We detect the
  // model's expected provider and (a) auto-switch when there's exactly one
  // compatible active key, (b) block save with an inline banner otherwise.

  const detectedProviders = useMemo<Set<ProviderSlug>>(() => detectModelProviders(model), [model]);

  const compatibleActiveKeys = useMemo(
    () =>
      activeKeys.filter((k) => isModelCompatibleWithProvider(model, k.provider as ProviderSlug)),
    [activeKeys, model],
  );

  const coherenceOk = selectedKey
    ? isModelCompatibleWithProvider(model, selectedKey.provider as ProviderSlug)
    : true;

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

  function handleModelChange(nextModel: string) {
    setModel(nextModel);
    // Auto-switch the key if (a) the current key is incompatible AND
    // (b) exactly one active key matches the new model. We never auto-switch
    // when multiple keys match (avoid surprise) or when none match (let the
    // user see the warning banner instead).
    if (!selectedKey) return;
    const currentlyCompatible = isModelCompatibleWithProvider(
      nextModel,
      selectedKey.provider as ProviderSlug,
    );
    if (currentlyCompatible) return;
    const candidates = activeKeys.filter((k) =>
      isModelCompatibleWithProvider(nextModel, k.provider as ProviderSlug),
    );
    if (candidates.length === 1 && candidates[0]) {
      setLlmKeyId(candidates[0].id);
      toast.success(
        `Switched provider to ${prettyProviderName(candidates[0].provider)} (matches ${nextModel})`,
      );
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
        avatarUrl,
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
        avatarUrl,
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
        setAvatarUrl(null);
        setOpen(false);
        // Re-fetch the /agents server components so the new agent appears
        // without a manual reload (revalidatePath alone doesn't refresh the
        // current view when the action is called outside a <form action>).
        router.refresh();
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

  // ── Coherence banner (rendered under Model input in both edit + create) ────
  const coherenceBanner =
    !coherenceOk && selectedKey ? (
      <div
        role="alert"
        data-testid="model-provider-mismatch"
        className="mt-1 px-2 py-1.5 rounded border border-warn/30 bg-warn-bg text-[11px] text-warn space-y-1"
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
          <div className="flex flex-wrap gap-1">
            <span className="text-warn/80">Switch to:</span>
            {compatibleActiveKeys.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => setLlmKeyId(k.id)}
                className="px-1.5 py-0.5 rounded border border-warn/30 text-warn hover:bg-warn-bg font-medium"
              >
                {k.nickname ?? prettyProviderName(k.provider)} ({prettyProviderName(k.provider)})
              </button>
            ))}
          </div>
        ) : (
          <p>
            No compatible active key.{' '}
            <a href="/settings" className="underline hover:text-warn">
              Add one in Settings → LLM providers
            </a>
            .
          </p>
        )}
      </div>
    ) : null;

  // ─── Edit mode: form rendered inline (no modal/portal) ─────────────────────

  if (isEdit) {
    const initial = props.initial;

    return (
      <form ref={formRef} onSubmit={handleSubmit} className="w-full max-w-lg space-y-4">
        <h3 className="text-sm font-semibold text-ink">Edit agent</h3>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-slug">
              Slug
            </label>
            <input
              id="agent-slug"
              name="slug"
              readOnly
              defaultValue={initial.slug}
              title="Slug is not editable"
              className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink-3 cursor-not-allowed"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-name">
              Name
            </label>
            <input
              id="agent-name"
              name="name"
              required
              defaultValue={initial.name}
              placeholder="My Agent"
              className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
            />
          </div>
        </div>

        <AvatarPicker value={avatarUrl} onChange={setAvatarUrl} />

        <div>
          <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-personality">
            Personality / System prompt
          </label>
          <textarea
            id="agent-personality"
            name="personality"
            required
            rows={6}
            defaultValue={initial.personality}
            placeholder="You are a helpful assistant..."
            className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none resize-y"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-llm-key">
              LLM provider
            </label>
            {noLlmKeys ? (
              <p className="text-xs text-warn mt-1">
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
                className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink focus:border-ink-3 focus:outline-none"
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
            <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-model">
              Model
            </label>
            <input
              id="agent-model"
              name="model"
              type="text"
              required
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
              placeholder={selectedKey?.defaultModel ?? 'e.g. claude-haiku-4-5-20251001'}
              className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
            />
            {coherenceBanner}
          </div>
        </div>

        <div>
          <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-role">
            Role
          </label>
          <select
            id="agent-role"
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
            className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink focus:border-ink-3 focus:outline-none"
          >
            <option value="worker">Worker — runs its own tools and tasks</option>
            <option value="router">Router — delegates to one sub-agent at a time</option>
            <option value="planner">Planner — creates parallel tasks for sub-agents</option>
          </select>
        </div>

        {showSubAgents && (
          <div>
            <label className="block text-xs text-ink-3 mb-1">
              Sub-agents <span className="text-ink-4">({subAgentIds.length} selected)</span>
            </label>
            {noAgentsForPicker ? (
              <p className="text-xs text-warn mt-1">
                Create at least one worker agent first — orchestrators need someone to delegate to.
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto bg-hover border border-rule rounded-lg divide-y divide-neutral-800">
                {agents.map((a) => {
                  const checked = subAgentIds.includes(a.id);
                  return (
                    <label
                      key={a.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-hover/80"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSubAgent(a.id)}
                        className="accent-violet-500"
                      />
                      <span className="text-ink">{a.name}</span>
                      <span className="font-mono text-xs text-ink-3 ml-auto">{a.slug}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Connector + MCP assignment moved to /agents/[id]/edit (AgentComposer
            Connectors + Knowledge tabs). Save the agent first, then attach
            connectors there. */}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={isPending || noLlmKeys || !coherenceOk}
            title={!coherenceOk ? 'Pick a key that matches the model first' : undefined}
            className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-lg hover:brightness-[0.92] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/agents')}
            className="px-4 py-2 text-sm font-medium border border-rule text-ink-3 rounded-lg hover:border-rule transition-colors"
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
              className="pointer-events-auto w-full max-w-lg max-h-[90vh] overflow-y-auto bg-paper border border-rule-2 rounded-xl p-6 space-y-4 shadow-2xl animate-[scaleIn_150ms_ease]"
            >
              <h3 className="text-sm font-semibold text-ink">New agent</h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-slug">
                    Slug
                  </label>
                  <input
                    id="agent-slug"
                    name="slug"
                    required
                    pattern="[a-z0-9\-]+"
                    placeholder="my-agent"
                    className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-name">
                    Name
                  </label>
                  <input
                    id="agent-name"
                    name="name"
                    required
                    placeholder="My Agent"
                    className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
                  />
                </div>
              </div>

              <AvatarPicker value={avatarUrl} onChange={setAvatarUrl} />

              <div>
                <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-personality">
                  Personality / System prompt
                </label>
                <textarea
                  id="agent-personality"
                  name="personality"
                  required
                  rows={4}
                  placeholder="You are a helpful assistant..."
                  className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none resize-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-llm-key">
                    LLM provider
                  </label>
                  {noLlmKeys ? (
                    <p className="text-xs text-warn mt-1">
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
                      className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink focus:border-ink-3 focus:outline-none"
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
                  <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-model">
                    Model
                  </label>
                  <input
                    id="agent-model"
                    name="model"
                    type="text"
                    required
                    value={model}
                    onChange={(e) => handleModelChange(e.target.value)}
                    placeholder={selectedKey?.defaultModel ?? 'e.g. claude-haiku-4-5-20251001'}
                    className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
                  />
                  {coherenceBanner}
                </div>
              </div>

              <div>
                <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-role">
                  Role
                </label>
                <select
                  id="agent-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as AgentRole)}
                  className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink focus:border-ink-3 focus:outline-none"
                >
                  <option value="worker">Worker — runs its own tools and tasks</option>
                  <option value="router">Router — delegates to one sub-agent at a time</option>
                  <option value="planner">Planner — creates parallel tasks for sub-agents</option>
                </select>
              </div>

              {showSubAgents && (
                <div>
                  <label className="block text-xs text-ink-3 mb-1">
                    Sub-agents <span className="text-ink-4">({subAgentIds.length} selected)</span>
                  </label>
                  {noAgentsForPicker ? (
                    <p className="text-xs text-warn mt-1">
                      Create at least one worker agent first — orchestrators need someone to
                      delegate to.
                    </p>
                  ) : (
                    <div className="max-h-40 overflow-y-auto bg-hover border border-rule rounded-lg divide-y divide-neutral-800">
                      {agents.map((a) => {
                        const checked = subAgentIds.includes(a.id);
                        return (
                          <label
                            key={a.id}
                            className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-hover/80"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSubAgent(a.id)}
                              className="accent-violet-500"
                            />
                            <span className="text-ink">{a.name}</span>
                            <span className="font-mono text-xs text-ink-3 ml-auto">{a.slug}</span>
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
                  disabled={isPending || noLlmKeys || !coherenceOk}
                  title={!coherenceOk ? 'Pick a key that matches the model first' : undefined}
                  className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-lg hover:brightness-[0.92] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPending ? 'Creating…' : 'Create agent'}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="px-4 py-2 text-sm font-medium border border-rule text-ink-3 rounded-lg hover:border-rule transition-colors"
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
        className="px-4 py-2 text-sm font-medium bg-ink text-canvas rounded-lg hover:brightness-[0.92] transition-colors"
      >
        + New agent
      </button>
      {modal}
    </>
  );
}
