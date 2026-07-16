'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  MODEL_CATALOG,
  groupModelCatalog,
  modelOptionLabel,
  DEFAULT_ROOT_GRANTS,
  type AutonomyLevel,
} from '@nodal-agents/shared';
import { ModelToolsLegend } from '@/components/ui/ModelToolsBadge.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import TextInput from '@/components/ui/TextInput.tsx';
import TextArea from '@/components/ui/TextArea.tsx';
import Select from '@/components/ui/Select.tsx';
import { OptionRadio } from '@/components/ui/OptionRadio.tsx';
import ChoiceTile from '@/components/ui/ChoiceTile.tsx';
import TextButton from '@/components/ui/TextButton.tsx';
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
  setRootAgentAction,
} from '@/lib/actions.ts';
import { AUTONOMY_OPTIONS } from '@/lib/autonomy.ts';

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
  | 'moonshot'
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
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  { value: 'minimax', label: 'MiniMax', baseUrl: '', needsKey: true },
  {
    value: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    needsKey: true,
  },
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
5. While carrying out their requests, whether you should run tools and commands on your own, or check with them for approval before acting.

Start now: one short friendly line (you just want to get to know them, no work yet) + question 1 ONLY. After each answer, a 3-5 word acknowledgement at most, then the next question. After the FIFTH answer, one short warm wrap-up line and end that final message with ${DONE_MARKER} on its own line.]`;

// ── Autonomy confirmation (step 5) ──────────────────────────────────────────
// The interview's FIFTH answer ("take initiative or stick to exactly what you're
// asked") DRIVES the ROOT agent's real autonomy — it no longer just lands in
// memory. Onboarding is a deliberate act, so the created ROOT gets ALL grants ON
// (DEFAULT_ROOT_GRANTS); this step only picks the autonomy level. We pre-select
// with a lightweight keyword heuristic over the free-text answer, then SHOW the
// three modes so the operator can adjust before it's applied. The choice is
// always applied deterministically (never inferred silently).
// Modes come from the shared source of truth (identical text + order in Settings
// → ROOT agent): apps/web/src/lib/autonomy.ts.

// Pre-select the autonomy mode from the operator's free-text 5th answer. Pure
// keyword heuristic — deliberately biased toward the SAFER mode on ambiguity
// (the operator sees and can change the pick before it is applied).
function inferAutonomy(answer: string): AutonomyLevel {
  const a = answer.toLowerCase();
  const initiative =
    /\b(initiative|autonom|proactive|go ahead|do it yourself|on your own|figure it out|don'?t ask|without asking|just do|take the lead|decide)\b/.test(
      a,
    );
  const askFirst =
    /\b(ask first|ask me|check with me|confirm|my orders|exactly what|stick to|only what|wait for me|permission|don'?t act)\b/.test(
      a,
    );
  const balanced =
    /\b(mix|balance|depends|middle|both|risky|important|reversible|big|major|dangerous|destructive)\b/.test(
      a,
    );
  // Ask-first wins outright when the operator is explicit about it; then the
  // balanced signal; then initiative. Default (nothing matched) = ask-first.
  if (askFirst && !initiative) return 'propose_confirm';
  if (balanced) return 'destructive_gate';
  if (initiative && !askFirst) return 'fully_autonomous';
  if (initiative && askFirst) return 'destructive_gate';
  return 'propose_confirm';
}

const TOTAL_STEPS = 7;

// The 4 messaging channels the product supports today, real brand icons —
// same set + order as CHANNEL_ORDER in actions.ts (the agent's Channels page).
// Each choice deep-links to that channel's card on the Channels page (the
// cards carry a matching #id — see TelegramChannelCard.tsx and siblings).
const CHANNELS: Array<{ value: string; label: string; icon: string }> = [
  { value: 'telegram', label: 'Telegram', icon: '/channel-icons/telegram.svg' },
  { value: 'discord', label: 'Discord', icon: '/channel-icons/discord.svg' },
  { value: 'slack', label: 'Slack', icon: '/channel-icons/slack.svg' },
  { value: 'whatsapp', label: 'WhatsApp', icon: '/channel-icons/whatsapp.svg' },
];

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

  // Pop the success state in when we land on the final step. Deferring BOTH
  // setState calls into the timeout (rather than resetting synchronously) keeps
  // the entrance animation while avoiding a synchronous setState in the effect
  // body (which the react-hooks lint flags as a cascading render). `shown` is
  // only read on step 3, so resetting it 30ms later on other steps is invisible.
  useEffect(() => {
    const t = setTimeout(() => setShown(step === 3), 30);
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
  // A one-shot guard (not rendered) — a ref avoids a setState-in-effect.
  const interviewStarted = useRef(false);
  const [interviewDone, setInterviewDone] = useState(false);
  const [chatError, setChatError] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);

  // ── Step 5 — autonomy confirmation ─────────────────────────────────────
  // Pre-selected from the interview's 5th answer, adjustable by the operator,
  // then applied to the created ROOT agent on Continue. Defaults to the safe
  // mode until the answer comes in.
  const [autonomy, setAutonomy] = useState<AutonomyLevel>('propose_confirm');
  const [applyingAutonomy, setApplyingAutonomy] = useState(false);
  const [autonomyError, setAutonomyError] = useState('');

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
    if (step !== 4 || interviewStarted.current) return;
    interviewStarted.current = true;
    void (async () => {
      setChatError('');
      setChatBusy(true);
      // origin: 'onboarding' — this conversation must NEVER surface in the
      // dashboard's Chats list, whether the operator skips or finishes.
      const conv = await createConversationAction({ origin: 'onboarding' });
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
  }, [step]);

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
    // The FIFTH answer (index 4 — "take initiative or stick to exactly what you
    // ask") also DRIVES the ROOT autonomy: pre-select the mode from it so the
    // confirmation step opens on the inferred choice. The answer still goes to
    // memory above — this only adds the autonomy application.
    if (answerCount === INTERVIEW_MEMORY.length - 1) {
      setAutonomy(inferAutonomy(answer));
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

  // Apply the chosen autonomy to the created ROOT agent, then advance to the
  // Telegram step. Onboarding is a DELIBERATE act, so the created ROOT gets ALL
  // grants ON (DEFAULT_ROOT_GRANTS) — a capable personal/local install — with
  // the operator's chosen autonomy level. Writes entities.rootGrants + syncs the
  // meta-tool approval rules for the active workspace (the created router IS that
  // workspace's origin/ROOT orchestrator). Best-effort: a failure surfaces an
  // error but the operator can still continue and tune it later in Settings.
  async function applyAutonomyAndContinue() {
    setAutonomyError('');
    setApplyingAutonomy(true);
    const res = await setRootAgentAction({
      grants: { ...DEFAULT_ROOT_GRANTS, autonomy },
    });
    setApplyingAutonomy(false);
    if (!res.ok) {
      const detail = res.message || 'Could not save the autonomy level';
      setAutonomyError(`${detail} — you can set this later in Settings → ROOT agent.`);
      return;
    }
    setStep(6);
  }

  // Shared model picker: curated models grouped by LLM family (optgroups) so the
  // different vendors are visually separated — e.g. for OpenRouter, Claude /
  // DeepSeek / Gemini / MiniMax each get their own labelled group. Groups and
  // models are alphabetically sorted (by groupModelCatalog). Free-text when the
  // provider has no catalog (local servers).
  // ModelField lives at module scope (see bottom of file): defining a component
  // inside the render is a lint error ("Cannot create components during render").

  // The welcome interview is "done enough" to continue once the operator has
  // answered every question (the canonical `answerCount` the chat already tracks
  // to slot answers into memory) — keyed off that COUNT, not only the fragile
  // [[INTERVIEW_DONE]] marker that small/local models routinely forget to emit
  // (which used to leave the user stuck with no Continue button). The marker,
  // when present, still continues early.
  const canContinue = interviewDone || answerCount >= INTERVIEW_MEMORY.length;

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
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-ink text-legacy-22 text-canvas">
                ◆
              </div>
              <h1 className="text-display-22 tracking-[-0.01em] text-ink">
                Welcome to Nodal-Agents
              </h1>
              <p className="mx-auto mt-2 max-w-sm text-legacy-13-5 leading-[1.6]! text-ink-3">
                Let&apos;s set up your first AI agent. It takes about a minute: connect a model,
                give your agent a personality, and say hello.
              </p>
              <PrimaryButton className="mt-6" onClick={() => setStep(1)}>
                Get started →
              </PrimaryButton>
            </div>
          )}

          {step === 1 && (
            <div>
              <StepHeader
                n={1}
                title="Connect a model"
                sub="The brain your agent thinks with. Your key stays on this machine."
              />

              <label className="mt-5 block text-medium-12 text-ink-3">Provider</label>
              <Select
                value={provider.value}
                onChange={(e) => pickProvider(e.target.value)}
                className="mt-1.5 bg-canvas text-legacy-13-5"
              >
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>

              <label className="mt-4 block text-medium-12 text-ink-3">Model</label>
              <ModelField providerValue={provider.value} model={model} onModel={setModel} />
              {catalogModels.length > 0 && (
                <p className="mt-1.5 text-legacy-11-5 text-ink-4">
                  {catalogModels.length} supported models for {provider.label}.
                </p>
              )}

              <label className="mt-4 block text-medium-12 text-ink-3">Base URL</label>
              <TextInput
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://…"
                className="mt-1.5 bg-canvas text-legacy-13-5"
              />

              <label className="mt-4 block text-medium-12 text-ink-3">
                API key {provider.needsKey ? '' : '(optional for local)'}
              </label>
              <TextInput
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type="password"
                placeholder={provider.needsKey ? 'sk-…' : 'leave blank for local'}
                className="mt-1.5 bg-canvas text-legacy-13-5"
              />

              <div className="mt-4 flex items-center gap-3">
                <PrimaryButton
                  variant="neutral"
                  onClick={handleTest}
                  disabled={testState === 'testing'}
                  className="bg-canvas"
                >
                  {testState === 'testing' ? 'Connecting…' : 'Test connection'}
                </PrimaryButton>
                {testState === 'ok' && (
                  <span className="text-legacy-12-5 font-medium text-lime-600">✓ {testMsg}</span>
                )}
                {testState === 'fail' && (
                  <span className="text-legacy-12-5 font-medium text-warn">{testMsg}</span>
                )}
              </div>

              {keyError && <p className="mt-3 text-legacy-12-5 text-warn">{keyError}</p>}

              <div className="mt-6 flex items-center justify-between">
                <TextButton
                  onClick={() => setStep(0)}
                  className="text-body-13 text-ink-3 hover:text-ink"
                >
                  ← Back
                </TextButton>
                <PrimaryButton onClick={handleSaveKeyAndContinue} disabled={savingKey}>
                  {savingKey ? 'Saving…' : 'Continue →'}
                </PrimaryButton>
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

              <label className="mt-5 block text-medium-12 text-ink-3">Name</label>
              <TextInput
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="e.g. Friday"
                className="mt-1.5 bg-canvas text-legacy-13-5"
              />

              <label className="mt-4 block text-medium-12 text-ink-3">Personality</label>
              <TextArea
                value={personality}
                onChange={(e) => setPersonality(e.target.value)}
                rows={11}
                className="mt-1.5 bg-canvas text-mono-12 leading-[1.55]!"
              />

              <label className="mt-4 block text-medium-12 text-ink-3">Model</label>
              <ModelField providerValue={provider.value} model={model} onModel={setModel} />

              {agentError && <p className="mt-3 text-legacy-12-5 text-warn">{agentError}</p>}

              <div className="mt-6 flex items-center justify-between">
                <TextButton
                  onClick={() => setStep(1)}
                  className="text-body-13 text-ink-3 hover:text-ink"
                >
                  ← Back
                </TextButton>
                <PrimaryButton onClick={handleCreateAgent} disabled={creatingAgent}>
                  {creatingAgent ? 'Creating…' : 'Create agent →'}
                </PrimaryButton>
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
                className={`text-display-22 tracking-[-0.01em] text-ink transition-all duration-500 ${
                  shown ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                }`}
              >
                {agentName || 'Your agent'} is ready
              </h1>
              <p className="mx-auto mt-2 max-w-sm text-legacy-13-5 leading-[1.6]! text-ink-3">
                Take a minute to meet {agentName || 'your agent'} — a few quick questions so it gets
                to know you. Or head straight to the dashboard.
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <PrimaryButton variant="neutral" className="bg-canvas" onClick={() => finish('/')}>
                  Skip to dashboard
                </PrimaryButton>
                <PrimaryButton onClick={() => setStep(4)}>
                  Meet {agentName || 'your agent'} →
                </PrimaryButton>
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <div className="font-mono text-legacy-10-5 tracking-[0.18em] uppercase text-ink-4">
                Meet {agentName || 'your agent'}
              </div>

              <div
                ref={transcriptRef}
                className="mt-3 flex h-[46vh] min-h-[260px] flex-col gap-2.5 overflow-y-auto rounded-lg border border-rule-2 bg-canvas p-3.5"
              >
                {msgs.length === 0 && !chatError && (
                  <div className="m-auto flex flex-col items-center gap-2.5 text-ink-4">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-rule-2 border-t-ink" />
                    <span className="text-legacy-12-5">Waking up your agent…</span>
                  </div>
                )}
                {msgs.map((m, i) => (
                  <div
                    key={i}
                    className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-body-13 leading-[1.5]! ${
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

              {chatError && <p className="mt-3 text-legacy-12-5 text-warn">{chatError}</p>}

              {/* The input stays available the whole time so the operator can
                  keep chatting even after Continue appears. */}
              <div className="mt-3 flex items-center gap-2">
                <TextInput
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
                  containerClassName="flex-1"
                  className="bg-canvas text-legacy-13-5"
                />
                <PrimaryButton
                  onClick={() => void sendAnswer()}
                  disabled={chatBusy || !chatInput.trim()}
                  className="px-4"
                >
                  Send
                </PrimaryButton>
              </div>

              {/* Skip is ALWAYS available — a slow or stuck model must never trap
                  the operator here. Continue appears as soon as the interview has
                  run its course (answer count), independent of the done-marker. */}
              <div className="mt-3 flex items-center justify-between">
                <TextButton
                  onClick={() => setStep(5)}
                  className="text-legacy-12-5 text-ink-3 underline hover:text-ink"
                >
                  Skip for now
                </TextButton>
                {canContinue && (
                  <PrimaryButton onClick={() => setStep(5)}>Continue →</PrimaryButton>
                )}
              </div>
            </div>
          )}

          {step === 5 && (
            <div>
              <div className="font-mono text-legacy-10-5 tracking-[0.18em] uppercase text-ink-4">
                How {agentName || 'your agent'} should work
              </div>
              <h1 className="mt-1 text-heading-20 tracking-[-0.01em] text-ink">
                Set the autonomy level
              </h1>
              <p className="mt-1.5 text-body-13 leading-[1.5]! text-ink-3">
                Based on what you told {agentName || 'your agent'}, we&apos;ve pre-selected a level.
                Adjust it if you like — it decides whether {agentName || 'your agent'} asks you to
                approve its actions before running them, while carrying out what you ask.
              </p>

              <div className="mt-5" role="radiogroup" aria-label="Autonomy level">
                {AUTONOMY_OPTIONS.map((m) => (
                  <OptionRadio
                    key={m.value}
                    active={autonomy === m.value}
                    onClick={() => setAutonomy(m.value)}
                    name={m.name}
                    description={m.description}
                  />
                ))}
              </div>

              <p className="mt-3 text-legacy-11-5 text-ink-4">
                You can change this anytime in Settings → Autonomy.
              </p>

              {autonomyError && <p className="mt-3 text-legacy-12-5 text-warn">{autonomyError}</p>}

              <div className="mt-6 flex items-center justify-end">
                <PrimaryButton
                  onClick={() => void applyAutonomyAndContinue()}
                  disabled={applyingAutonomy}
                >
                  {applyingAutonomy ? 'Saving…' : 'Continue →'}
                </PrimaryButton>
              </div>
            </div>
          )}

          {step === 6 && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-conn-vivid/15 text-legacy-26">
                💬
              </div>
              <h1 className="text-display-22 tracking-[-0.01em] text-ink">
                Connect a messaging channel
              </h1>
              <p className="mx-auto mt-2 max-w-sm text-legacy-13-5 leading-[1.6]! text-ink-3">
                Talk to {agentName || 'your agent'} from your phone, and let it reach you with
                updates and questions — right inside the app you already use. You can always set
                this up later.
              </p>

              <div className="mt-6 grid grid-cols-2 gap-3">
                {CHANNELS.map((c) => (
                  <ChoiceTile
                    key={c.value}
                    onClick={() =>
                      finish(agentId ? `/agents/${agentId}/edit?tab=channels#${c.value}` : '/')
                    }
                    icon={
                      // eslint-disable-next-line @next/next/no-img-element -- static brand svg, same convention as the Channels page cards
                      <img src={c.icon} alt="" aria-hidden="true" className="h-8 w-8" />
                    }
                    label={c.label}
                  />
                ))}
              </div>

              <div className="mt-6 flex items-center justify-center">
                <TextButton
                  onClick={() => finish('/')}
                  className="text-body-13 text-ink-3 underline hover:text-ink"
                >
                  Skip for now
                </TextButton>
              </div>
            </div>
          )}
        </div>
      </div>

      {finishing && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-canvas">
          <div className="relative mb-6 flex h-20 w-20 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-2xl bg-ink/10" />
            <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-ink text-legacy-30 text-canvas">
              ◆
            </span>
          </div>
          <div className="text-title-15 tracking-[-0.01em] text-ink">
            Entering Nodal-Agents
          </div>
          <div className="mt-1 text-legacy-12-5 text-ink-3">
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
      <div className="font-mono text-legacy-10-5 tracking-[0.18em] uppercase text-ink-4">
        Step {n} of 3
      </div>
      <h1 className="mt-1 text-heading-20 tracking-[-0.01em] text-ink">{title}</h1>
      <p className="mt-1.5 text-body-13 leading-[1.5]! text-ink-3">{sub}</p>
    </div>
  );
}

// ModelField — the provider's model picker: the curated catalog grouped by LLM
// family (optgroups), or a free-text input for local servers with no catalog.
// At MODULE scope (not inside OnboardingFlow) so React doesn't treat it as a
// component created during render.
function ModelField({
  providerValue,
  model,
  onModel,
}: {
  providerValue: ProviderValue;
  model: string;
  onModel: (value: string) => void;
}) {
  const entries = MODEL_CATALOG[providerValue] ?? [];
  if (entries.length === 0) {
    return (
      <TextInput
        value={model}
        onChange={(e) => onModel(e.target.value)}
        placeholder="e.g. llama3.2 — type your local model name"
        className="mt-1.5 bg-canvas text-legacy-13-5"
      />
    );
  }
  const groups = groupModelCatalog(entries);
  return (
    <>
      <Select
        value={model}
        onChange={(e) => onModel(e.target.value)}
        className="mt-1.5 bg-canvas text-legacy-13-5"
      >
        {groups.map((g, gi) =>
          g.group ? (
            <optgroup key={g.group} label={g.group}>
              {g.models.map((m) => (
                <option
                  key={m.modelId}
                  value={m.modelId}
                  // Onboarding only ever creates the ROOT orchestrator agent
                  // (see handleCreateAgent's role: 'router') — a model that
                  // can't call tools can't fill that role, so it's always
                  // gated here, not conditionally.
                  disabled={!m.capabilities.tools}
                  title={
                    !m.capabilities.tools ? "Can't use tools (required for your agent)" : undefined
                  }
                >
                  {modelOptionLabel(m)}
                </option>
              ))}
            </optgroup>
          ) : (
            g.models.map((m) => (
              <option
                key={`${gi}-${m.modelId}`}
                value={m.modelId}
                disabled={!m.capabilities.tools}
                title={
                  !m.capabilities.tools ? "Can't use tools (required for your agent)" : undefined
                }
              >
                {modelOptionLabel(m)}
              </option>
            ))
          ),
        )}
      </Select>
      <ModelToolsLegend className="mt-1.5" />
    </>
  );
}
