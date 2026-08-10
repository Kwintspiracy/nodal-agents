'use client';

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  createAgentAction,
  updateAgentAction,
  listKeyModelsAction,
  type AgentRow,
  type AgentEditRow,
  type LlmKeyUiRow,
} from '@/lib/actions.ts';
import {
  MODEL_CATALOG,
  findModelCatalogEntry,
  groupModelCatalog,
  modelOptionLabel,
} from '@nodal-agents/shared';
import { prettyProviderName } from '@/lib/provider-names.ts';
import { Plus } from '@phosphor-icons/react';
import PrimaryButton from './ui/PrimaryButton.tsx';
import Modal, { ModalFooter } from './ui/Modal.tsx';
import AvatarPicker from './AvatarPicker.tsx';
import { ModelToolsLegend } from './ui/ModelToolsBadge.tsx';
import TextInput from './ui/TextInput.tsx';
import TextArea from './ui/TextArea.tsx';
import Select from './ui/Select.tsx';
import Checkbox from './ui/Checkbox.tsx';

type AgentRole = 'worker' | 'router' | 'planner';

interface CreateProps {
  mode?: 'create';
  llmKeys: LlmKeyUiRow[];
  agents?: AgentRow[];
  initial?: undefined;
  /** Preset role the create modal opens with — e.g. AgentsList's "New
   *  orchestrator" footer button opens this same modal pre-set to 'router'
   *  instead of the default 'worker'. Ignored in edit mode. */
  initialRole?: AgentRole;
  /** Custom trigger, replacing the default "+ New agent" button. Receives a
   *  function that opens the modal — e.g. AgentsList renders its own dashed
   *  "New orchestrator" button here so one create flow powers both entry
   *  points instead of duplicating the form. */
  renderTrigger?: (open: () => void) => ReactNode;
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
    : (props.initialRole ?? 'worker');

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
  const [liveModelsCache, setLiveModelsCache] = useState<Record<string, string[]>>({});
  const [liveModelsLoading, setLiveModelsLoading] = useState(false);

  const selectedKey = useMemo(
    () => props.llmKeys.find((k) => k.id === llmKeyId) ?? null,
    [props.llmKeys, llmKeyId],
  );

  function handleLlmKeyChange(id: string) {
    const newKey = props.llmKeys.find((row) => row.id === id);
    setLlmKeyId(id);
    // Switching provider resets the model to that provider's first curated
    // model — a model id only makes sense for its own provider (no stale,
    // mismatched model).
    setModel(MODEL_CATALOG[newKey?.provider ?? '']?.[0]?.modelId ?? '');
    // Prefetch live models for this key if not yet cached.
    if (id && liveModelsCache[id] === undefined) {
      setLiveModelsLoading(true);
      listKeyModelsAction(id).then((res) => {
        setLiveModelsCache((prev) => ({ ...prev, [id]: res.ok ? res.data : [] }));
        setLiveModelsLoading(false);
      });
    }
  }

  function handleModelChange(nextModel: string) {
    setModel(nextModel);
  }

  // Prefetch live model list for the initially-selected key.
  useEffect(() => {
    if (!llmKeyId || liveModelsCache[llmKeyId] !== undefined) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLiveModelsLoading(true);
    listKeyModelsAction(llmKeyId).then((res) => {
      setLiveModelsCache((prev) => ({ ...prev, [llmKeyId]: res.ok ? res.data : [] }));
      setLiveModelsLoading(false);
    });
  }, [llmKeyId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // This form has no instructions editor — pass the loaded values
        // through so the assignment rewrite in the action never wipes them.
        subAgentInstructions: props.initial.subAgentInstructions ?? {},
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
        setRole(initialRole);
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

  // Coherence banner removed — switching provider now just resets the model.
  const coherenceBanner = null;

  // Derived: merged catalog + live model list.
  const modelCatalog = selectedKey ? (MODEL_CATALOG[selectedKey.provider] ?? []) : [];
  const liveModelIds: string[] = selectedKey ? (liveModelsCache[selectedKey.id] ?? []) : [];
  const catalogModelIds = new Set(modelCatalog.map((m) => m.modelId));
  const extraLiveIds = liveModelIds.filter((id) => !catalogModelIds.has(id));
  const modelInCatalog = !!findModelCatalogEntry(selectedKey?.provider ?? '', model);
  const modelInDropdown = modelInCatalog || liveModelIds.includes(model);
  // Router/planner delegate via tool calls — a model that can't call tools
  // can't function as an orchestrator. Workers aren't gated here (a worker's
  // own tool needs are whatever its assigned skills require, judged at run
  // time, not at creation time).
  const requireTools = role !== 'worker';

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
            <TextInput
              id="agent-slug"
              name="slug"
              readOnly
              defaultValue={initial.slug}
              title="Slug is not editable"
              className="rounded-lg text-ink-3 cursor-not-allowed"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-name">
              Name
            </label>
            <TextInput
              id="agent-name"
              name="name"
              required
              defaultValue={initial.name}
              placeholder="My Agent"
              className="rounded-lg"
            />
          </div>
        </div>

        <AvatarPicker value={avatarUrl} onChange={setAvatarUrl} />

        <div>
          <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-personality">
            Personality / System prompt
          </label>
          <TextArea
            id="agent-personality"
            name="personality"
            required
            rows={6}
            defaultValue={initial.personality}
            placeholder="You are a helpful assistant..."
            className="resize-y rounded-lg"
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
              <Select
                id="agent-llm-key"
                value={llmKeyId}
                onChange={(e) => handleLlmKeyChange(e.target.value)}
                required
                className="rounded-lg"
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
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-model">
              {liveModelsLoading &&
              selectedKey?.id !== undefined &&
              liveModelsCache[selectedKey.id] === undefined
                ? 'Model (loading…)'
                : 'Model'}
            </label>
            {(modelCatalog.length > 0 || extraLiveIds.length > 0) && (
              <Select
                id="agent-model"
                value={modelInDropdown ? model : '__custom__'}
                onChange={(e) =>
                  handleModelChange(e.target.value === '__custom__' ? '' : e.target.value)
                }
                required={modelInDropdown}
                className="mb-2 rounded-lg"
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
              <>
                {/* Picking "Custom…" leaves the dropdown on screen AND opens this
                    field. Both used to carry id="agent-model": invalid HTML, and
                    the visible <label htmlFor="agent-model"> bound to the select
                    only — so the field the user actually types in had no
                    accessible name, and clicking the label never focused it.
                    When the dropdown is present, the custom field takes its own
                    id and its own label; when there is no catalog at all, it IS
                    the model field and keeps the original id. */}
                {(modelCatalog.length > 0 || extraLiveIds.length > 0) && (
                  <label className="sr-only" htmlFor="agent-model-custom">
                    Custom model id
                  </label>
                )}
                <TextInput
                  id={
                    modelCatalog.length > 0 || extraLiveIds.length > 0
                      ? 'agent-model-custom'
                      : 'agent-model'
                  }
                  name="model"
                  type="text"
                  required
                  value={model}
                  onChange={(e) => handleModelChange(e.target.value)}
                  placeholder={
                    MODEL_CATALOG[selectedKey?.provider ?? '']?.[0]?.modelId ??
                    'e.g. claude-haiku-4-5-20251001'
                  }
                  className="rounded-lg font-mono"
                />
              </>
            )}
            {(modelCatalog.length > 0 || extraLiveIds.length > 0) && (
              <ModelToolsLegend className="mt-1.5" />
            )}
            {coherenceBanner}
          </div>
        </div>

        <div>
          <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-role">
            Role
          </label>
          <Select
            id="agent-role"
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
            className="rounded-lg"
          >
            <option value="worker">Worker (runs its own tools and tasks)</option>
            <option value="router">Router (delegates to one sub-agent at a time)</option>
            <option value="planner">Planner (creates parallel tasks for sub-agents)</option>
          </Select>
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
                    <Checkbox
                      key={a.id}
                      tone="agent"
                      checked={checked}
                      onChange={() => toggleSubAgent(a.id)}
                      containerClassName="px-3 py-2 hover:bg-hover/80"
                      label={
                        <>
                          <span className="text-ink">{a.name}</span>
                          <span className="ml-auto font-mono text-xs text-ink-3">{a.slug}</span>
                        </>
                      }
                    />
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
          <PrimaryButton variant="ink" type="submit" disabled={isPending || noLlmKeys}>
            {isPending ? 'Saving…' : 'Save changes'}
          </PrimaryButton>
          <PrimaryButton variant="neutral" type="button" onClick={() => router.push('/agents')}>
            Cancel
          </PrimaryButton>
        </div>
      </form>
    );
  }

  // ─── Create mode: toggle button + shared Modal ──────────────────────────────

  const modal = (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="New agent"
      dismissable={false}
      footer={
        <ModalFooter>
          <PrimaryButton variant="neutral" type="button" onClick={() => setOpen(false)}>
            Cancel
          </PrimaryButton>
          <PrimaryButton
            variant="ink"
            type="submit"
            form="new-agent-form"
            disabled={isPending || noLlmKeys}
          >
            {isPending ? 'Creating…' : 'Create agent'}
          </PrimaryButton>
        </ModalFooter>
      }
    >
      <form id="new-agent-form" ref={formRef} onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-slug">
              Slug
            </label>
            <TextInput
              id="agent-slug"
              name="slug"
              required
              pattern="[a-z0-9\-]+"
              placeholder="my-agent"
              className="rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-name">
              Name
            </label>
            <TextInput
              id="agent-name"
              name="name"
              required
              placeholder="My Agent"
              className="rounded-lg"
            />
          </div>
        </div>

        <AvatarPicker value={avatarUrl} onChange={setAvatarUrl} />

        <div>
          <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-personality">
            Personality / System prompt
          </label>
          <TextArea
            id="agent-personality"
            name="personality"
            required
            rows={4}
            placeholder="You are a helpful assistant..."
            className="resize-none rounded-lg"
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
              <Select
                id="agent-llm-key"
                value={llmKeyId}
                onChange={(e) => handleLlmKeyChange(e.target.value)}
                required
                className="rounded-lg"
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
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-model">
              {liveModelsLoading &&
              selectedKey?.id !== undefined &&
              liveModelsCache[selectedKey.id] === undefined
                ? 'Model (loading…)'
                : 'Model'}
            </label>
            {(modelCatalog.length > 0 || extraLiveIds.length > 0) && (
              <Select
                id="agent-model"
                value={modelInDropdown ? model : '__custom__'}
                onChange={(e) =>
                  handleModelChange(e.target.value === '__custom__' ? '' : e.target.value)
                }
                required={modelInDropdown}
                className="mb-2 rounded-lg"
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
              <>
                {/* Picking "Custom…" leaves the dropdown on screen AND opens this
                    field. Both used to carry id="agent-model": invalid HTML, and
                    the visible <label htmlFor="agent-model"> bound to the select
                    only — so the field the user actually types in had no
                    accessible name, and clicking the label never focused it.
                    When the dropdown is present, the custom field takes its own
                    id and its own label; when there is no catalog at all, it IS
                    the model field and keeps the original id. */}
                {(modelCatalog.length > 0 || extraLiveIds.length > 0) && (
                  <label className="sr-only" htmlFor="agent-model-custom">
                    Custom model id
                  </label>
                )}
                <TextInput
                  id={
                    modelCatalog.length > 0 || extraLiveIds.length > 0
                      ? 'agent-model-custom'
                      : 'agent-model'
                  }
                  name="model"
                  type="text"
                  required
                  value={model}
                  onChange={(e) => handleModelChange(e.target.value)}
                  placeholder={
                    MODEL_CATALOG[selectedKey?.provider ?? '']?.[0]?.modelId ??
                    'e.g. claude-haiku-4-5-20251001'
                  }
                  className="rounded-lg font-mono"
                />
              </>
            )}
            {(modelCatalog.length > 0 || extraLiveIds.length > 0) && (
              <ModelToolsLegend className="mt-1.5" />
            )}
            {coherenceBanner}
          </div>
        </div>

        <div>
          <label className="block text-xs text-ink-3 mb-1" htmlFor="agent-role">
            Role
          </label>
          <Select
            id="agent-role"
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
            className="rounded-lg"
          >
            <option value="worker">Worker (runs its own tools and tasks)</option>
            <option value="router">Router (delegates to one sub-agent at a time)</option>
            <option value="planner">Planner (creates parallel tasks for sub-agents)</option>
          </Select>
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
                    <Checkbox
                      key={a.id}
                      tone="agent"
                      checked={checked}
                      onChange={() => toggleSubAgent(a.id)}
                      containerClassName="px-3 py-2 hover:bg-hover/80"
                      label={
                        <>
                          <span className="text-ink">{a.name}</span>
                          <span className="ml-auto font-mono text-xs text-ink-3">{a.slug}</span>
                        </>
                      }
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}
      </form>
    </Modal>
  );

  return (
    <>
      {props.renderTrigger ? (
        props.renderTrigger(() => setOpen(true))
      ) : (
        <PrimaryButton variant="agent" onClick={() => setOpen(true)}>
          <Plus size={13} weight="bold" />
          New agent
        </PrimaryButton>
      )}
      {modal}
    </>
  );
}
