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
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import TextInput from '@/components/ui/TextInput';
import Select from '@/components/ui/Select';
import Checkbox from '@/components/ui/Checkbox';

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
  deepseek: 'https://api.deepseek.com/v1',
  minimax: 'https://api.minimax.io/anthropic',
  moonshot: 'https://api.moonshot.ai/v1',
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
  'deepseek',
  'minimax',
  'moonshot',
];

interface CreateProps {
  mode: 'create';
  /** Providers that already have a key configured — excluded from the select. */
  configuredProviders: string[];
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
const labelCls = 'block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-4 mb-1.5';
const inputCls =
  'w-full rounded-lg border border-rule bg-canvas px-3 py-2 text-[14px] text-ink placeholder-ink-4 transition-colors focus:border-ink-3 focus:outline-none';

export default function LlmKeyForm(props: Props) {
  const isEdit = props.mode === 'edit';
  const initial = isEdit ? props.initial : null;

  const initialProvider = (initial?.provider as LlmProvider | undefined) ?? 'anthropic';

  // In create mode, filter out already-configured providers.
  const availableProviders =
    props.mode === 'create'
      ? PROVIDER_OPTIONS.filter((p) => !props.configuredProviders.includes(p))
      : PROVIDER_OPTIONS;

  // Default to first available provider in create mode.
  const defaultProvider: LlmProvider =
    props.mode === 'create' ? (availableProviders[0] ?? 'anthropic') : initialProvider;

  const [provider, setProvider] = useState<LlmProvider>(defaultProvider);
  const [baseUrl, setBaseUrl] = useState<string>(initial?.baseUrl ?? '');
  // É-3: optional context window for a custom/local model. Kept as a string for
  // the text input; blank ⇒ auto-detect at save (LM Studio etc.) or fall back.
  const [contextWindow, setContextWindow] = useState<string>(
    initial?.contextWindow != null ? String(initial.contextWindow) : '',
  );
  const [apiKey, setApiKey] = useState<string>('');
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
    markStale();
  }

  async function handleTest() {
    setTestResult({ state: 'testing' });
    // In edit mode with no new key typed (and a saved key exists), pass keyId
    // so the server can look up the saved key without echoing it to the client.
    const useKeyId = isEdit && apiKey.length === 0 && initial?.id;

    const connResult = await testLlmKeyAction({
      provider,
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      ...(useKeyId ? { keyId: initial.id } : {}),
    });

    if (!connResult.ok) {
      setTestResult({ state: 'fail', message: connResult.message });
      return;
    }

    setTestResult({ state: 'pass', message: connResult.data.message });
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    // Block save unless the test passed, OR (edit mode and apiKey untouched).
    if (testResult.state !== 'pass' && !apiKeyUntouched) {
      toast.error('Test the connection before saving');
      return;
    }

    startTransition(async () => {
      const cwTrimmed = contextWindow.trim();
      const cwValue = cwTrimmed.length > 0 ? Number(cwTrimmed) : undefined;
      if (isEdit && initial) {
        const r = await updateLlmKeyAction({
          id: initial.id,
          provider,
          baseUrl: baseUrl || undefined,
          apiKey: apiKey || undefined,
          contextWindow: cwValue,
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
          contextWindow: cwValue,
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
          {isEdit ? (
            // In edit mode the provider is fixed.
            <div className={`${inputCls} cursor-not-allowed bg-hover text-ink-3`}>
              {prettyProviderName(provider)}
            </div>
          ) : availableProviders.length === 0 ? (
            <p className="text-[13px] text-warn">
              All providers already configured. Edit an existing key instead.
            </p>
          ) : (
            <Select
              id="llm-provider"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as LlmProvider)}
            >
              {availableProviders.map((p) => (
                <option key={p} value={p}>
                  {prettyProviderName(p)}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>

      <div>
        <label className={labelCls} htmlFor="llm-base-url">
          Base URL
          {provider === 'openai-compatible' || provider === 'ollama' ? (
            <span className="ml-2 normal-case font-sans text-[12px] tracking-normal text-warn">
              required
            </span>
          ) : (
            <span className="ml-2 normal-case font-sans text-[12px] tracking-normal text-ink-4">
              optional
            </span>
          )}
        </label>
        <TextInput
          id="llm-base-url"
          type="text"
          required={provider === 'openai-compatible' || provider === 'ollama'}
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            markStale();
          }}
          placeholder={baseUrlPlaceholder || 'leave blank to use the provider default'}
          className="font-mono"
        />
      </div>

      {(provider === 'openai-compatible' || provider === 'ollama') && (
        <div>
          <label className={labelCls} htmlFor="llm-context-window">
            Context window
            <span className="ml-2 normal-case font-sans text-[12px] tracking-normal text-ink-4">
              optional
            </span>
          </label>
          <TextInput
            id="llm-context-window"
            type="number"
            min={1}
            step={1}
            value={contextWindow}
            onChange={(e) => setContextWindow(e.target.value)}
            placeholder="auto-detected — e.g. 8192"
            className="font-mono"
          />
          <p className="mt-1.5 text-[12px] text-ink-4">
            The model&rsquo;s maximum context in tokens. Leave blank to auto-detect it from the
            endpoint (LM Studio); set it by hand if detection fails. Used to compact long
            conversations before the model overflows.
          </p>
        </div>
      )}

      <div>
        <label className={labelCls} htmlFor="llm-api-key">
          API key
        </label>
        {showMasked ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-lg border border-rule bg-canvas px-3 py-2 font-mono text-[14px] tracking-widest text-ink-3 select-none">
              {'••••••••'}
              {initial.apiKeyLast4}
            </div>
            <RowActionButton
              onClick={() => {
                setReplacingApiKey(true);
                markStale();
              }}
            >
              Replace
            </RowActionButton>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <TextInput
              id="llm-api-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                markStale();
              }}
              placeholder={isEdit && !replacingApiKey ? 'Leave blank to keep current' : ''}
              containerClassName="flex-1"
              className="font-mono"
            />
            {isEdit && replacingApiKey && (
              <RowActionButton
                onClick={() => {
                  setReplacingApiKey(false);
                  setApiKey('');
                  markStale();
                }}
              >
                Cancel
              </RowActionButton>
            )}
          </div>
        )}
      </div>

      <Checkbox
        tone="connector"
        checked={isActive}
        onChange={(e) => setIsActive(e.target.checked)}
        label="Active — agents may select this provider"
      />

      {/* Test result inline */}
      {testResult.state === 'pass' && (
        <div className="rounded-md border border-ok/30 bg-ok-bg px-3 py-2 text-[13px] text-ok">
          {testResult.message}
        </div>
      )}
      {testResult.state === 'fail' && (
        <div className="rounded-md border border-err/30 bg-warn-bg px-3 py-2 text-[13px] text-err break-all">
          {testResult.message}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <PrimaryButton
          variant="neutral"
          type="button"
          onClick={handleTest}
          disabled={testResult.state === 'testing' || isPending}
        >
          {testResult.state === 'testing' ? 'Testing…' : 'Test connection'}
        </PrimaryButton>
        <PrimaryButton
          variant="ink"
          type="submit"
          disabled={
            isPending ||
            testResult.state === 'testing' ||
            (testResult.state !== 'pass' && !apiKeyUntouched)
          }
          title={
            testResult.state !== 'pass' && !apiKeyUntouched
              ? 'Test the connection before saving'
              : undefined
          }
        >
          {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add provider'}
        </PrimaryButton>
        <PrimaryButton variant="neutral" type="button" onClick={() => props.onDone('cancelled')}>
          Cancel
        </PrimaryButton>
      </div>
    </form>
  );
}
