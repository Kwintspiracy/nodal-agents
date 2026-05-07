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
// PROVIDER_PRESETS map into a client component. The values mirror the cloud
// providers' canonical base-URLs and the local-LLM defaults.
const BASE_URL_PRESETS: Record<LlmProvider, string> = {
  anthropic: '',
  openai: '',
  'openai-compatible': 'http://localhost:1234/v1',
  ollama: 'http://localhost:11434',
  openrouter: 'https://openrouter.ai/api/v1',
  google: '',
  mistral: '',
  groq: '',
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

  // Edit mode + no new apiKey entered: test is optional (key unchanged).
  const apiKeyUntouched = isEdit && apiKey.length === 0;

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
    const r = await testLlmKeyAction({
      provider,
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      model: defaultModel || undefined,
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
      className="space-y-4 bg-neutral-950/40 border border-neutral-800/40 rounded-lg p-4"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="llm-provider">
            Provider
          </label>
          <select
            id="llm-provider"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as LlmProvider)}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {prettyProviderName(p)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="llm-nickname">
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
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-neutral-500 mb-1" htmlFor="llm-base-url">
          Base URL
          {!baseUrlPlaceholder && (
            <span className="ml-2 text-neutral-600">(optional for cloud providers)</span>
          )}
        </label>
        <input
          id="llm-base-url"
          type="text"
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            markStale();
          }}
          placeholder={baseUrlPlaceholder || 'leave blank to use the provider default'}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
        />
      </div>

      <div>
        <label className="block text-xs text-neutral-500 mb-1" htmlFor="llm-api-key">
          API key
        </label>
        <input
          id="llm-api-key"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            markStale();
          }}
          placeholder={isEdit ? 'Leave blank to keep current' : ''}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
        />
      </div>

      <div>
        <label className="block text-xs text-neutral-500 mb-1" htmlFor="llm-default-model">
          Default model
        </label>
        <input
          id="llm-default-model"
          type="text"
          required
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder={DEFAULT_MODEL_PRESETS[provider]}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
        />
        <p className="mt-1 text-[11px] text-neutral-600">
          Agents reference this provider and pick their own model on top — this is just the
          suggested default.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-neutral-300 cursor-pointer">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="accent-violet-500"
        />
        <span>Active — agents may select this provider</span>
      </label>

      {/* Test result inline */}
      {testResult.state === 'pass' && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3 py-2 text-xs text-emerald-300">
          {testResult.message}
        </div>
      )}
      {testResult.state === 'fail' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2 text-xs text-red-300 break-all">
          {testResult.message}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleTest}
          disabled={testResult.state === 'testing' || isPending}
          className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-300 rounded-lg hover:border-neutral-600 hover:text-white transition-colors disabled:opacity-50"
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
          className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors disabled:opacity-50"
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
          className="px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
