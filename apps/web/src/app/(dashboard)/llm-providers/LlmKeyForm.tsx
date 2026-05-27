'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  createLlmKeyAction,
  updateLlmKeyAction,
  testLlmKeyAction,
  type LlmKeyUiRow,
  type LlmProvider,
} from '@/lib/actions.ts';
import { prettyProviderName } from '@/lib/provider-names.ts';

// Inline preset table — packages/llm is server-only, so we can't import its
// PROVIDER_PRESETS map into a client component. Canonical URLs shown as
// placeholders so users have a known-good default to start from. Cloud
// providers can leave the field blank (server falls back to canonical);
// openai-compatible and ollama require a value.
const BASE_URL_PRESETS: Record<LlmProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'http://localhost:1234/v1',
  ollama: 'http://localhost:11434',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
};

const DEFAULT_MODEL_PRESETS: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5',
  'openai-compatible': 'google/gemma-4-31b',
  ollama: 'llama3.3:70b',
  openrouter: 'anthropic/claude-3.5-sonnet',
  google: 'gemini-2.0-flash',
  mistral: 'mistral-large-latest',
  groq: 'llama-3.3-70b-versatile',
};

const PROVIDER_OPTIONS: LlmProvider[] = [
  'anthropic',
  'openai',
  'openai-compatible',
  'ollama',
  'openrouter',
  'google',
  'mistral',
  'groq',
];

interface CreateProps {
  mode: 'create';
  onDone: (action: 'saved' | 'cancelled') => void;
}

interface EditProps {
  mode: 'edit';
  initial: LlmKeyUiRow;
  onDone: (action: 'saved' | 'cancelled') => void;
}

type Props = CreateProps | EditProps;

type TestResult =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'pass'; message: string }
  | { state: 'fail'; message: string };

// Shared field chrome classes
const labelCls = 'block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-4 mb-1.5';
const inputCls =
  'w-full rounded-lg border border-rule bg-canvas px-3 py-2 text-[13px] text-ink placeholder-ink-4 transition-colors focus:border-ink-3 focus:outline-none';
const inputMonoCls = `${inputCls} font-mono`;

export default function LlmKeyForm(props: Props) {
  const isEdit = props.mode === 'edit';
  const initial = isEdit ? props.initial : null;

  const [provider, setProvider] = useState<LlmProvider>(
    (initial?.provider as LlmProvider | undefined) ?? 'anthropic',
  );
  const [baseUrl, setBaseUrl] = useState<string>(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState<string>('');
  const [nickname, setNickname] = useState<string>(initial?.nickname ?? '');
  const [defaultModel, setDefaultModel] = useState<string>(initial?.defaultModel ?? '');
  const [isActive, setIsActive] = useState<boolean>(initial?.isActive ?? true);
  const [testResult, setTestResult] = useState<TestResult>({ state: 'idle' });
  const [isPending, startTransition] = useTransition();
  // In edit mode, start in "masked" state if the key is already stored.
  const [replacingApiKey, setReplacingApiKey] = useState<boolean>(false);

  // Edit mode + no new apiKey entered: test is optional (key unchanged).
  const apiKeyUntouched = isEdit && apiKey.length === 0;
  // Whether the saved key is being displayed in masked form (not yet replacing).
  const showMasked =
    isEdit && initial?.apiKeyLast4 != null && !replacingApiKey && apiKey.length === 0;

  // Reset test result when relevant fields change — the previous test was
  // against different inputs.
  function markStale() {
    if (testResult.state !== 'idle') setTestResult({ state: 'idle' });
  }

  function handleProviderChange(next: LlmProvider) {
    setProvider(next);
    // Suggest a sensible baseUrl when there's no value yet
    if (!baseUrl && BASE_URL_PRESETS[next]) {
      setBaseUrl(BASE_URL_PRESETS[next]);
    }
    if (!defaultModel) {
      setDefaultModel(DEFAULT_MODEL_PRESETS[next]);
    }
    markStale();
  }

  async function handleTest() {
    setTestResult({ state: 'testing' });
    // In edit mode with no new key typed (and a saved key exists), pass keyId
    // so the server can look up the saved key without echoing it to the client.
    const useKeyId = isEdit && apiKey.length === 0 && initial?.id;
    const r = await testLlmKeyAction({
      provider,
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      model: defaultModel || undefined,
      ...(useKeyId ? { keyId: initial.id } : {}),
    });
    if (r.ok) {
      setTestResult({ state: 'pass', message: r.data.message });
    } else {
      setTestResult({ state: 'fail', message: r.message });
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    // Block save unless the test passed, OR (edit mode and apiKey untouched).
    if (testResult.state !== 'pass' && !apiKeyUntouched) {
      toast.error('Test the connection before saving');
      return;
    }

    startTransition(async () => {
      if (isEdit && initial) {
        const r = await updateLlmKeyAction({
          id: initial.id,
          provider,
          baseUrl: baseUrl || undefined,
          apiKey: apiKey || undefined,
          nickname,
          defaultModel,
          isActive,
        });
        if (!r.ok) {
          toast.error(r.message);
          return;
        }
        toast.success('LLM provider updated');
        props.onDone('saved');
      } else {
        const r = await createLlmKeyAction({
          provider,
          baseUrl: baseUrl || undefined,
          apiKey: apiKey || undefined,
          nickname,
          defaultModel,
          isActive,
        });
        if (!r.ok) {
          toast.error(r.message);
          return;
        }
        toast.success('LLM provider added');
        props.onDone('saved');
      }
    });
  }

  const baseUrlPlaceholder = BASE_URL_PRESETS[provider] || 'https://...';

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-2xl border border-rule-2 bg-paper p-5"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="llm-provider">
            Provider
          </label>
          <select
            id="llm-provider"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as LlmProvider)}
            className={inputCls}
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {prettyProviderName(p)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="llm-nickname">
            Nickname
          </label>
          <input
            id="llm-nickname"
            type="text"
            required
            value={nickname}
            onChange={(e) => {
              setNickname(e.target.value);
            }}
            placeholder={`${prettyProviderName(provider)} main`}
            className={inputCls}
          />
        </div>
      </div>

      <div>
        <label className={labelCls} htmlFor="llm-base-url">
          Base URL
          {provider === 'openai-compatible' || provider === 'ollama' ? (
            <span className="ml-2 normal-case font-sans text-[11px] tracking-normal text-warn">
              required
            </span>
          ) : (
            <span className="ml-2 normal-case font-sans text-[11px] tracking-normal text-ink-4">
              optional
            </span>
          )}
        </label>
        <input
          id="llm-base-url"
          type="text"
          required={provider === 'openai-compatible' || provider === 'ollama'}
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            markStale();
          }}
          placeholder={baseUrlPlaceholder || 'leave blank to use the provider default'}
          className={inputMonoCls}
        />
      </div>

      <div>
        <label className={labelCls} htmlFor="llm-api-key">
          API key
        </label>
        {showMasked ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[13px] tracking-widest text-ink-3 select-none">
              {'••••••••'}
              {initial.apiKeyLast4}
            </div>
            <button
              type="button"
              onClick={() => {
                setReplacingApiKey(true);
                markStale();
              }}
              className="shrink-0 rounded-md border border-rule px-3 py-2 text-[12px] font-medium text-ink-3 transition-colors hover:border-ink-3 hover:text-ink"
            >
              Replace
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              id="llm-api-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                markStale();
              }}
              placeholder={isEdit && !replacingApiKey ? 'Leave blank to keep current' : ''}
              className={`flex-1 rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[13px] text-ink placeholder-ink-4 transition-colors focus:border-ink-3 focus:outline-none`}
            />
            {isEdit && replacingApiKey && (
              <button
                type="button"
                onClick={() => {
                  setReplacingApiKey(false);
                  setApiKey('');
                  markStale();
                }}
                className="shrink-0 px-3 py-2 text-[12px] font-medium text-ink-4 transition-colors hover:text-ink-2"
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      <div>
        <label className={labelCls} htmlFor="llm-default-model">
          Default model
        </label>
        <input
          id="llm-default-model"
          type="text"
          required
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder={DEFAULT_MODEL_PRESETS[provider]}
          className={inputMonoCls}
        />
        <p className="mt-1.5 text-[11px] leading-[1.4] text-ink-4">
          Agents reference this provider and pick their own model on top — this is just the
          suggested default.
        </p>
      </div>

      <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-2">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="accent-conn-vivid"
        />
        <span>Active — agents may select this provider</span>
      </label>

      {/* Test result inline */}
      {testResult.state === 'pass' && (
        <div className="rounded-md border border-ok/30 bg-ok-bg px-3 py-2 text-[12px] text-ok">
          {testResult.message}
        </div>
      )}
      {testResult.state === 'fail' && (
        <div className="rounded-md border border-err/30 bg-warn-bg px-3 py-2 text-[12px] text-err break-all">
          {testResult.message}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleTest}
          disabled={testResult.state === 'testing' || isPending}
          className="inline-flex h-[34px] items-center rounded-md border border-rule px-3.5 text-[13px] font-medium text-ink-2 transition-colors hover:border-rule-2 hover:text-ink disabled:opacity-50"
        >
          {testResult.state === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="submit"
          disabled={
            isPending ||
            testResult.state === 'testing' ||
            (testResult.state !== 'pass' && !apiKeyUntouched)
          }
          className="inline-flex h-[34px] items-center rounded-md bg-ink px-3.5 text-[13px] font-semibold text-canvas transition-[filter] hover:brightness-[0.92] disabled:opacity-50"
          title={
            testResult.state !== 'pass' && !apiKeyUntouched
              ? 'Test the connection before saving'
              : undefined
          }
        >
          {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add provider'}
        </button>
        <button
          type="button"
          onClick={() => props.onDone('cancelled')}
          className="inline-flex h-[34px] items-center px-3.5 text-[13px] font-medium text-ink-3 transition-colors hover:text-ink-2"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
