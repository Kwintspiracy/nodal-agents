# TOOLS — tools and the agent loop

Audited tree: `origin/main` at `b0ab6d535` (read only). Hermes copy: `NousResearch/hermes-agent (local clone)`.
Paths below are relative to the worktree unless they start with `hermes:`.

## 1. Verdict

**Grade: B (good, with named gaps).** The mechanics of the loop are at or above the state of the art on honesty: every tool call leaves with a result whatever the exit, guards are typed and re-read from the transcript so they survive a resume, a run stopped by a budget hands over what it wrote, a delegation comes back as a typed record, and errors mostly tell the model what to do next. What holds output quality back is not missing machinery but accumulated machinery: there are four ways for a job to give its answer and two delegation tools with opposite contracts, so the loop needs a dozen guards to catch the model choosing wrong, and the guards now interact (TOOL-01 is one such interaction). Tool results lose the part that matters in two common cases (the tail of a long command output, an old result after compaction), the parallel executor is all-or-nothing, and there is no plan that survives a long run. The system prompt has been cut hard since August (TOKEN-002) and is now measured and budgeted in places, but it still carries incident patches, contradictions, and runner messages written in French for every user.

## 2. How it works today

1. `executeJob` → `runJob` → `runJobTracked` (`apps/runner/src/job/execute.ts:1291`, `:1580`, `:1667`): one ~5,800-line function owns the loop. A job past 15 resumes is refused at entry (`:1811`).
2. The whitelist: built-ins from `agentBuiltinToolNames` (`packages/tools/src/whitelist.ts:41`, always-on list `packages/tools/src/builtin/index.ts:273`, 23 names), checked against the registry by `computeToolWhitelist` (`whitelist.ts:103`), plus delegation tools for an orchestrator (`packages/orchestration/src/delegation-tools.ts:26`), connector, MCP and channel tools.
3. Tools are `eager` (schema sent every turn) or `deferred` (one index line, loaded by `load_tools`, `packages/tools/src/builtin/load-tools.ts:89-175`; index block `packages/orchestration/src/system-prompt.ts:1067`). A deferred tool called directly is still accepted (`execute.ts:5712`, `toolsLoadedByCalls`).
4. The system prompt is built once per job and frozen unless the tool list or version changes (`execute.ts:2896-2907`), split stable/volatile around a cache boundary (`system-prompt.ts:1750-1761`, `:1892-1908`).
5. Each turn: authority re-read, inbox drain, turn cap (50, `execute.ts:4653`), run time, agent budget, run cost (`:4664-4700`), then the tools sent this turn (`:4715`).
6. One `generateText` call per turn, streamed, `toolChoice: 'auto'` (`execute.ts:4844-4857`); no SDK `maxSteps`: the runner executes tools itself. Compaction is checked before (`:4805-4827`) and after (`:5276-5294`) the call.
7. After the call: cost/token guards (`:5212-5271`), the per-turn call budget refuses a turn over 50 calls whole (`:5323`), the delivery-spam guard (`:5333-5343`), then the assistant message is appended with reasoning and tool-call signatures mirrored to `providerOptions` (`:5345-5418`).
8. No tool call: text is the answer, after the failure, delivery, declaration and inbox guards; empty text is retried twice then failed (`:5427-5636`, `MAX_EMPTY_TURN_RETRIES = 2` at `:3683`).
9. Tool calls: one `assign_*` kept per turn (`:5661`, `packages/orchestration/src/router/only-one-per-turn.ts:48`), unavailable names get 3 corrective turns (`:5684-5711`), a parallel pre-pass runs the batch only if every call is a read (`:5898-5934`), then the serial loop runs each call through `executeTool` (`:5938`; gate, validation, approvals in `packages/tools/src/execute.ts:212-340`).
10. Results become model text through one converter (`execute.ts:3109-3127`): JSON if under 25,000 characters, otherwise text cut from the head (`packages/shared/src/tool-result-budget.ts:26`, `:51-58`); third-party results are framed as untrusted.
11. Compaction (Guard 1c) replaces every tool result older than the last 3 tool messages with a fixed marker once the prompt passes 70% of the model's window (`execute.ts:565-617`, `:4194-4201`; marker `apps/runner/src/job/tool-result-shape.ts:25`). Nothing is summarized.
12. Delegation: `assign_<slug>` throws `DelegationPendingError`; `handleDelegation` creates the child with the brief, optional `data`, inbound images and the job folder (`packages/orchestration/src/router/delegate.ts:89-130`), suspends the parent; `resumeDelegated` writes the child's typed outcome as the tool result (`packages/orchestration/src/router/resume.ts:202-273`). `create_task` puts work on the task board, run concurrently; the root never runs again and a separate synthesis call writes the reply (`apps/runner/src/cron/deliver-results.ts:424-466`).
13. Ending: `return_result` (status + optional `reason` + `deliverables`), final text, `dashboard_publish`, or a channel send; deliverables are checked before success, a red proof gets a repair turn (`execute.ts:5560-5590`).
14. Chat surface: one tool, `run_task`; a prose reply without it is re-read once by a second model call (`apps/runner/src/chat/run-chat-turn.ts:1073-1131`, `apps/runner/src/llm/action-recheck.ts:33-86`).
15. CLI runtimes: the Nodal loop is skipped; Claude Code / Codex run with their own tools, `--strict-mcp-config` and no Nodal tool (`apps/runner/src/cli-runtime/run-job.ts:1-10`, `claude-turn.ts:141-185`, `provider.ts:77-82`).

### Since the earlier audits

- `docs/audits/hermes-total-audit.md` (2026-05-13) listed "5 always-on tools, no file I/O, no code exec, no MCP client, web_search a stub, synchronous delegation". All closed: file tools, `run_command` with an OS sandbox (#628), an MCP client, `web_search` with a free fallback, `ask_user`, the task board for parallel delegation, heartbeat and zombie handling (#565/#566), typed delegation outcomes (#116). Still open from that list: lifecycle hooks, a `/goal`-style objective, post-write lint, a to-do tool.
- `audit/AUDIT_HARNESSES.md` (2026-08-07) was mostly BLOCKED; since then `tool-choice-floor.ts` was removed (#600/#604) and the runner never forces a tool call.
- TOKEN-002 (`audit/AUDIT_FINDINGS.md:1220`, ~36,000 fixed tokens): the baseline went from 20,304 to ≤6,000 characters under a test (`packages/orchestration/src/tests/baseline-budget.test.ts:52-71`), the hand-written channel block left (#613), schemas are deferred (#612), skills are an index plus `skill_view`.

### The system prompt, section by section (estimate, not a measured count)

No assembled prompt was built (no script run). Characters were read from the source; tokens ≈ characters / 4.

| # | Section (order sent) | Source | Weight |
|---|---|---|---|
| 1 | Identity line | `system-prompt.ts:1296` | ~60 t |
| 2 | Personality (owner text) | DB | variable |
| 3 | `## Your team` (orchestrator) | `team-block.ts:440-660` | ~1,600 t fixed + ~100-250 t per teammate |
| 4 | `## How you work (always)` + 6 baseline skills | `agent-baseline.ts:224`, catalog | ≤5,100 chars, ~1,300 t (tested) |
| 5 | Memory discipline + role block | `agent-baseline.ts:93-160` | ≤900 chars (≤6,000 total, tested) |
| 6 | `## Tools on demand` | `system-prompt.ts:1067` | ≤160 chars per deferred tool; a root with meta and office tools ≈ 1,500-2,000 t |
| 7 | `## Workspace(s)` | `system-prompt.ts:1082` | ~150 t |
| 8 | `## Skills (load before acting)` | `system-prompt.ts:1549` | ~120 t + ~50 t per skill |
| 9 | `## MCP server "x"` | `system-prompt.ts:752-762` | capped at 8,000 chars (~2,000 t) |
| 10 | `## Capabilities you can request` | `agent-baseline.ts:405` | ~20 capability skills + connectors + channels + automations ≈ 1,000-1,500 t, every job |
| 11 | `## Messaging channels` | `system-prompt.ts:1183` | ~100-200 t |
| 12 | `## Delegated sub-task` (children) | `system-prompt.ts:1715` | ~300 t |
| 13 | `## Persistent memory` (volatile from here) | `system-prompt.ts:1019` | the agent's memory budget |
| 14 | `## Runtime` (+ code projects, install notes) | `system-prompt.ts:412` | ~350-500 t |
| 15 | `## Job context` | `system-prompt.ts:678` | ~50-600 t (chat line alone ~350 t) |
| 16-19 | Conversation, running work, shared inventory, git | `system-prompt.ts:955-1880` | variable |

Plus eager schemas: `return_result` alone is ~2,560 characters of description (~650 t) before its fields. Order of magnitude: a worker job ≈ 6-9K tokens of system prompt, a root orchestrator with eight teammates, an MCP server and memory ≈ 12-16K tokens, plus ~4-5K tokens of schemas. The only measured figure in the repository is ~9,000 tokens for a chat turn before the 12/09 trim (`packages/orchestration/src/tests/chat-surface-cost.test.ts:4-6`).

What a careful prompt engineer would do with it: cut the incident patches and duplicated rules quoted in TOOL-10; merge the four statements of "how a job ends" (return_result description, `## Delegated sub-task`, the team block's "what comes back", verify-before-done) into one short contract once TOOL-03 is fixed; move the delegation rules next to the delegation tool and the "never ask where to save" rule into `ask_user` / `register_project` (TOOL-11); drop `## Capabilities you can request` for delegated jobs; replace "MUST / NEVER / ⚠️ / CRITICAL" with the reason (Anthropic's guidance below); fix the heading levels (`## How you work (always)` is followed by peer `## Language mirror` headings, so the grouping it announces does not exist).

## 3. What is solid

- **The whitelist is real and the prompt never names a tool the job lacks.** Drift fails loud (`packages/tools/src/whitelist.ts:103-130`); baseline text naming an absent tool is not injected (`packages/orchestration/src/agent-baseline.ts:45-62`, #559); the team block names `assign_x` only where it exists (`team-block.ts:572-580`).
- **Every tool_use leaves with a tool_result, whatever the exit** (`execute.ts` `missingResults`/`closeTurn`, the rule of #561), duplicate `return_result` calls get a synthetic result, and message structure is validated before each call. This removes a whole class of "unmatched tool_use" deaths.
- **Deferred tool loading** with a one-line index taken from each tool's own description (`load-tools.ts:89-117`) — the pattern of Anthropic's tool search, done without a second text to maintain.
- **Two readers, two texts**: `label`/`summary` for the owner, `description` for the model (e.g. `packages/tools/src/builtin/return-result.ts:54-57`).
- **Corrective errors in most places**: an ambiguous path lists the valid labels with an example (`packages/tools/src/builtin/file-ops/workspace.ts:216-222`); an unknown tool gets "did you mean" with the available names (`execute.ts:763`) and three turns to recover, counted per turn and per job (#560/#573); the command allowlist names the refused character (`packages/tools/src/builtin/command-allowlist.ts:55-100`); `load_tools` answers `notHeld`; depth refusal says what to do instead (`packages/orchestration/src/chain-counters.ts:113-120`).
- **A rejected call is not re-asked**: same tool and input minus `purpose`, in this job, with nothing done since → the model gets the owner's reason and the permitted next move (`packages/tools/src/rejected-call.ts:102-166`). Expired and rejected markers say different things (`execute.ts:1487`, `:3500-3505`).
- **Stops are honest**: budget, time and turn stops end `failed` and deliver the last text plus a typed line (`execute.ts:4158-4167`, `:940-980`); a response cut at the output cap runs none of its calls (#554); a streamed turn cut mid-writing is resumed, not replayed (#441).
- **Reasoning continuity across tool turns**: reasoning signatures and tool-call thought signatures are mirrored to the input channel (`execute.ts:5345-5398`), with the live incidents that motivated it.
- **Delegation result is a typed record, not a transcript** (`packages/orchestration/src/router/resume.ts:26-110`, `:202-273`): status, summary, error, exit reason, tools used, files written, sub-tree outcomes, bounded so the JSON stays valid. Modelled on Hermes and stated as such.
- **The child starts clean**: brief + data + images + job folder only (`delegate.ts:89-130`) — isolated context, as Anthropic's multi-agent guidance recommends.
- **Measurement culture**: the baseline and chat prompts have size tests (`baseline-budget.test.ts`, `chat-surface-cost.test.ts`); prompt changes are replayed 20 times per variant before merging (#986, #1004, #1088); the workflow bench has 37 scenarios judged on facts — rows, files, tool outputs — never on what the model says (`packages/bench/src/workflows/scenarios.ts:1-15`).
- **What reaches the model is persisted**: system prompt, its tool list and version per job (`packages/db/src/schema/jobs.ts:188-203`), the transcript with reasoning and every runner message, every tool call with input and output.
- **CLI runtimes say what they lose**: the agent page states the CLI session has no Nodal tool, skill, connector, MCP server or delegation (`apps/web/src/app/(dashboard)/agents/[id]/edit/AgentComposer.tsx:1047-1070`); budget and per-turn tool-call kill still apply (`claude-turn.ts:122-129`, `run-job.ts:562`).

**Best three tool definitions** (what the model receives):

1. `ask_user` (`packages/tools/src/builtin/ask-user.ts:88-104`): when to use ("a decision you genuinely cannot make alone"), when not ("when the answer is already in your context… more than six options"), how ("one sentence", "in the person's own language", "Something else, let me explain"), bounded and validated options.
2. `file_move` (`packages/tools/src/builtin/file-ops/file-move.ts:920-934`): one job, explicit default ("An existing file is NEVER replaced"), the collision result names the existing file so the model can pick another name, and when to prefer it ("instead of a shell command").
3. `file_edit` (`packages/tools/src/builtin/file-ops/file-edit.ts:68-78`): exact-string replace with the two failure modes named and their fix ("you misquoted", "narrow the quote, or pass replace_all:true") — the Claude Code edit contract.

## 4. Findings

### TOOL-01 · P2 · CONFIRMED · NEW
**After compaction, a delegation that produced nothing is counted as delivered, and the model is told to "re-run" tools that must not be re-run.**
- Where: `apps/runner/src/job/execute.ts:596`, `:4426-4450`; `apps/runner/src/job/tool-result-shape.ts:25-26`
- Evidence:
  ```ts
  return { ...p, output: { type: 'text' as const, value: EVICTED_TOOL_RESULT_MARKER } };      // :596
  } else if (!estErreur && value.trim() !== '') {                                              // :4428
  // … ou un texte posé par la compaction ne réparent rien …                                   // :4431 (the comment)
      delegationOutcomes.set(name, record && record.status !== 'completed' ? 'failed' : 'delivered');
  '[earlier tool result elided to fit the context window — re-run the tool if you need this data again]'
  ```
- Scenario: a root's `assign_researcher` returns the `error-text` failure; the run goes on with large reads until its prompt passes 70% of the window; compaction rewrites that result as the plain-text marker and the checkpoint persists it; the root then delegates again and is resumed. The resume re-seeds outcomes from the transcript: the marker is non-empty `text`, not an error, has no JSON → `'delivered'`. The `[delegation stopped: researcher — no deliverable]` line is not added to the user's result, and the parent's `sub_delegations` says delivered. The comment at `:4431` states the opposite of what the code does. Second scenario (PLAUSIBLE, model-dependent): an evicted `ask_user` answer or `assign_*` result is replaced by "re-run the tool" — re-running means asking the person again or re-delegating the whole task.
- Fix: compaction must know what it evicts. One rule for every tool: results of tools whose call is not idempotent (`asksUser`, delegation, `riskLevel` write/destructive) are kept, or replaced by a short typed summary that preserves their outcome (status, the answer, the child's summary head); the marker says "re-run" only for reads. The outcome seeding reads the shape through `toolResultShape` (`tool-result-shape.ts:95`), which already knows `'elided'`, and leaves an elided outcome unchanged. Reaches every reader of old tool results: the seeding loop, the empty-deliverable guard, the exchange record.
- Effort: S (seeding) + M (kind-aware compaction).
- Hermes / best practice: Hermes summarizes the middle with an auxiliary model and protects head and tail (`hermes:agent/context_compressor.py:1-2`). Anthropic, "Effective context engineering for AI agents": tool-result clearing is the lightest compaction, for results the agent no longer needs.

### TOOL-02 · P2 · CONFIRMED · NEW
**On a long command output the model reads the start of stdout and loses stderr, the exit details and the end of the output, with no way to get them.**
- Where: `packages/tools/src/builtin/run-command.ts:248`, `:276-286`; `apps/runner/src/job/execute.ts:3125-3126`; `packages/shared/src/tool-result-budget.ts:51-58`; `packages/catalog/src/skills/command-execution.ts:34`
- Evidence:
  ```ts
  keep: 'head',                                                                // run-command.ts:248
  sandbox: sandboxReport(run), exitCode: …, stdout: run.stdout, stderr: …,     // :276-284, key order
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return { type: 'json', value: json };
  return { type: 'text', value: truncateForContext(serialized) };              // execute.ts:3125-3126
  value.slice(0, room) + `\n\n[... truncated: ${dropped} chars dropped …]`     // budget.ts:55
  6. **Output is capped** (~100k characters per stream).                       // command-execution skill
  ```
- Scenario: `pnpm build` prints 30,000 characters of progress on stdout and fails with the TypeScript error on stderr. The JSON is over 25,000 characters, so the model receives `sandbox`, `exitCode: 1` and the first ~24,900 characters of stdout, escaped as JSON; `stderr`, `timedOut`, `truncated`, `cwd` and `paths` are gone. The skill told it the cap is 100,000 characters per stream, so it does not know it was cut at 25,000; the marker gives no path or page. It re-runs the build, or guesses. Same engine for `run_skill_script` (`run-skill-script.ts:412`); the same head-only cut applies to every tool result over the budget (web pages, MCP results).
- Fix: one rule in the result converter, for every tool: over budget, keep head and tail around one marker, and write the full result to a file in the job's folder, giving its path in the marker so `file_read` can page it. `run_command` renders its own model text (`toModelOutput`): exit code and stderr first, stdout tail-biased, plain text instead of escaped JSON. Correct the skill's stated cap. Reaches every tool through `toResultOutput`.
- Effort: S-M.
- Hermes / best practice: `hermes:tools/tool_output_truncate.py:1-33` (40% head / 60% tail, one marker), `hermes:tools/terminal_tool_result.py:170-195` (spill file so the model can read the omitted middle), `hermes:tools/tool_result_storage.py:1-6` (persist + preview + path). Anthropic, "Writing effective tools for AI agents": when truncating, steer the agent with instructions on how to get what was cut.

### TOOL-03 · P2 · CONFIRMED · NEW
**There are four ways for a job to give its answer, explained in a 2,560-character tool description, and a family of guards exists to catch the model choosing wrong.** (Worst tool definition, #1.)
- Where: `packages/tools/src/builtin/return-result.ts:53-92`; `packages/tools/src/builtin/dashboard-publish.ts:27-40`; `packages/orchestration/src/system-prompt.ts:1715-1735`
- Evidence:
  ```
  'Your answer is your written reply, unless the `delivery:` line of your Job context says a send tool is the only way …'
  'If you finish with return_result alone after more actions, put that answer in `reason` (status="success"). '
  'If you write your answer as your final message text, it is captured automatically; this tool makes it explicit …'   // dashboard_publish
  '**Same-response with return_result (CRITICAL for cost & latency)**'
  ```
- Scenario: the answer can be the final text, `return_result.reason`, `dashboard_publish`, or a channel send, and which one counts depends on the step it was written in and on a line of Job context. Models get it wrong often enough that the loop carries an empty-deliverable nudge (`execute.ts:4543`), a blocked-without-reason nudge (`:6698`), a duplicate-`return_result` result, a sibling-error deferral, a delivery nudge, and the #1083 reading of "which text is the answer". Each nudge is one more model call, and each guard is a place where the next interaction bug lives (TOOL-01).
- Fix: one way to end. The final assistant text is the answer on every surface; a turn with no tool call ends the job (the provider's own end-of-turn signal); `blocked` becomes a field of that end (or a tiny `report_blocked(reason)`), deliverables a separate declaration; on a send-only channel the runner sends the final text itself (it already delivers CLI text verbatim). Then remove `dashboard_publish`, `reason`-as-answer and most of the guards listed. Reaches every surface, the task board's compiled results, the delegation summary, and the bench judges.
- Effort: L.
- Hermes / best practice: Hermes ends a turn on a final response without a terminal tool (`hermes:agent/prompt_builder.py:383-396`, "Finishing the job"), and on messaging platforms the gateway delivers that response itself: "there is deliberately no agent-callable send_message tool" in its full toolsets (`hermes:toolsets.py:183-185`). Anthropic, "Building effective agents": design the agent–computer interface so mistakes are hard to make (poka-yoke).

### TOOL-04 · P2 · CONFIRMED · NEW
**Delegation has two tools with opposite contracts: `assign_*` brings the result back but one at a time; `create_task` runs in parallel but the orchestrator never reads what came back.** (Worst tool definition, #3: `assign_<slug>`.)
- Where: `packages/orchestration/src/router/assign-tools.ts:14`, `:92`; `router/only-one-per-turn.ts:48-60`; `packages/orchestration/src/team-block.ts:468-508`; `apps/runner/src/cron/deliver-results.ts:456-466`
- Evidence:
  ```ts
  const description = `Assign a task to ${agentName}.`;
  task: z.string().describe('What this agent should do. Be specific and complete.'),
  'You orchestrate the agents below. You have TWO ways to delegate — choose the one that fits the request:'
  'Pick ONE style per request — do not mix them in the same job. '
  system: 'You write the SHORT chat reply that closes out a multi-agent run for the user. …'    // deliver-results.ts:458
  ```
- Scenario: "compare these three suppliers and recommend one". With `assign_*`, three sequential hand-offs (three resumes against the 15-chain cap, TOOL-05). With `create_task`, the three run concurrently, the root ends its turn, and the reply is written by a generic synthesis call that sees only the request and the concatenated results — not the root's personality, not its tools, and no chance to check or reconcile what came back (verify-before-done's "read what it delivered" cannot be obeyed). The two styles are forbidden to mix in one job; the team block spends ~1,600 tokens explaining the choice. If the synthesis call fails, the raw compiled text is sent with only a log code (`deliver-results.ts:420-421`).
- Fix: one delegation tool taking a list of briefs; the runner runs them concurrently (the task board already can), suspends the parent once, and resumes it with one typed record per child in one tool result; the parent writes the reply. `depends_on` stays as an option of the same tool. Removes the "one per turn" filter, the mixing rule, the synthesis prompt and the "THE FINAL SUMMARY IS AUTOMATIC" block. Reaches routines, MCP `run_task`, the bench delegation scenarios.
- Effort: L.
- Hermes / best practice: `hermes:tools/delegate_tool.py:843-905` — one `delegate_task` with `tasks[]` (batch, concurrent), per-task `context` ("Each child sees only its own context"), `output_schema` validated by the parent, `group` for joined delivery, and steer/stop/continue. Anthropic, "How we built our multi-agent research system": the lead agent synthesizes the subagents' condensed results itself.

### TOOL-05 · P2 · CONFIRMED · NEW
**A run that reaches 15 resumes is refused at entry and delivers nothing, without the model ever being warned; and every job, top-level included, stops at 50 turns, a cap the owner cannot see or change.**
- Where: `apps/runner/src/job/execute.ts:1811-1825`, `:4653-4658`, `:1082-1103`; `packages/orchestration/src/chain-counters.ts:44-48`
- Evidence:
  ```ts
  if ((job.chainCount ?? 0) >= DEFAULT_LIMITS.maxChains) {
    await failJob(db, jobId as string, 'chain_limit_exceeded', { … });      // no deliverable argument
  maxTurns: 50, // matches Hermes Agent's per-subagent iteration budget
  const limites = [`turn ${f.maxTurns} (this is turn ${f.turn})`];          // the reminder names turns, not chains
  ```
- Scenario: "fill these 16 vault pages", done page by page through `assign_*` (TOOL-04 makes that the in-line route). Each child delivers; the 16th resume hits the cap at entry and the job ends `chain_limit_exceeded` with no result text, while a budget or turn stop would have handed over what was written (`arreterSurBudget`, `:4158-4167`). Repair turns also count against the 15. Separately, a long coding or production job on one agent, one tool call per turn, ends at turn 50 with `[stopped: turn limit — 50 turns, ceiling 50]`; Settings → Run budget sets cost and time but not this.
- Fix: one stop path for every run limit — chains included — that delivers the last text and the typed stop line; the progress reminder names every limit that will stop the run, chains included; the turn cap becomes a workspace setting beside cost and time, with a top-level default sized for long work and the 50 kept for delegated children.
- Effort: S (stop path) + S (setting).
- Hermes / best practice: `hermes:agent/iteration_budget.py:1-6` — parent cap 500 by default, subagent 50; a budget-warning ratio and a final grace call (`hermes:agent/conversation_loop.py:1753`).

### TOOL-06 · P2 · PLAUSIBLE · NEW
**The runner's corrective messages to the model are written in French, for every user, and are the last message the model reads before writing to the person.**
- Where: `apps/runner/src/job/execute.ts:1131-1136`, `:3729-3734`, `:3978-3985`, `:4364-4372`, `:4543-4552`, `:6698-6699`; `apps/runner/src/chat/turn-stop.ts:51`, `:64`
- Evidence:
  ```ts
  `[système] Tu es sur ${channelDisplayName}. Tu n'as pas encore livré ta réponse à ` +
  `[système] Tu es sur ${channelDisplayName} et une de tes actions vient de créer une demande d'approbation … dire à l'utilisateur, avec tes propres mots …`
  "[système] Ne déclare pas un succès qui n'a pas eu lieu. …"
  ```
- Scenario: an English-speaking owner on Telegram; `run_command` needs approval; the approval nudge, in French, asks the model to tell the user in its own words that it waits. The project's own measurements show that French text close to the reply pulls replies into French: 20-50% of acknowledgements on Haiku 5.5 from French memory notes (#1004), and "what governs the reply is read last" (#1088, `system-prompt.ts:645-669`). Here the French text is the very last message. Other messages of the same loop are in English (`[system] Progress note`, `VERIFY_BEFORE_ASSERT_NUDGE`), so one run mixes both. Missing link: no replay of these nudges with an English request has been measured.
- Fix: all runner-to-model messages in one language-neutral register — English, stating facts and the next move, never the reply's wording — in one module, with the replay method of #1004 (20 runs, two models) proving no language drift. Reaches every nudge of the job loop and the chat stop notes.
- Effort: S.
- Hermes / best practice: Hermes's runner guidance blocks are English (`hermes:agent/prompt_builder.py:344-432`); not otherwise covered.

### TOOL-07 · P2 · CONFIRMED · NEW
**A two-language keyword list on the first 200 characters of the request holds a finished first turn and orders platform reads — a special case of the kind invariant #11 forbids.**
- Where: `packages/orchestration/src/chain-counters.ts:289-299`; `apps/runner/src/job/execute.ts:4299-4309`, `:6563-6593`
- Evidence:
  ```ts
  export const CANCEL_UNDO_INTENT_RE =
    /\b(annule[rz]?|cancel|undo|supprime[rz]?|enl[eè]ve[rz]?|retire[rz]?|d[ée]sactive[rz]?|arr[êe]te[rz]?)\b/i;
  'Runtime notice: the user asked to cancel/undo something. Verify actual platform state with your READ tools (list_schedules, list_conversations, ...) …'
  ```
- Scenario: "How do I undo my last git commit?" on Telegram. Turn 1 answers with `telegram_send_message` + `return_result`; the message is already sent; the completion is held, the model is told the user asked to cancel something and to call `list_schedules`; it spends a turn and may send a second message. A German user's "storniere den Termin" gets nothing. The same rule is already in the prompt (verify-before-done, "Asked to cancel or remove something, read first", `packages/catalog/src/skills/verify-before-done.ts:60`).
- Fix: remove Guard 1g; the prompt rule and the bench scenario `undoable-action` (`packages/bench/src/workflows/scenarios.ts:622`) carry the behaviour and measure it. If a runtime check is wanted, it must read facts (a platform-state claim in the reply with no read tool in the turn), not words in one language.
- Effort: S.
- Hermes / best practice: not covered by an equivalent guard.

### TOOL-08 · P2 · CONFIRMED · NEW
**Parallel execution is all-or-nothing: one write, or any MCP tool, in a batch makes every call run one after the other; and the prompt never asks the model to batch independent calls.**
- Where: `apps/runner/src/job/execute.ts:5898-5934`; `packages/adapters/mcp/src/tools.ts:210-213`
- Evidence:
  ```ts
  const parallelizable = callsToProcess.length > 1 && callsToProcess.every((c) =>
      !c.name.startsWith('assign_') && toolMap.get(c.name)?.riskLevel === 'read' && !wouldRequireApproval(c.name));
  function riskFromAnnotations(a) { if (a?.destructiveHint === true) return 'destructive'; return 'write'; }
  ```
- Scenario: a turn with five `file_read` and one `file_write` to another path runs six calls serially; five searches on a Notion MCP server always run serially (every MCP tool is `write`, rightly, for approvals — but the same field decides parallelism). No sentence in the baseline, the tool index or the descriptions tells the model that independent calls in one response run together (only `return_result`/`dashboard_publish` mention same-turn calls), so a model that issues one call per turn pays one round trip each (~1.4 s plus what it writes, and the whole context re-sent).
- Fix: plan the batch in ordered segments, as Hermes does: reads in parallel, file writes in parallel when their resolved paths do not overlap, a barrier at anything else; decide parallel safety by a tool property separate from the approval risk (an MCP server can be marked parallel-safe by its owner). Add one line to the baseline: independent reads and searches go in the same response. Reaches every tool and the approval single-card rule (which stays: gated calls remain barriers).
- Effort: M.
- Hermes / best practice: `hermes:agent/tool_dispatch_helpers.py:31-51`, `:213-259` (segment planner, path-scoped writers); `hermes:agent/prompt_builder.py:411-422` (parallel-call guidance, with the cost reasoning); `hermes:tools/mcp_tool_discovery.py:819-826` (MCP servers opt in). Claude prompting best practices, section on parallel tool calling: tell the model to make independent calls in the same response.

### TOOL-09 · P2 · CONFIRMED · NEW
**An agent has no plan of its own for long work, and compaction keeps nothing that would stand for one.**
- Where: `packages/orchestration/src/planner/task-tools.ts:1-60` (the "planner" is the delegation board); `apps/runner/src/job/execute.ts:565-617` (compaction)
- Evidence:
  ```ts
  // planner/task-tools.ts — create_task and list_tasks tools for planner orchestrators
  assigned_to: z.string().describe('Handle (slug) of an agent of YOUR team, as the roster lists it.'),
  ```
- Scenario: a single agent asked to "migrate these 12 pages and check each one" works for 30 turns; when compaction fires, everything but the last three tool results is gone; nothing lists which pages are done, so it re-reads, skips one, or ends early on a partial set. The task board cannot help: it is only for teammates, needs a team (`delegation-tools.ts:26-35`), and its tasks run elsewhere.
- Fix: a `todo` tool for the job itself — the list lives on the job row (like `loaded_tools`), every call returns the whole list, and the runner re-injects the active items after compaction and on resume. One mechanism for every agent and surface; the task board stays for delegation.
- Effort: M.
- Hermes / best practice: `hermes:tools/todo_tool.py:1-25`, `:227-245` (one `todo_list` tool, re-injected after compression, only active items). Anthropic, "Effective context engineering for AI agents": structured note-taking outside the context window.

### TOOL-10 · P3 · CONFIRMED · NEW
**The prompt accumulates incident patches and repeats rules, which costs tokens on every job and pulls the model toward past incidents.**
- Where: `packages/orchestration/src/team-block.ts:497-506`, `:640-645`; `packages/catalog/src/skills/platform-questions.ts` (content); `packages/orchestration/src/system-prompt.ts:444`, `:1551-1562`, `:1689`; `packages/tools/src/builtin/search-history.ts:47`; `packages/tools/src/communication/send-image.ts:83-87`
- Evidence:
  ```
  '⚠️ THE FINAL SUMMARY TO THE USER IS AUTOMATIC — NEVER MAKE IT A TASK. … even when the user says "puis fais une synthèse et envoie-la moi" …'
  '… never for knowledge OF the platform, even asked for as work (a research on its changelog, for one): that stays yours.'   // also the whole platform-questions skill
  'For ANY skill even partially relevant to your task, you MUST call `skill_view(…)` … even if you think you could do the task with basic tools.'
  '(a local API, a database, or an app such as ComfyUI on `:8188`)'   ·   '"what ComfyUI port did we use?"'   ·   '($2+ burns observed in live jobs)'
  ```
- Scenario: every orchestrator of every install reads a French example from one owner's request inside an English prompt, the changelog rule twice, the owner's ComfyUI port in three places; every delegated worker receives `## Capabilities you can request` (~1,000-1,500 tokens) although it cannot ask anyone for anything; "MUST… even partially relevant" makes a strong model load skills it does not need (one `skill_view` round trip plus up to ~24K characters per skill).
- Fix: a rule appears once, next to the tool or fact it governs, stated as a fact with its reason and without capitals; examples are neutral; blocks are sent only to the jobs that can act on them (the existing `namesOnlyHeldTools` idea, applied to `## Capabilities` for delegated jobs). Gate every prompt change on the replay method already used for #986 and on the bench (change 3 below). Extend the size test from the baseline to the whole assembled prompt per surface.
- Effort: M.
- Hermes / best practice: Hermes ships short universal blocks and measures model-specific ones before shipping them (`hermes:agent/prompt_builder.py:356-362`, Nemotron measured 5×5 and left out). Claude prompting best practices: "dial back aggressive language" (tools prompted with "CRITICAL: You MUST" now overtrigger) and give the reason behind an instruction.

### TOOL-11 · P3 · CONFIRMED · NEW
**Two pairs of instructions contradict each other: whether to ask where to save, and whether to query memory before a task.**
- Where: `packages/orchestration/src/system-prompt.ts:1150-1151`, `:1049-1050`; `packages/tools/src/builtin/ask-user.ts:95`; `packages/tools/src/builtin/register-project.ts:89-99`; `packages/tools/src/builtin/query-memory.ts:51-52`
- Evidence:
  ```
  `New files you create go in **${home.label}** unless the user names another place: never ask where to save, and say where you put it.`
  'Use it for a decision you genuinely cannot make alone — where to write something, …'            // ask_user
  'ask where first with `ask_user`, then call this'                                                  // register_project
  'Use before starting a task to recall relevant context …'                                          // query_memory
  `DO NOT call \`query_memory\` to look up facts already listed here — only call it for facts that look missing.`
  ```
- Scenario: a routine that writes a report: one model follows `ask_user` and suspends the unattended run on a question until it expires; another follows the Workspace block. A job whose memory block already lists the facts spends a first turn on `query_memory` because its description says to.
- Fix: the owner's rule of 02/10 ("never ask where to save") moves into `ask_user` and `register_project` themselves, and the Workspace block stops restating it; `query_memory`'s description says "for facts not in your Persistent memory block". A test that the assembled prompt and the tool descriptions do not give opposite orders on the same gesture is hard to write; the bench `ask-before-acting` scenario (`scenarios.ts:757`) is the place to measure it.
- Effort: S.
- Hermes / best practice: not covered.

### TOOL-12 · P3 · CONFIRMED · NEW
**Every job is told to read back each file it writes, which costs a round trip and a second copy of the file in the context for a check the finalizer already does.**
- Where: `packages/catalog/src/skills/verify-before-done.ts:55`
- Evidence: ``- After a \`file_write\`, \`file_read\` the path and confirm the content.``
- Scenario: an agent writes a 20,000-character HTML report: `file_write` already returned `bytes` and wrote atomically; the read-back adds a turn and ~5,000 tokens re-sent on every later turn. The real checks — the file exists and is valid — run at finalization on declared deliverables (`return_result.deliverables`, #509) and through `declare_verification`.
- Fix: replace the line with what the runner cannot check: "run what you built, check the counts and the format against the request; list the files you deliver". Same lot-2 rule that removed runtime-enforced lines from the baseline (`safe-tool-use.ts:21-30`).
- Effort: S.
- Hermes / best practice: Hermes keeps external-write read-back only in a model-family block measured on evals (`hermes:agent/prompt_builder.py:366-376`).

### TOOL-13 · P3 · CONFIRMED · NEW
**The text-send tool is named for Telegram and sends on four channels; five more send tools split one gesture by file type, each "via Telegram".** (Worst tool definition, #2.)
- Where: `packages/tools/src/communication/telegram-send-message.ts:125-161`; `send-media.ts:191`, `:222`, `:246`; `send-file.ts:92`; `send-image.ts:81`
- Evidence:
  ```
  name: 'telegram_send_message', label: 'Send a Telegram message',
  description: `Send a text message on a messaging channel (Telegram, Discord or Slack).
  … the tool throws \`telegram_no_bot_token\`.
  `Deliver a video to the user with an INLINE PLAYER via Telegram (sendVideo).`
  ```
- Scenario: an agent on Slack is told by its delivery nudge to call `telegram_send_message` (`execute.ts:3724-3734` keeps the name on purpose); the owner's Autonomy tab reads "Send a Telegram message"; a missing Slack token surfaces as `telegram_no_bot_token`. The model picks between six send tools whose descriptions cross-reference each other.
- Fix: one `send_message` (text plus optional attachments with a `kind` enum: file, image, video, audio, voice) whose description and errors name the channel generically; the adapter decides how each kind is sent. Reaches the delivery guard, the spam guard, `DELIVERY_TOOL_NAMES`, autonomy rows (a migration renames the rows), and the bench judges that read `channelSends`.
- Effort: M.
- Hermes / best practice: Anthropic, "Writing effective tools for AI agents": consolidate tools that are steps of one task, name tools for what they do. Hermes has one `send_message` whose target is `platform:chat` for every platform (`hermes:tools/send_message_tool.py:50-57`), and in a gateway session it is not offered at all: the gateway delivers the final reply (`hermes:toolsets.py:183-185`).

### TOOL-14 · P3 · CONFIRMED · related #886, #743
**Every prose reply on the dashboard chat pays a second model call, for a failure the chat prompt also fights with "CRITICAL" language.**
- Where: `apps/runner/src/chat/run-chat-turn.ts:1073-1131`; `apps/runner/src/llm/action-recheck.ts:9-14`; `packages/orchestration/src/system-prompt.ts:687-716`
- Evidence:
  ```
  // La boucle des jobs ne relit plus rien (#886) : … Le chat garde la sienne, inchangée, jusqu'à ce qu'elle soit mesurée à son tour.
  'CRITICAL: writing in text that you will do something (e.g. "I\'m starting X…") does NOT start anything — ONLY an actual `run_task` …'
  ```
- Scenario: "What's the difference between a skill and a connector?" — the reply streams, then the turn waits for a second call (request + reply + instruction + schema) before it ends. #886 measured the same mechanism in the job loop and removed it; the chat one waits for a measurement no issue tracks. It is a symptom of the chat surface holding one tool: the model must decide to escalate, and a narrated intent is the failure.
- Fix: measure it the way #886 did (catch rate vs. no-op and duplicate rate over a month of chat turns) and remove it if it does not pay; the general form is a chat turn that runs the agent's own loop, so there is no escalation decision to narrate.
- Effort: S (measure) / L (one loop).
- Hermes / best practice: Hermes gateway turns run the full agent (`hermes:gateway/run_turn_prepare.py` constructs `AIAgent`); the narrated-action failure is handled by a prompt block for the model families measured to need it (`hermes:agent/prompt_builder.py:344-362`).

### TOOL-15 · P3 · CONFIRMED · NEW
**A turn with more than 50 tool calls fails the job with nothing delivered and no chance to split the batch.**
- Where: `apps/runner/src/job/execute.ts:5323`, `:7421-7431`
- Evidence:
  ```ts
  counters.admitTurn(rawToolCalls.length);
  if (err instanceof ToolCallLimitExceededError) { … await failJob(db, jobId as string, code, runStats(), messages); return { status: 'failed', error: code }; }
  ```
- Scenario: an agent asked to read 60 small files issues them in one turn; none runs and the job fails `tool_call_limit_exceeded` with no result text. The same loop gives an unavailable tool name three corrective turns (`:5684-5711`).
- Fix: the same bounded corrective path as the unavailable-tool budget: one corrective message ("this turn had N calls, the limit is 50, none ran; issue at most 50"), then fail, delivering the last text like the other stops (TOOL-05). The degenerate 307-call case of #564 still fails on the second refusal.
- Effort: S.
- Hermes / best practice: not covered (no per-turn cap in the Hermes loop).

### TOOL-16 · P3 · CONFIRMED · still open since #643
**A tool call that failed inside a Claude Code session is recorded like a success.**
- Where: `apps/runner/src/cli-runtime/claude-turn.ts:263-267`
- Evidence:
  ```ts
  } else if (block['type'] === 'tool_result') {
    onEvent?.({ kind: 'tool_result', toolUseId: …, output: stringifyCapped(block['content']) });
  ```
- Scenario: `cli:WebFetch` gets a 404; the `tool_calls` row holds the error text like a page; the bench never counts a source read through a CLI (false red, `packages/bench/src/workflows/judge-kit.ts`), and the Code tab or project scan can take a failed call for a done one when its content lacks `<tool_use_error>` (`apps/runner/src/job/code-projects.ts:589-590`). Reach verified for the bench; for Edit-type tools the envelope is usually in the content, which no recorded stream in the repository proves.
- Fix: as #643 states — map `is_error` to the envelope Codex already uses (`codex-turn.ts:298`), once, at the stream reader.
- Effort: S.
- Hermes / best practice: not applicable (Hermes does not wrap external coding CLIs this way).

**What the CLI runtimes keep and lose (question 8).** Kept: job lifecycle, Stop and the brake (`shell-turn.ts`), the per-agent budget and the run cost ceiling (checked before each turn only, `run-job.ts:562`, so one turn of up to 15 minutes can overshoot it), the per-turn tool-call kill gate, workspace locks, verification intents and deliverable checks at finalization (`run-job.ts:720-735`, `:1109`), cost recording (`cli_runs`), memory facts injected read-only. Lost, and said on the agent page: Nodal's tools, skills (not even listed), connectors, MCP servers (`--strict-mcp-config` with no config), delegation, `ask_user`, per-tool autonomy rows, Nodal's OS sandbox (commands run "outside", `provider.ts:60-73`). The only silent one found is TOOL-16.

## 5. The changes that would most improve output quality or cost

The owner asked for five; the first three are this area's ranking.

1. **One way to end a job and one way to delegate (TOOL-03, TOOL-04).** For the user: answers stop going missing between text, `reason` and `dashboard_publish`; parallel work comes back to the agent that asked for it, which can check and combine it before replying; fewer nudge turns. Cost: L — touches the loop's ending gates, the task board, the delegation resume, the prompt and the bench judges; it removes more code than it adds (the one-per-turn filter, the mixing rule, the synthesis prompt, four or five guards).
2. **Tool results that keep what matters (TOOL-02, TOOL-01).** Head-and-tail cuts with the full result saved to a path; `run_command` rendered as text with exit code and stderr first; compaction that knows which results must not be "re-run" and keeps their outcome; outcome seeding through `toolResultShape`. For the user: builds that fail are diagnosed instead of retried blind; long runs stop re-asking or re-delegating; failed delegations stay reported. Cost: S-M.
3. **Make prompt changes measurable, then clean the prompt (TOOL-10, TOOL-11, TOOL-06, TOOL-07, TOOL-12).** Key bench results by prompt hash and commit, not only by Nodal version (`packages/bench/src/workflows/results.ts:191` groups by `nodalVersion` although each trial records `stackCommit`), and add a prompt-size report per surface to `pnpm bench`; then remove incident patches and contradictions, write runner messages in one neutral English register, drop Guard 1g. For the user: fewer wrong-language replies, fewer odd detours, a cheaper prompt; for the owner: a prompt change shows up as a number before release. Cost: M.
4. **A plan that survives the run, and a turn budget sized for it (TOOL-09, TOOL-05).** A `todo` tool stored on the job row and re-injected after compaction; the turn cap as a setting with a top-level default above 50; every stop delivering what was written. For the user: long multi-item tasks finish whole. Cost: M.
5. **Parallel by default when safe (TOOL-08).** Segment planner (reads, and writes to disjoint paths, run together), parallel safety as its own tool property, one baseline line telling the model to batch. For the user: multi-read turns take one round trip instead of N, and MCP-heavy agents speed up. Cost: M.

## 6. Leads not confirmed, and what could not be checked without a live run

Leads not confirmed:
- **Routing quality of the roster.** A teammate's `Purpose` is the first one or two sentences of its personality (`packages/orchestration/src/router/assign-tools.ts:52-67`); there is no owner-written "when to delegate to me" field (`packages/db/src/schema/agents.ts` has `personality` only; per-assignment `instructions` exist). Whether this misroutes was not measured.
- **Exact system prompt per surface.** The sizes in §2 are read from source, not from an assembled prompt.
- **How often compaction fires** (trace `context_compacted`) and how often models then re-call `ask_user` or `assign_*`: only the runner log has it, and it was not read (out of bounds).
- **Deferred tools called without their schema.** The runner accepts a direct call to a deferred tool (`execute.ts:5712`); the rate of `invalid_input` on such calls is unknown.
- **The dashboard's run page** was not found to show the job's exact system prompt (it is persisted, `jobs.ts:188`, and previewed in Settings → Root context); guard events (`trace`, `execute.ts:1750-1752`) go to stderr only, so the owner sees why a guard fired only through the `[système]` messages left in the transcript.

Needs a live run:
- Language drift caused by the French nudges (TOOL-06): 20 replays, two models, an English request, per the #1004 method.
- Whether the parallel-call line (TOOL-08) changes how many calls models put in one turn.
- The share of chat turns where the re-check (TOOL-14) launches a job, does nothing, or duplicates one.
- Whether a Claude Code Edit failure carries `<tool_use_error>` in its content (TOOL-16 reach).

Sources: Anthropic, [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents); [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents); [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices); [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools); [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). Hermes files are cited inline (`hermes:`).
