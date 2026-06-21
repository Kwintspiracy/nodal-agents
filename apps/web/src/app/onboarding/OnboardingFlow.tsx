'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { MODEL_CATALOG, groupModelCatalog } from '@nodal-agents/shared';
import {
  createLlmKeyAction,
  updateLlmKeyAction,
  listLlmKeysAction,
  testLlmKeyAction,
  createAgentAction,
  listSkillsAction,
  assignSkillAction,
  createConversationAction,
  sendChatMessageAction,
  createMemoryAction,
  setWorkspaceTimezoneAction,
} from '@/lib/actions.ts';

/**
 * OnboardingFlow — the dedicated, full-screen first-run experience.
 *
 * NOT a dashboard widget: a brand-new install is redirected here (see the
 * dashboard layout) and walked through, step by step, until they have a
 * working agent. Steps:
 *   0. Welcome
 *   1. Connect a model (provider + key + test + pick a supported model)
 *   2. Create your first agent (name + personality + model)
 *   3. You're set — meet your agent
 *
 * The chrome is deliberately bare (no sidebar, no stats) so the flow has the
 * user's full attention.
 */

type ProviderValue =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'google'
  | 'mistral'
  | 'groq'
  | 'deepseek'
  | 'minimax'
  | 'openai-compatible'
  | 'ollama';

interface ProviderPreset {
  value: ProviderValue;
  label: string;
  baseUrl: string;
  needsKey: boolean;
}

const PROVIDERS: ProviderPreset[] = [
  {
    value: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
  },
  {
    value: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
  },
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { value: 'google', label: 'Google (Gemini)', baseUrl: '', needsKey: true },
  { value: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', needsKey: true },
  { value: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', needsKey: true },
  { value: 'minimax', label: 'MiniMax', baseUrl: '', needsKey: true },
  { value: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434', needsKey: false },
  {
    value: 'openai-compatible',
    label: 'Local / OpenAI-compatible (LM Studio, vLLM…)',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
  },
];

// Only the models whose harness we've added + tested — sourced from the curated
// MODEL_CATALOG (NOT the provider's raw model list) — sorted alphabetically.
// Local providers (ollama / openai-compatible) have no catalog → free-text.
function catalogModelsFor(p: ProviderValue): Array<{ modelId: string; label: string }> {
  return [...(MODEL_CATALOG[p] ?? [])]
    .map((m) => ({ modelId: m.modelId, label: m.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// A new agent ships with these behavioural disciplines attached, so it has real
// codes of conduct out of the box rather than just a freeform personality.
const BASE_CONDUCT_SKILLS = [
  'safe-tool-use',
  'verify-before-done',
  'task-planning',
  'language-mirror',
  'markdown-output',
];

// A substantive, structured default identity (slot #1 of the system prompt) —
// not a one-line "helpful assistant". The user edits this to taste.
const DEFAULT_PERSONALITY = `You are a capable personal AI agent working directly for your user inside Nodal-Agents.

# Who you are
Proactive, resourceful, and honest. You own a task end to end: work out what's needed, use your tools, and deliver a concrete result instead of just describing one.

# How you communicate
Clear and concise. Mirror the user's language and tone. Lead with the answer or the result, then the detail — no filler, no flattery. When you're unsure, say so plainly.

# What you avoid
Never claim to have done something you haven't. Don't guess at irreversible actions. Don't pad. Don't expose secrets or internal IDs unless asked.

# Defaults under ambiguity
If a request is ambiguous, ask one sharp clarifying question rather than guessing — unless the obvious reading is safe and reversible, in which case proceed and state what you assumed.`;

// ── Welcome interview (step 4) ──────────────────────────────────────────────
const DONE_MARKER = '[[INTERVIEW_DONE]]';

// The six things to capture, in order. The WEB saves the user's answers to
// memory: the chat surface only exposes run_task to the agent, so it can't call
// save_memory itself there. Index = number of answers the user has given.
const INTERVIEW_MEMORY: Array<{ prefix: string; category: 'context' | 'preference' }> = [
  { prefix: 'Operator — what to call them:', category: 'context' },
  { prefix: 'Operator — preferred language:', category: 'preference' },
  { prefix: 'Operator — where they are based:', category: 'context' },
  { prefix: 'Operator — goal with Nodal-Agents / where they want help:', category: 'context' },
  { prefix: 'How the operator wants to work together:', category: 'preference' },
];

// Hidden first message that drives the interview. The agent generates ALL of the
// wording; the web only sends this instruction and strips the DONE marker — so
// the runner stays silent (invariant 2). SHORT, plain text, one concrete
// question at a time, strictly NO task execution.
const INTERVIEW_KICKOFF = `[Onboarding — your first meeting with your operator. Run a warm, BRIEF get-acquainted chat. Hard rules:
- Plain text ONLY. No markdown, no **bold**, no bullet points, no headings.
- Every message is 1-2 SHORT sentences. Warm but concise.
- Ask ONE short, concrete question per message. Never vague, never multi-part.
- This is NOT a work session: do NOT start, plan, or build anything. If they mention a task, warmly say you'll be ready once they're set up, then move on.

Ask these FIVE things, in order, one per message, no extras:
1. What to call them.
2. Which language they'd like you to speak — ask openly; do NOT suggest or list specific languages (never "French or English?"). Any language in the world is fine.
3. Where they're based.
4. Their goal with Nodal-Agents and where you can help most — just the gist, not specifics (you're not doing it now).
5. When working on a task, whether you should take initiative or stick to exactly what they ask.

Start now: one short friendly line (you just want to get to know them, no work yet) + question 1 ONLY. After each answer, a 3-5 word acknowledgement at most, then the next question. After the FIFTH answer, one short warm wrap-up line and end that final message with ${DONE_MARKER} on its own line.]`;

const TOTAL_STEPS = 6;

export default function OnboardingFlow() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [shown, setShown] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishTarget, setFinishTarget] = useState('/');
  const [barFilled, setBarFilled] = useState(false);

  // Capture the user's timezone from the browser once, at the start of onboarding.
  // The browser is the only place that reliably knows the user's zone; we store it
  // on the workspace so the agent reads the correct local time and schedules crons
  // in it — even if the server runs in a different zone.
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) void setWorkspaceTimezoneAction({ timezone: tz });
    } catch {
      /* ignore — falls back to server zone */
    }
  }, []);

  // Pop the success state in when we land on the final step.
  useEffect(() => {
    if (step !== 3) {
      setShown(false);
      return undefined;
    }
    const t = setTimeout(() => setShown(true), 30);
    return () => clearTimeout(t);
  }, [step]);

  // Kick off the branded "Entering Nodal-Agents" overlay; the effect below runs
  // the progress animation and then navigates.
  function finish(target: string) {
    setFinishTarget(target);
    setFinishing(true);
  }

  // Play the full-screen entrance animation, then do a real browser navigation
  // (NOT router.push — the dashboard is a cold compile in dev and a client
  // transition hangs blank). The overlay stays up across the nav so the user
  // sees a deliberate "entering" moment, never a blank screen.
  useEffect(() => {
    if (!finishing) return undefined;
    const t1 = setTimeout(() => setBarFilled(true), 60);
    const t2 = setTimeout(() => {
      window.location.href = finishTarget;
    }, 2200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [finishing, finishTarget]);

  // ── Step 1 — LLM provider + model ──────────────────────────────────────
  const [provider, setProvider] = useState<ProviderPreset>(PROVIDERS[0]!);
  const [baseUrl, setBaseUrl] = useState(PROVIDERS[0]!.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(catalogModelsFor(PROVIDERS[0]!.value)[0]?.modelId ?? '');
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [keyError, setKeyError] = useState('');

  // ── Step 2 — agent ─────────────────────────────────────────────────────
  const [agentName, setAgentName] = useState('');
  const [personality, setPersonality] = useState(DEFAULT_PERSONALITY);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);

  // ── Step 4 — welcome interview ─────────────────────────────────────────
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Array<{ role: 'agent' | 'user'; text: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [answerCount, setAnswerCount] = useState(0);
  const [interviewStarted, setInterviewStarted] = useState(false);
  const [interviewDone, setInterviewDone] = useState(false);
  const [chatError, setChatError] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Keep the transcript pinned to the newest message.
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [msgs, chatBusy]);

  const catalogModels = catalogModelsFor(provider.value);

  function pickProvider(value: string) {
    const p = PROVIDERS.find((x) => x.value === value) ?? PROVIDERS[0]!;
    setProvider(p);
    setBaseUrl(p.baseUrl);
    setTestState('idle');
    setTestMsg('');
    setModel(catalogModelsFor(p.value)[0]?.modelId ?? '');
  }

  async function handleTest() {
    setTestState('testing');
    setTestMsg('');
    const res = await testLlmKeyAction({
      provider: provider.value,
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
    });
    if (res.ok) {
      setTestState('ok');
      setTestMsg(res.data.message);
    } else {
      setTestState('fail');
      setTestMsg(res.message);
    }
  }

  async function handleSaveKeyAndContinue() {
    setKeyError('');
    if (provider.needsKey && !apiKey.trim()) {
      setKeyError('This provider needs an API key.');
      return;
    }
    if (!model.trim()) {
      setKeyError('Pick or type a model.');
      return;
    }
    setSavingKey(true);

    // Upsert: a key for this provider may already exist — the runner auto-seeds
    // an env-derived key on boot, or the user clicked Continue then came Back.
    // Update it instead of failing on the unique-provider constraint (which also
    // makes Continue → Back → Continue idempotent).
    let existingId = keyId;
    if (!existingId) {
      const list = await listLlmKeysAction();
      if (list.ok) existingId = list.data.find((k) => k.provider === provider.value)?.id ?? null;
    }

    if (existingId) {
      const res = await updateLlmKeyAction({
        id: existingId,
        provider: provider.value,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
        isActive: true,
      });
      setSavingKey(false);
      if (!res.ok) {
        setKeyError(res.message);
        return;
      }
      setKeyId(existingId);
    } else {
      const res = await createLlmKeyAction({
        provider: provider.value,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
        isActive: true,
      });
      setSavingKey(false);
      if (!res.ok) {
        setKeyError(res.message);
        return;
      }
      setKeyId(res.data.id);
    }
    setStep(2);
  }

  async function handleCreateAgent() {
    setAgentError('');
    const name = agentName.trim();
    if (!name) {
      setAgentError('Give your agent a name.');
      return;
    }
    if (!model.trim()) {
      setAgentError('Pick or type a model.');
      return;
    }
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    setCreatingAgent(true);
    const res = await createAgentAction({
      slug: slug || 'my-agent',
      name,
      personality: personality.trim(),
      model: model.trim(),
      llmKeyId: keyId ?? undefined,
      role: 'router',
    });
    if (!res.ok) {
      setCreatingAgent(false);
      setAgentError(res.message);
      return;
    }
    setAgentId(res.data.id);
    // Attach the base codes of conduct so the agent is substantive out of the
    // box. Best-effort: a failed attach shouldn't block finishing onboarding.
    const skillsRes = await listSkillsAction();
    if (skillsRes.ok) {
      const toAttach = skillsRes.data.filter((s) => BASE_CONDUCT_SKILLS.includes(s.slug));
      // Sequential (not Promise.all): a burst of 5 concurrent assigns right after
      // create + the dashboard's own queries can spike the dev DB connection pool.
      for (const s of toAttach) {
        await assignSkillAction({ skillId: s.id, agentId: res.data.id });
      }
    }
    setCreatingAgent(false);
    // An agent now exists (agentCount > 0), so the dashboard route will actually
    // render instead of redirecting back to onboarding — prefetch it now so it
    // compiles (dev/Turbopack) while the user watches the success animation,
    // making the final transition smooth instead of a blank "rendering" screen.
    router.prefetch('/');
    router.prefetch('/chat');
    setStep(3);
  }

  // Strip the control marker, render the agent's text, and flip to "done" so the
  // Telegram step appears.
  function pushAgentReply(raw: string) {
    const done = raw.includes(DONE_MARKER);
    const text = raw.replaceAll(DONE_MARKER, '').trim();
    if (text) setMsgs((m) => [...m, { role: 'agent', text }]);
    if (done) setInterviewDone(true);
  }

  // On reaching step 4: open a conversation and send the hidden kickoff so the
  // agent greets + asks question 1.
  useEffect(() => {
    if (step !== 4 || interviewStarted) return;
    setInterviewStarted(true);
    void (async () => {
      setChatError('');
      setChatBusy(true);
      const conv = await createConversationAction();
      if (!conv.ok) {
        setChatBusy(false);
        setChatError('Could not start the conversation — you can skip to the dashboard below.');
        return;
      }
      setConversationId(conv.data.id);
      const reply = await sendChatMessageAction({
        conversationId: conv.data.id,
        message: INTERVIEW_KICKOFF,
      });
      setChatBusy(false);
      if (!reply.ok) {
        setChatError(
          reply.message ||
            'Your agent could not reply (check the model in Settings). You can skip to the dashboard.',
        );
        return;
      }
      pushAgentReply(reply.data.reply);
    })();
  }, [step, interviewStarted]);

  async function sendAnswer() {
    const answer = chatInput.trim();
    if (!answer || !conversationId || chatBusy) return;
    setChatInput('');
    setMsgs((m) => [...m, { role: 'user', text: answer }]);

    // Persist the answer to memory (web-side: the chat surface gives the agent
    // only run_task, so it can't save_memory itself here).
    const slot = INTERVIEW_MEMORY[answerCount];
    if (slot) {
      void createMemoryAction({ fact: `${slot.prefix} ${answer}`, category: slot.category });
    }
    setAnswerCount((n) => n + 1);

    setChatBusy(true);
    const reply = await sendChatMessageAction({ conversationId, message: answer });
    setChatBusy(false);
    if (!reply.ok) {
      setChatError(reply.message || 'Your agent could not reply just now.');
      return;
    }
    pushAgentReply(reply.data.reply);
  }

  // Shared model picker: curated models grouped by LLM family (optgroups) so the
  // different vendors are visually separated — e.g. for OpenRouter, Claude /
  // DeepSeek / Gemini / MiniMax each get their own labelled group. Groups and
  // models are alphabetically sorted (by groupModelCatalog). Free-text when the
  // provider has no catalog (local servers).
  function ModelField() {
    const entries = MODEL_CATALOG[provider.value] ?? [];
    if (entries.length === 0) {
      return (
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="e.g. llama3.2 — type your local model name"
          className="mt-1.5 w-full rounded-md border border-rule-2 bg-canvas px-3 py-2 text-[13.5px] text-ink"
        />
      );
    }
    const groups = groupModelCatalog(entries);
    return (
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="mt-1.5 w-full rounded-md border border-rule-2 bg-canvas px-3 py-2 text-[13.5px] text-ink"
      >
        {groups.map((g, gi) =>
          g.group ? (
            <optgroup key={g.group} label={g.group}>
              {g.models.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ) : (
            g.models.map((m) => (
              <option key={`${gi}-${m.modelId}`} value={m.modelId}>
                {m.label}
              </option>
            ))
          ),
        )}
      </select>
    );
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-7 flex items-center justify-center gap-2">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? 'w-7 bg-ink' : i < step ? 'w-1.5 bg-ink' : 'w-1.5 bg-rule-2'
              }`}
            />
          ))}
        </div>

        <div className="rounded-2xl border border-rule-2 bg-paper px-7 py-8 shadow-sm">
          {step === 0 && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-ink text-[22px] text-canvas">
                ◆
              </div>
              <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
                Welcome to Nodal-Agents
              </h1>
              <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-[1.6] text-ink-3">
                Let&apos;s set up your first AI agent. It takes about a minute: connect a model,
                give your agent a personality, and say hello.
              </p>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="mt-6 inline-flex h-[38px] items-center justify-center rounded-md bg-ink px-5 text-[13.5px] font-medium text-canvas transition-[filter] hover:brightness-[0.92]"
              >
                Get started →
              </button>
            </div>
          )}

          {step === 1 && (
            <div>
              <StepHeader
                n={1}
                title="Connect a model"
                sub="The brain your agent thinks with. Your key stays on this machine."
              />

              <label className="mt-5 block text-[12px] font-medium text-ink-3">Provider</label>
              <select
                value={provider.value}
                onChange={(e) => pickProvider(e.target.value)}
                className="mt-1.5 w-full rounded-md border border-rule-2 bg-canvas px-3 py-2 text-[13.5px] text-ink"
              >
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>

              <label className="mt-4 block text-[12px] font-medium text-ink-3">Model</label>
              <ModelField />
              {catalogModels.length > 0 && (
                <p className="mt-1.5 text-[11.5px] text-ink-4">
                  {catalogModels.length} supported models for {provider.label}.
                </p>
              )}

              <label className="mt-4 block text-[12px] font-medium text-ink-3">Base URL</label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://…"
                className="mt-1.5 w-full rounded-md border border-rule-2 bg-canvas px-3 py-2 text-[13.5px] text-ink"
              />

              <label className="mt-4 block text-[12px] font-medium text-ink-3">
                API key {provider.needsKey ? '' : '(optional for local)'}
              </label>
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type="password"
                placeholder={provider.needsKey ? 'sk-…' : 'leave blank for local'}
                className="mt-1.5 w-full rounded-md border border-rule-2 bg-canvas px-3 py-2 text-[13.5px] text-ink"
              />

              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testState === 'testing'}
                  className="inline-flex h-[34px] items-center rounded-md border border-rule-2 bg-canvas px-3.5 text-[13px] font-medium text-ink transition-colors hover:border-ink disabled:opacity-50"
                >
                  {testState === 'testing' ? 'Connecting…' : 'Test connection'}
                </button>
                {testState === 'ok' && (
                  <span className="text-[12.5px] font-medium text-lime-600">✓ {testMsg}</span>
                )}
                {testState === 'fail' && (
                  <span className="text-[12.5px] font-medium text-warn">{testMsg}</span>
                )}
              </div>

              {keyError && <p className="mt-3 text-[12.5px] text-warn">{keyError}</p>}

              <div className="mt-6 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep(0)}
                  className="text-[13px] text-ink-3 hover:text-ink"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={handleSaveKeyAndContinue}
                  disabled={savingKey}
                  className="inline-flex h-[38px] items-center justify-center rounded-md bg-ink px-5 text-[13.5px] font-medium text-canvas transition-[filter] hover:brightness-[0.92] disabled:opacity-50"
                >
                  {savingKey ? 'Saving…' : 'Continue →'}
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <StepHeader
                n={2}
                title="Create your agent"
                sub="A name and a personality. It also ships with built-in codes of conduct (safe tool use, verify before done, task planning…)."
              />

              <label className="mt-5 block text-[12px] font-medium text-ink-3">Name</label>
              <input
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="e.g. Friday"
                className="mt-1.5 w-full rounded-md border border-rule-2 bg-canvas px-3 py-2 text-[13.5px] text-ink"
              />

              <label className="mt-4 block text-[12px] font-medium text-ink-3">Personality</label>
              <textarea
                value={personality}
                onChange={(e) => setPersonality(e.target.value)}
                rows={11}
                className="mt-1.5 w-full rounded-md border border-rule-2 bg-canvas px-3 py-2 font-mono text-[12px] leading-[1.55] text-ink"
              />

              <label className="mt-4 block text-[12px] font-medium text-ink-3">Model</label>
              <ModelField />

              {agentError && <p className="mt-3 text-[12.5px] text-warn">{agentError}</p>}

              <div className="mt-6 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="text-[13px] text-ink-3 hover:text-ink"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={handleCreateAgent}
                  disabled={creatingAgent}
                  className="inline-flex h-[38px] items-center justify-center rounded-md bg-ink px-5 text-[13.5px] font-medium text-canvas transition-[filter] hover:brightness-[0.92] disabled:opacity-50"
                >
                  {creatingAgent ? 'Creating…' : 'Create agent →'}
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="text-center">
              <div
                className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-lime-400/15 text-lime-600 transition-all duration-500 ease-out ${
                  shown ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="h-7 w-7"
                >
                  <path
                    d="M4 12.5l5 5 11-11"
                    strokeDasharray="24"
                    strokeDashoffset={shown ? 0 : 24}
                    style={{ transition: 'stroke-dashoffset 500ms ease 150ms' }}
                  />
                </svg>
              </div>
              <h1
                className={`text-[22px] font-semibold tracking-[-0.01em] text-ink transition-all duration-500 ${
                  shown ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                }`}
              >
                {agentName || 'Your agent'} is ready
              </h1>
              <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-[1.6] text-ink-3">
                Take a minute to meet {agentName || 'your agent'} — a few quick questions so it gets
                to know you. Or head straight to the dashboard.
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => finish('/')}
                  className="inline-flex h-[38px] items-center justify-center rounded-md border border-rule-2 bg-canvas px-4 text-[13.5px] font-medium text-ink transition-colors hover:border-ink"
                >
                  Skip to dashboard
                </button>
                <button
                  type="button"
                  onClick={() => setStep(4)}
                  className="inline-flex h-[38px] items-center justify-center rounded-md bg-ink px-5 text-[13.5px] font-medium text-canvas transition-[filter] hover:brightness-[0.92]"
                >
                  Meet {agentName || 'your agent'} →
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-ink-4">
                Meet {agentName || 'your agent'}
              </div>

              <div
                ref={transcriptRef}
                className="mt-3 flex h-[46vh] min-h-[260px] flex-col gap-2.5 overflow-y-auto rounded-lg border border-rule-2 bg-canvas p-3.5"
              >
                {msgs.length === 0 && !chatError && (
                  <div className="m-auto flex flex-col items-center gap-2.5 text-ink-4">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-rule-2 border-t-ink" />
                    <span className="text-[12.5px]">Waking up your agent…</span>
                  </div>
                )}
                {msgs.map((m, i) => (
                  <div
                    key={i}
                    className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[13px] leading-[1.5] ${
                        m.role === 'user'
                          ? 'bg-ink text-canvas'
                          : 'border border-rule-2 bg-paper text-ink'
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                ))}
                {chatBusy && msgs.length > 0 && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-1 rounded-2xl border border-rule-2 bg-paper px-3.5 py-3">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-4 [animation-delay:-0.3s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-4 [animation-delay:-0.15s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-4" />
                    </div>
                  </div>
                )}
              </div>

              {chatError && <p className="mt-3 text-[12.5px] text-warn">{chatError}</p>}

              {!interviewDone ? (
                <div className="mt-3 flex items-center gap-2">
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void sendAnswer();
                      }
                    }}
                    disabled={chatBusy || msgs.length === 0}
                    placeholder="Type your answer…"
                    className="h-[38px] flex-1 rounded-md border border-rule-2 bg-canvas px-3 text-[13.5px] text-ink disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => void sendAnswer()}
                    disabled={chatBusy || !chatInput.trim()}
                    className="inline-flex h-[38px] items-center justify-center rounded-md bg-ink px-4 text-[13.5px] font-medium text-canvas disabled:opacity-40"
                  >
                    Send
                  </button>
                </div>
              ) : (
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setStep(5)}
                    className="inline-flex h-[38px] items-center justify-center rounded-md bg-ink px-5 text-[13.5px] font-medium text-canvas transition-[filter] hover:brightness-[0.92]"
                  >
                    Continue →
                  </button>
                </div>
              )}

              {chatError && (
                <button
                  type="button"
                  onClick={() => finish('/')}
                  className="mt-3 text-[12.5px] text-ink-3 underline hover:text-ink"
                >
                  Skip to dashboard
                </button>
              )}
            </div>
          )}

          {step === 5 && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-conn-vivid/15 text-[26px]">
                ✈️
              </div>
              <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
                Connect Telegram
              </h1>
              <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-[1.6] text-ink-3">
                Talk to {agentName || 'your agent'} from your phone, and let it reach you with
                updates and questions — right inside Telegram. You can always set this up later.
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => finish('/')}
                  className="inline-flex h-[38px] items-center justify-center rounded-md border border-rule-2 bg-canvas px-4 text-[13.5px] font-medium text-ink transition-colors hover:border-ink"
                >
                  Skip for now
                </button>
                <button
                  type="button"
                  onClick={() => finish(agentId ? `/agents/${agentId}/telegram` : '/')}
                  className="inline-flex h-[38px] items-center justify-center rounded-md bg-ink px-5 text-[13.5px] font-medium text-canvas transition-[filter] hover:brightness-[0.92]"
                >
                  Connect Telegram →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {finishing && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-canvas">
          <div className="relative mb-6 flex h-20 w-20 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-2xl bg-ink/10" />
            <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-ink text-[30px] text-canvas">
              ◆
            </span>
          </div>
          <div className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
            Entering Nodal-Agents
          </div>
          <div className="mt-1 text-[12.5px] text-ink-3">
            Waking up {agentName || 'your agent'}…
          </div>
          <div className="mt-6 h-1 w-52 overflow-hidden rounded-full bg-rule-2">
            <div
              className={`h-full rounded-full bg-ink transition-[width] duration-[2000ms] ease-out ${
                barFilled ? 'w-full' : 'w-0'
              }`}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function StepHeader({ n, title, sub }: { n: number; title: string; sub: string }) {
  return (
    <div>
      <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-ink-4">
        Step {n} of 3
      </div>
      <h1 className="mt-1 text-[20px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      <p className="mt-1.5 text-[13px] leading-[1.5] text-ink-3">{sub}</p>
    </div>
  );
}
