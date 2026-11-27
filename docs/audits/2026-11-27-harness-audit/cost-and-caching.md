# COST — token cost and caching of every request (audit of `wt-audit-main` @ b0ab6d535)

Auditor area: COST. Read only. Every figure marked "computed, not measured" is arithmetic on the
owner's measurements given in the brief (a chat turn of the main agent ≈ 31,000 input tokens of
which ≈ 4,000 history; 1.39 s + 3.68 ms per token written + 6 ms per 1,000 read; first call
uncached in 35 of 47 jobs; `load_tools` broke the cache in 11 of 19 cases) or on code constants.
Prices are in "input-token equivalents" (1 = one fresh input token): Anthropic 5-minute write
1.25, 1-hour write 2, read 0.1 (0.05 on Opus 5.5 / Sonnet 5.5, 0.025 on Fable 5.1 / 5.2).

Split of the 31,000-token chat turn used below (computed, not measured): history H ≈ 4,000;
volatile half V ≈ 800 (memory budget 1,500 chars, `packages/db/src/schema/agents.ts:81`, plus the
≈1,700 chars the code says follow it, `packages/orchestration/src/system-prompt.ts:1880-1891`,
÷ 4); cached stable prefix S = tools + stable system ≈ 26,200.

## 1. Verdict

Inside one job the caching is close to the state of the art: a stable/volatile split of the
system prompt, cache markers decided per model on every route that honours them (Claude through
OpenRouter included), a prompt frozen on the job row and reused across resumes, an append-only
tool order, compaction kept late on purpose, and cache-aware cost accounting. Across requests it
is not: the per-turn half of the system prompt sits in front of the history, so no conversation
(dashboard chat, voice, Telegram, Slack, Discord, WhatsApp) ever reads its history back from the
cache; every entry lives 5 minutes, so a person's pause, an approval or a delegation re-pays the
whole prompt; and loading a deferred tool changes the first bytes of the request, which rewrites
the whole cache. The platform's own secondary calls are lean in input but inherit the agent's
model and reasoning effort, and the chat re-reads every prose reply with a second call.
**Grade B** — the mechanisms are right and every gap below is named and small to medium to fix,
but the measured outcome (35 of 47 first calls cold, 11 of 19 loads breaking the cache) is that
most requests that could read from the cache do not.

## 2. How it works today

1. `buildSystemPrompt` assembles a STABLE half (identity + personality + team roster, baseline,
   index of deferred tools, workspaces, skills index, MCP guidance, discoverability, messaging
   channels, delegated-task block) and a VOLATILE half (memory ranked on the task, Runtime with a
   minute clock, job context, conversation turn count, running work, shared-workspace listing,
   git), joined by `SYSTEM_PROMPT_CACHE_BOUNDARY` — `packages/orchestration/src/system-prompt.ts:1750-1760, 1892-1908`.
   Memory is ranked on `query: jobContext?.task` (`system-prompt.ts:1424`); the clock is
   minute-precise (`packages/shared/src/timezone.ts:36-47`).
2. Whether a request carries Anthropic `cache_control` is decided per MODEL from the catalog
   (`promptCachingFor`, `packages/llm/src/providers/registry.ts:289-292`; `client.ts:397`).
3. On a caching model, `withAnthropicPromptCaching` sends the stable half as a cached system
   message, the volatile half as a second, uncached system message, and a sliding breakpoint on
   the last replayed message (request-only notes skipped): two breakpoints, 5-minute TTL —
   `packages/llm/src/providers/anthropic-cache.ts:24, 59-79, 87-111`.
4. On OpenRouter the markers are moved inside content parts, one per tool-result run
   (`providers/openrouter.ts:149-203`); every request carries `usage:{include:true}`, the
   reasoning block, and a provider order when the catalog pins one (`openrouter.ts:84-119`).
5. On every other model the boundary is stripped and one system string is sent; caching is then
   the provider's implicit prefix cache (`anthropic-cache.ts:122-128`).
6. A job builds its prompt once and stores it with its tool list and version; resumes reuse it
   (`apps/runner/src/job/execute.ts:2894-2925`).
7. Tools per turn: eager schemas in whitelist order, then deferred tools loaded by `load_tools`
   (or called directly) appended in load order, recorded on the job row
   (`apps/runner/src/job/tool-loading.ts:79-93`, `execute.ts:2866-2879, 4713-4722, 5708-5718`,
   `packages/tools/src/builtin/load-tools.ts:126-190`).
8. History: chat rows trimmed to 16,000 chars, oldest first, with each launched job's record
   (≤ 9,000 chars) outside that budget (`apps/runner/src/chat/run-chat-turn.ts:597-609, 906-956`);
   channel jobs prepend `loadThreadHistory` (8 pairs, 16,000 chars, 2,400 per turn) before the task
   (`execute.ts:3062-3075`, `job/thread-history.ts:125-140`).
9. One tool result ≤ 25,000 chars, binary runs elided (`packages/shared/src/tool-result-budget.ts:26-40`);
   compaction (local, no LLM call) only past 70 % of the serving model's window (`execute.ts:4168-4205, 551-618`).
10. Output: the model's known cap is stated only when the input bound leaves room
    (`packages/llm/src/client.ts:336-386`); a cut turn is refused but observed with its usage
    (`client.ts:460-530`).
11. Retry (`retry.ts:23-48, 292+`), stale retry for one-shot calls (`client.ts:184-224`), and a
    user-configured failover chain, sticky-forward for the rest of the job (`failover.ts:11-14, 56-94`).
12. Accounting: one `llm_calls` row per chain-link attempt, OpenRouter-billed cost preferred, else a
    cache-aware catalog estimate (`apps/runner/src/llm/call-sink.ts:49-108`,
    `packages/shared/src/model-catalog.ts:2149-2188`); job totals and Guard 1a are cache-aware
    (`execute.ts:5113-5190`).
13. Delegation: the child runs its own job (own prompt); the parent receives only the child's
    summary, capped at 25,000 chars (`packages/orchestration/src/router/resume.ts:571-580`).

Secondary calls (every `generateText`/`generateObject` call site in the runner; there is no separate
routing or verification model call — routing is the main model's tool choice):

| Call | Where | Model / effort | Input | When it fires |
|---|---|---|---|---|
| Escalation recheck | `llm/action-recheck.ts:69-85`, `chat/run-chat-turn.ts:1101-1179` | agent's chat client (model, chain, typed or spoken effort) | ≈ 1,100 (measured); request + reply + instruction + `run_task` schema, no system | every chat or voice turn that ends in prose without `run_task` |
| Tool-free retry | `run-chat-turn.ts:1138-1157` | same | full turn (≈ 31,000) | only when the reply had neither text nor `run_task` |
| Conversation title | `run-chat-turn.ts:1255-1265, 1300-1312, 1350-1396` | same | title system + user message + reply | while the title is provisional, up to 10 messages (`:81`) |
| Spoken job announcement | `chat/job-announcement.ts:55-80` | agent's model, spoken effort | personality + request + job result | each job launched from a voice turn, at its end |
| Run synthesis | `cron/deliver-results.ts:437-470` | root's model and effort | request + compiled results | a multi-agent root run completes |
| Reflection | `reflection/run-reflection.ts:212-300`, gates `reflection/index.ts:101-185` | `REFLECTION_MODEL` or agent's, agent's effort | whole job transcript as one user message + skill library, ≤ 4 turns | opt-in per workspace, completed job with ≥ 10 tool iterations, hourly throttle |
| Skill and memory curators | `reflection/run-curator.ts:175-245`, `run-memory-curator.ts:137-205` | reflection model or agent's | ≤ 200 memory candidates (`run-memory-curator.ts:34`) | cron tick (`cron/run-curator.ts`) |

**Since AUDIT_TOKENS.md (2026-08-07).** Its recommendations 1-2 (always-sent Office and meta
tools) became deferred loading for every non-core tool (#612, closed) and `assign_*` descriptions
lost ≈ 11k chars on a ten-teammate root (`packages/orchestration/src/router/assign-tools.ts:83-92`).
Recommendation 4 (cache on providers that honour it) became per-model markers, Claude through
OpenRouter included (#425: 0 cache reads in 852 calls before; #888). TOKEN-001 (a dollar cap that
never fires) is closed by catalog prices with cache read/write rates and a cache-aware estimate
(`model-catalog.ts:100-147, 2149-2188`). Retry amplification is now bounded by a rate-limit
policy and cut calls are counted. Still open: the hit rate is now measured by the owner but cannot
be attributed per call (COST-07), and the delegation cost it predicted was measured (#54, 21 % of
a run) and made visible (`apps/web/src/lib/cache-expiry.ts`), not removed (COST-03).

## 3. What is solid

- The stable/volatile split is the right shape, and a boundary marker in text Nodal did not write
  is defused — `system-prompt.ts:1750-1760, 1904-1908`.
- Caching follows the model, not the route: every Claude catalog entry states `cacheControl`, so
  Claude through OpenRouter caches (#425) — `registry.ts:270-292`, `model-catalog.ts:605-720`.
- The OpenRouter envelope is handled exactly as Hermes found it must be (marker inside a part,
  never top-level on a tool message; one marker per tool run to stay under 4) —
  `openrouter.ts:155-203`; Hermes `agent/prompt_caching.py:23-33, 57-75`.
- The sliding breakpoint skips request-only notes, so it lands on bytes the next request replays
  (#1088) — `anthropic-cache.ts:59-79`.
- A job's prompt is frozen on its row with its tool list and Nodal version, and tool schemas are
  fixed at job start even though approval rules are re-read every turn — `execute.ts:2894-2925, 3002-3011`.
- Tool order is deterministic inside a job and loads are state on the row, so a resume after
  compaction sends the same list — `tool-loading.ts:8-24`, `execute.ts:5708-5718`.
- Compaction is deliberately late and local, evicting old outputs and the large inputs that went
  with them; tool results are capped and binary is elided — `execute.ts:4168-4205, 551-618`,
  `tool-result-budget.ts:17-40`.
- Accounting does not lie: billed cost preferred, cache reads and writes priced at their rates,
  an unknown count stays null, cut turns are observed with usage and interrupted streamed turns
  are estimated — `call-sink.ts:54-70`, `model-catalog.ts:2149-2188`, `reported-usage.ts:32-46`,
  `client.ts:460-530`, `execute.ts:4766-4791`.
- The output cap is stated only when it fits the window — `client.ts:336-386`.
- Rate limits honour `Retry-After` and hand over to a configured fallback fast; failover only on
  availability errors, logged and flagged in `llm_calls` — `retry.ts:23-48`, `failover.ts:33-46, 84-90`,
  `call-sink.ts:99`. Nothing moves to another model without the owner having configured it.
- Delegation hands the parent the child's summary, never its transcript — `resume.ts:571-580`.
- Secondary calls were already trimmed: the chat recheck went from ≈ 9,300 to ≈ 1,100 input
  tokens, the job loop's recheck was removed after a month of measurement (#886), reflection is
  opt-in and gated — `action-recheck.ts:9-19`, `reflection/index.ts:101-185`.
- Replayed history was designed byte-stable for the cache — `job/exchange-record.ts:67-73`
  (COST-01 explains why that design does not pay yet).

## 4. Findings

### COST-01 · P2 · CONFIRMED · NEW
**Title:** Every conversation turn writes its history to the cache again: the per-turn half of the
system prompt sits in front of the history, so the history is never read back.
**Where:** `packages/orchestration/src/system-prompt.ts:973, 1892-1899`;
`packages/llm/src/providers/anthropic-cache.ts:97-111`; `apps/runner/src/chat/run-chat-turn.ts:896-903`;
`apps/runner/src/job/execute.ts:3062-3075`.
**Evidence:** `system-prompt.ts:973`, then `:1892-1896` (the Runtime block carries the minute
clock), then `anthropic-cache.ts:111`:
```ts
      : `- Turns before this one: ${conv.priorTurns} (the most recent are replayed in the messages).`,
  const volatile =
    memoryBlock +
    runtimeBlock +
    jobContextBlock +
    return { ...(rest as T), messages: [...systemMsgs, ...messages] } as T;
```
**Scenario:** a person sends turn N+1 two minutes after turn N in the dashboard chat (or on
Telegram, where each message is a job that rebuilds its prompt). The request is tools → stable
system (read) → volatile system (changed: turn count N→N+1, clock, memory re-ranked on the new
message) → history → new message. Anthropic's prefix rule (tools → system → messages) makes the
entry written at the end of turn N unreadable, so the ≈ 4,000 history tokens are written again at
1.25 and the entry turn N wrote is never read. Same on implicit-cache providers (DeepSeek, GLM,
Kimi, Gemini, GPT): the history is fresh input every turn. Computed, not measured: warm turn today
26,200 × 0.1 + (800 + 4,000 + 50) × 1.25 ≈ 8,700; with history before the per-turn facts
≈ 27,000 × 0.1 + 4,000 × 0.1 + 50 × 1.25 + 60 ≈ 3,200 — about 63 % less input cost per warm turn
(77 % on Sonnet 5.5 / Opus 5.5 read prices).
**Fix (general form):** a conversation's system prompt is built once and kept byte-identical
across its turns, as a job's already is (`execute.ts:2894-2925`): one prompt per conversation,
rebuilt only when its tools, the Nodal version or the agent change. What truly changes per turn
(the clock, the turn count) rides after the message being answered as a request note, the
mechanism #1088 already built (`REPLY_FORM_NOTES`, `isRequestNote`, breakpoint placed before it,
`anthropic-cache.ts:62-68`). Memory stays in the frozen prompt, chosen at the conversation's
start: moving it next to the message would undo #986 / #1004 (memory near the message pulls the
reply's language), so the language bench is the test. The stable Runtime facts (OS, version,
network, code projects, install notes) move to the stable half at the same time. Reaches: chat,
voice, every channel conversation job; not cron, webhook, MCP or delegated jobs (no history).
**Effort:** M.
**Hermes / best practice:** Hermes restores the stored system prompt from the session row on
every turn (`agent/conversation_loop.py:803-830`) and stamps a date-only "Conversation started"
line so it stays byte-stable (`agent/system_prompt.py:181-200, 509-517`). Anthropic: "Keep the
system prompt frozen … inject dynamic context later in messages" (prompt-caching documentation,
Architectural guidance).

### COST-02 · P2 · CONFIRMED · NEW
**Title:** Loading a deferred tool rewrites the whole cached prompt, because it changes the
first thing the request renders.
**Where:** `apps/runner/src/job/tool-loading.ts:19-24, 79-93`; `apps/runner/src/job/execute.ts:4713-4722`.
**Evidence:**
```ts
// Order is part of the prompt cache: eager tools in whitelist order, then the
// loaded ones in load order. Loading appends, nothing is ever removed, so a
// turn that loads nothing sends the byte-same list as the turn before. A load
// itself changes the list once — the price the Anthropic and OpenAI tool
// searches avoid only by expanding definitions server-side, which a
// provider-neutral runner cannot do.
```
**Scenario:** a root job calls `load_tools(["xlsx_format_range"])` on turn 3. Turn 4's tool array
has one more entry; tools render first, so tools, system and the whole transcript miss and are
written again. Measured: 11 of 19 loads broke the cache. Computed, not measured: one break costs
(1.25 − 0.1) × 31,000 ≈ 35,650 (37,200 at 0.05 read prices), while deferral saves ≈ 8,200 schema
tokens per turn (#612's estimate), i.e. ≈ 820 per cached turn: one break eats the saving of about
43 cached turns (≈ 90 on Sonnet 5.5). On caching routes deferral costs more than it saves in any
job that loads once; it only pays on uncached routes. The quality motive of #612 (fewer schemas
in view) stays valid.
**Fix (general form):** the tool array is byte-stable for the life of a job. Provider-neutral,
the Hermes form: deferred tools are described by a call whose schema comes back as a tool result
(append-only, in the transcript) and are invoked through one stable bridge tool the runner
validates against the job's whitelist (invariant #9 unchanged). Where a provider offers it, its
own deferred loading (Anthropic tool search with `defer_loading`, or `tool_addition` blocks under
the inline-tools beta) appends instead of swapping; whether either passes through OpenRouter was
not verified. This removes a branch rather than adding one: one tool list per job, no per-turn
recomputation. Reaches every job holding deferred tools (MCP, connectors, Office, meta-tools).
**Effort:** M.
**Hermes / best practice:** `tools/tool_search.py:1-7, 347-383` (core tools never deferred;
deferrable tools replaced by three fixed bridge tools; catalog rebuilt statelessly). Anthropic:
"Tools render at position 0; adding, removing, or reordering a tool invalidates the entire cache";
tool search "appends tool schemas rather than swapping them" (prompt-caching and tool-search docs).

### COST-03 · P2 · CONFIRMED · NEW (the delegation case is #54, closed as "made visible")
**Title:** Every cache entry lives 5 minutes, so any pause longer than that — a person replying,
an approval, a delegation — pays the whole prompt again.
**Where:** `packages/llm/src/providers/anthropic-cache.ts:24`; `apps/web/src/lib/cache-expiry.ts:19-35`.
**Evidence:** `anthropic-cache.ts:24`, then `cache-expiry.ts:35`:
```ts
const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
export const CACHE_TTL_MS = 5 * 60_000;
```
**Scenario:** #54: a root's turns 1 and 2 are 33 minutes apart while its team works; turn 2 pays
35,000 tokens at full price ($0.0396), turn 3 nine seconds later pays $0.0088; 21 % of the run's
bill. The same happens to the stable half (≈ 26,200, shared by every job of the agent) whenever
a person answers after more than 5 minutes; measured: the first call was uncached in 35 of 47
jobs. Computed, not measured: with a 1-hour entry a resume 5-60 minutes later reads instead of
writing, saving 1.15 × prefix (40,250 on #54's 35,000), while each token written costs 0.75 more
(26,250 on the same 35,000) — net positive from the first resume. For the stable half, one hourly
1-hour write (+19,650) is repaid by one avoided 5-minute rewrite (−30,130).
**Fix (general form):** the TTL is chosen by who paces the next request, once, in the caching
layer: 1 hour for the stable breakpoint of every prefix reused by person-paced origins (dashboard,
voice, messaging channels) and for the sliding breakpoint of a job that suspends for a person or a
delegation; 5 minutes for machine-paced work (cron, webhook, MCP, delegated child). The provider's
ordering rule holds (a 1-hour entry before a 5-minute one). The AI SDK accepts `ttl: '1h'`
(`@ai-sdk/anthropic` dist `index.mjs:874`) and OpenRouter forwards it to Claude. `cache-expiry.ts`
then reads the TTL per call instead of a constant. On Fable 5.1 / 5.2 (0.025 reads) a keep-alive
request is the cheaper form. Reaches every Claude route; no effect on implicit-cache providers.
**Effort:** S.
**Hermes / best practice:** Hermes offers `cache_ttl: auto` = 1 h for human-paced sources, 5 min
for machine-paced ones (`agent/prompt_caching.py:154-175`, `agent/agent_init.py:562-586`); its
default is still `5m` (`hermes_cli/config_defaults.py:689`, `cli-config.yaml.example:886-887`), so
"Hermes uses a 1-hour cache for human conversations" is true only under `auto`. Anthropic:
"5-60 minutes (a user who replies after 20 minutes; an agentic side-task …) → 1-hour"
(prompt-caching documentation, Choosing the TTL); OpenRouter supports `ttl: "1h"` for Anthropic
(openrouter.ai prompt-caching guide).

### COST-04 · P2 · PLAUSIBLE · NEW
**Title:** No cache-routing key is sent, so OpenRouter may serve a job's first call from another
upstream than the previous job's, where nothing is cached.
**Where:** `packages/llm/src/providers/openrouter.ts:114-118`; no `session_id` /
`prompt_cache_key` anywhere in `packages/llm/src` (grep, 0 hits).
**Evidence:**
```ts
  return {
    usage: { include: true },
    ...(reasoning ? { reasoning } : {}),
    ...(providerOrder ? { provider: { order: providerOrder, allow_fallbacks: true } } : {}),
  };
```
**Scenario:** OpenRouter's default sticky key is a hash of the first system message and the
first non-system message, and stickiness starts only after a cache hit (OpenRouter
prompt-caching guide). In Nodal the first non-system message is the job's task (new every job)
or the oldest replayed message (moves as the window slides), so every job is a new
"conversation" to OpenRouter. Claude is served by several upstreams and catalog Claude entries pin
no provider order (`model-catalog.ts`: only DeepSeek entries carry `providerOrder`), so job B can
land on an upstream that never saw job A's stable half: a full write, 1.25 × 26,200 instead of
0.1 × 26,200 (computed). Missing link: which upstream served each call is not in `llm_calls`
(the job row keeps only the last `servedProvider`), so the share of the 35 cold first calls this
explains is unknown.
**Fix (general form):** one routing key per prefix family — a hash of the tools and the stable
system half (what the cache is shared by) — sent through each provider's documented field:
OpenRouter `session_id`, OpenAI `prompt_cache_key` on models before GPT-5.6. Record the served
upstream per call.
**Effort:** S.
**Hermes / best practice:** Hermes derives a content-addressed `prompt_cache_key` from the static
prefix (`agent/transports/chat_completions.py:77-100`, `agent/prompt_cache_scope.py:1-12`).
OpenAI: "prompt_cache_key is important for optimizing cache hit rates" before GPT-5.6 (OpenAI
prompt-caching guide).

### COST-05 · P2 · CONFIRMED · NEW (the job-loop equivalent was removed by #886)
**Title:** Every prose reply in chat and voice pays a second model call, not only replies that
announce an action.
**Where:** `apps/runner/src/chat/run-chat-turn.ts:1104, 1178-1179`; `apps/runner/src/llm/action-recheck.ts:9-14, 78-85`.
**Evidence:** `run-chat-turn.ts:1104`, then `:1178-1179`:
```ts
    if (relu || runTask || !text) return null;
  if (text) onReplyText?.({ text, streamed });
  const arretRelecture = await relireUneFois();
```
**Scenario:** the person says "bonjour"; the agent answers in prose; the recheck runs anyway:
≈ 1,100 fresh input tokens plus the model's reasoning at the agent's chat effort, and on a Claude
route a cache write that nothing reads (COST-08). Time computed, not measured: 1.39 s + 3.68 ms ×
tokens written (≈ 2.5 s for 300 reasoning tokens) after the reply is shown, before the turn ends.
Share: 100 % of conversational turns. Against a warm turn's ≈ 8,700 input equivalents
(COST-01) it adds ≈ 1,375, about 16 %, plus a second round trip. The code says it stays "until
it is measured"; no issue measures it.
**Fix (general form):** measure first, from data that exists: `llm_calls` rows with
`source='chat'` give, per turn, whether the second call returned a `run_task`. If the conversion
rate is like #886's, remove it (one path fewer); if not, it is a platform call and runs at the
platform's lowest effort (COST-06).
**Effort:** S.
**Hermes / best practice:** not covered (Hermes has no prose recheck). #886's measured decision
is the precedent.

### COST-06 · P3 · CONFIRMED (native route) / PLAUSIBLE (OpenRouter translation) · NEW
**Title:** "Auto" reasoning on a Claude model means the model's own default, high on most current
Claude models, and the platform's secondary calls inherit it.
**Where:** `packages/llm/src/providers/openrouter.ts:105-112`; `providers/anthropic.ts:10-11, 86-91`;
`apps/runner/src/chat/run-chat-turn.ts:859-861, 1260-1265, 1307-1312`; `packages/db/src/schema/llm-calls.ts:56-67`.
**Evidence:** `openrouter.ts:110-112` (the `else` taken when no effort is set: only models flagged
`reasoning`, which no Claude entry is), then `anthropic.ts:10`:
```ts
  } else if (isReasoning) {
    reasoning = { enabled: true, effort: 'medium' };
  }
// Auto (no effort) and 'off' inject NOTHING — byte-identical to pre-feature
```
**Scenario:** an agent on Claude Sonnet 5.5 with `reasoning_effort` NULL: Claude entries carry
`reasoningControl` but no `reasoning` flag, so nothing is sent and the model thinks at its
default — `high` on Sonnet 5.5, Opus 5 and Fable, `medium` on Opus 5.5 / Haiku 5.5, and thinking
cannot be turned off on Sonnet 5.5 / Opus 5.5 / Fable (Anthropic model documentation). The chat
turn, its recheck and the title call all run on that client. Each reasoning token costs 3.68 ms
and the output price ($10/M on Sonnet 5.5). How much is spent cannot be seen: `llm_calls` has no
reasoning-token column. What OpenRouter forwards when no `reasoning` is sent was not verified live.
**Fix (general form):** record reasoning tokens per call (the SDK exposes
`usage.outputTokenDetails.reasoningTokens`); give the platform's own calls (recheck, title,
announcement, synthesis) one platform-set effort, the lowest the model accepts, since they are the
platform's questions, not the agent's work; the agent's own turns keep the agent's setting.
**Effort:** S.
**Hermes / best practice:** per-task auxiliary lanes with their own model and effort, title and
voice lanes thinking-off (`hermes_cli/config_defaults.py:758-775`), stepping up to `low` where a
route refuses "off" (`agent/auxiliary_reasoning_floor.py:1-16`). Anthropic: chat and classification
"often do well at `low`" (effort guidance).

### COST-07 · P3 · CONFIRMED · #892 (item 2) for the writes; NEW for the prefix hash
**Title:** On OpenRouter the cache writes are not recorded, and no call records what prefix it
sent, so a cold call cannot be explained.
**Where:** `packages/llm/src/observe.ts:115`; `apps/runner/src/job/execute.ts:5134-5139`;
`apps/runner/src/llm/call-sink.ts:37-42`.
**Evidence:** `observe.ts:115`, then `call-sink.ts:40`:
```ts
        cacheCreationTokens: num(r.providerMetadata?.anthropic?.cacheCreationInputTokens),
    .update([...names].sort().join('\n'))
```
**Scenario:** Claude through OpenRouter (this owner's route): the OpenRouter provider fills the
SDK's unified `inputTokens.cacheWrite` from `prompt_tokens_details.cache_write_tokens`
(`@openrouter/ai-sdk-provider` dist `index.mjs:2565`; exposed by `ai` as
`usage.inputTokenDetails.cacheWriteTokens`, dist `index.mjs:2441`), but Nodal reads only the
native Anthropic metadata, so `cache_creation_tokens` is null on every such row and the #54 view
never fires there. The tools hash sorts names, so it is blind to order and to schema text. Asked
"why were 35 of 47 first calls cold?", the table cannot say whether the prefix changed, the TTL
lapsed, or the upstream changed.
**Fix (general form):** read cache writes from the SDK's unified usage for every provider (one
reader instead of one per provider); record a hash of the cached prefix (tools in sent order +
stable system half) and the served upstream on each call.
**Effort:** S.
**Hermes / best practice:** not covered as such; Anthropic recommends verifying with the
read/write usage fields and diffing consecutive payloads (prompt-caching documentation, Verifying
cache hits).

### COST-08 · P3 · CONFIRMED · NEW
**Title:** One-shot calls carry a cache marker and pay a write nothing will read.
**Where:** `packages/llm/src/client.ts:544, 659, 673`; `apps/runner/src/llm/action-recheck.ts:78-85`;
`run-chat-turn.ts:1260-1265`; `chat/job-announcement.ts:76-79`.
**Evidence:** `client.ts:544` (the same line at `:659` and `:673`):
```ts
    const unbounded = cachingOn ? withAnthropicPromptCaching(args) : stripSystemCacheBoundary(args);
```
**Scenario:** the recheck (three messages, ≈ 1,100 tokens, above the 512-1,024 minimum) gets the
sliding marker on its last message: a 1.25 write of a prefix no later call shares. Computed:
+0.25 × 1,100 ≈ 275 per prose reply; same for titles and announcements above the minimum.
**Fix (general form):** a call that no later request can extend carries no marker; the client
decides it from the request's shape (no tools, at most one user turn) or the caller says so.
**Effort:** S.
**Hermes / best practice:** `agent/prompt_caching.py:35-47` (`is_one_shot_request`: "a marker
there only buys a cache write that nothing ever reads").

### COST-09 · P3 · CONFIRMED (mechanism) · NEW
**Title:** The chat history budget does not count the records of launched jobs, so a busy
conversation carries more history than its 16,000-character budget, every turn.
**Where:** `apps/runner/src/chat/run-chat-turn.ts:589-592, 597-609`; `apps/runner/src/job/exchange-record.ts:118`.
**Evidence:** `run-chat-turn.ts:590-591`, then `exchange-record.ts:118`:
```ts
 * runner's record of each launched job rides in its `run_task` result, which
 * the budget does not count (`totalHistoryChars`): the trim is the same with
export const MAX_RECORD_CHARS = 9_000;
```
**Scenario:** a conversation where the person launched five tasks in a row keeps those five short
acknowledgements inside the text budget, and each carries its record: up to 5 × 9,000 = 45,000
chars ≈ 11,000 tokens on top of the budget (computed upper bound; real record sizes not measured),
re-written every turn while COST-01 stands.
**Fix (general form):** one budget for everything replayed: the records count toward the
history budget, the oldest exchange dropping whole, record included.
**Effort:** S.
**Hermes / best practice:** not covered.

### COST-10 · P3 · PLAUSIBLE · NEW
**Title:** The order of teammates, delegation tools, skills and MCP servers in the cached prefix
depends on the database's row order.
**Where:** `packages/orchestration/src/team-block.ts:116-133`; `router/assign-tools.ts:141-150, 164-176`;
`system-prompt.ts:1374-1378`; `apps/runner/src/job/execute.ts:2568-2586` (no `orderBy`), against
`system-prompt.ts:1416` (workspaces, ordered).
**Evidence:** `team-block.ts:130-134`:
```ts
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(
      and(eq(agentAssignments.orchestratorId, parentAgentId as string), eq(agents.active, true)),
    );
```
**Scenario:** `agents` rows are rewritten on every Telegram poll (`telegram/poller.ts:303-306`)
and `agent_skills` on every prompt build (`packages/db/src/repos/skills.ts:329-335`); if the join's
plan follows the rewritten relation, the next job lists teammates — and the eager `assign_*`
tools, first in the tool array (`execute.ts:2801`) — in another order: a full miss, 1.15 × the
prefix (computed). Missing link: the query plan on the live database.
**Fix (general form):** every query that feeds the prefix orders by a stable key, and a test
proves a row update does not change the stable half.
**Effort:** S.
**Hermes / best practice:** Anthropic: "Serialize tools deterministically (sort by name)"
(prompt-caching documentation, Silent invalidators).

### COST-11 · P3 · CONFIRMED · NEW
**Title:** The same "purpose" sentence is repeated inside every tool schema.
**Where:** `packages/tools/src/purpose.ts:44-46, 85`; `packages/tools/src/purpose-exposure.ts:60-68`.
**Evidence:**
```ts
export const PURPOSE_DESCRIPTION =
  'One sentence for the person who approves: what you need this for. ' +
  'Required when the call needs approval.';
const optionalPurposeField = z.string().max(PURPOSE_MAX).describe(PURPOSE_DESCRIPTION).optional();
```
**Scenario:** every tool that does not ask the user carries the field and its ≈ 110-char
description, read-only tools included (#612 measured 9,600 chars across 67 tools). Computed:
≈ 25 eager schemas × ≈ 110 chars ≈ 690 tokens per request, ≈ 69 at read price, ≈ 860 on a cold
call. Minor.
**Fix (general form):** state the rule once in the prompt and keep the field bare (no
description) where it is optional.
**Effort:** S.
**Hermes / best practice:** not covered.

## 5. The three changes that would most improve cost in this area

1. **Freeze a conversation's prompt and pick the TTL by who paces the next request (COST-01 +
   COST-03).** For the user: a conversation turn whose cache is warm costs about a third of today
   (≈ 8,700 → ≈ 3,200 input equivalents, computed), and a reply after 5-60 minutes, a resumed
   delegation (#54's 21 %) or an approved card reads its prompt instead of re-paying it, which
   should convert most of the 35 cold first calls in 47. Cost: M for the frozen conversation
   prompt plus S for the TTL; the risk is the reply language (#986, #1004), which is why memory
   stays in the frozen part and the language bench gates it.
2. **Keep the tool array byte-stable for a job (COST-02).** For the user: the job keeps reading
   its ≈ 31,000-token prefix after it loads a tool, instead of re-writing it (≈ 35,650 per load,
   computed, in 11 of 19 loads measured), while keeping #612's smaller schema set in view. Cost: M
   (Hermes's bridge shape is provider-neutral; the provider's own deferred loading where a route
   offers it).
3. **Instrument the cache, then cut the platform's extra calls (COST-07, COST-04, COST-05,
   COST-06).** Record cache writes on every provider, a prefix hash, the served upstream and
   reasoning tokens per call; send a routing key. For the user: the 35-of-47 cold starts get a
   cause each, and the chat recheck and title calls stop running at the agent's full effort or are
   removed once measured (≈ 1,100 input tokens and ≥ 1.4 s per prose reply today). Cost: S each.

## 6. Leads not confirmed, and what could not be checked without a live run

**Leads not confirmed**
- An MCP server that fails to connect in one job drops its tools from the index in the STABLE
  half (`execute.ts:2723-2735` continue on failure, `system-prompt.ts:1613-1624`), so a flaky
  server changes the cached prefix of that job and the next. Mechanism read; frequency unknown.
- The task board starts sibling tasks together (`cron/execute-ready.ts:260-271`,
  `Promise.allSettled`); N tasks for the same worker agent would each write the same prefix, since
  an entry is readable only once the first response streams (Anthropic, Concurrent-request
  timing). Not checked how often siblings share an agent.
- A chat reply cut by a clock or by Stop records no usage (`run-chat-turn.ts` `keepPartialReply`,
  `client.ts:588, 634` observe `null` usage), unlike the job loop, which estimates it; a streamed call
  retried by `withRetry` after a mid-stream failure records only the last attempt. Billed tokens
  may be missing from `llm_calls`; volume unknown.
- An OpenRouter variant id (`…:nitro`) gets no cache markers (#892 item 1, still open).
- Haiku 5.5 prompts above 100K tokens are priced at the standard tier (documented in
  `model-catalog.ts:710-716`), under-estimating the dollar guard; Guard 1a still bounds them.
- After a failover the job stays on the fallback to its end (`failover.ts:11-14`) and starts it
  cold (caches are per model). By design and visible in `llm_calls.failover`; whether the job page
  shows it to the owner was not checked.

**Could not be checked without a live run** (the brief forbids it)
- Which of TTL lapse, changed prefix, or changed upstream explains each of the 35 cold first calls
  (needs COST-07's columns, or `agent_jobs.served_provider` joined to the first `llm_calls` row of
  each job).
- Today's sizes of the stable and volatile halves and of the eager schemas after #612 (the
  August token counts predate deferral); the split used here is derived from the brief's figures.
- The chat recheck's conversion rate, and reasoning tokens per surface and effort.
- What OpenRouter forwards to Claude when no `reasoning` field is sent, and whether Anthropic
  tool search or the inline-tools beta pass through OpenRouter.
- The Postgres plan of the unordered joins in COST-10.

Sources (official, read for this audit): Anthropic prompt-caching and tool-search documentation
(platform.claude.com/docs/en/build-with-claude/prompt-caching,
platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool — as carried by the Claude
API reference cached 2026-11-03: render order, 4 breakpoints, 512-4,096 minimums, 1.25 / 2 / 0.1
multipliers, TTL choice by gap, concurrent-request timing); OpenRouter prompt-caching guide
(openrouter.ai/docs/guides/best-practices/prompt-caching: 1-hour TTL for Anthropic, sticky routing
by hash of the first system and first non-system message, `session_id`); OpenAI prompt-caching
guide (developers.openai.com/api/docs/guides/prompt-caching: `prompt_cache_key` before GPT-5.6).
