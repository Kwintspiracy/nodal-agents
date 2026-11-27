# VERIFY — verification of tasks (does "completed" mean done?)

Worktree read: `origin/main` at `b0ab6d535`. All paths below are relative to it.
Hermes copy read: `NousResearch/hermes-agent (local clone)`.

## 1. Verdict

Nodal checks by code, at one terminal gate shared by every runtime (`apps/runner/src/job/finalize.ts`), a narrow but carefully built class of claims: files the agent declares (exists, not empty, encoding, format header or syntax), what its own tools wrote (fingerprints before/after, git delta), messages its send tools posted (the provider's answer plus a delivery guard), and an owner-approved test suite. Everything else a request can name (an e-mail, a print, a calendar write, an MCP action, the substance of a delegated task, "the thing you asked for was done") rests on the model's word, and the runner lets a run end `completed` over three contradictions it already holds: a non-delivery tool whose last call failed, a red proof on an undeclared deliverable after its repair turn, and a reviewer's `request_changes`. When a run does fail, a person on a messaging channel is told for only 3 of about 20 failure exits; the others leave silence. `completed` can be trusted for "a declared file of that type is at that path" and "a message reached the chat"; it cannot be trusted for outward actions, for CLI-runtime runs, or for "everything the request named was done". **Grade: C** — the proof machinery itself is B+/A quality, the scope it covers is too narrow for the word "completed".

## 2. How it works today

1. Before a mutating tool runs, the seam marks the target's state row dirty (`packages/tools/src/execute.ts:688`, `takeMutationIntent`), snapshots every workspace once per turn (`execute.ts:701`, `:1513`), and, only for tools that target a directory (`run_command`, `code_task`), reads `git status` (`execute.ts:817`, `verification/git-constat.ts:545`).
2. After it, the writes actually seen are recorded (`execute.ts:1032`, `constated_writes`), `produced` is set only for a write that was observed (`execute.ts:1061`, `verification/produced.ts:43`), the project epoch is bumped (`execute.ts:890`). Every file read is fingerprinted into `tool_call_reads` (`verification/tool-call-reads.ts:36`) — read today only by the bench.
3. A tool error puts the tool name in `unresolvedToolFailures`; a later success clears it (`apps/runner/src/job/execute.ts:6398-6407`). An error in the same turn as `return_result` defers it (`execute.ts:6627-6646`).
4. A run ends by `return_result {status, reason?, deliverables?}` (`packages/tools/src/builtin/return-result.ts:14-47`) or by a text with no tool call (`execute.ts:5428`, `:5452`). Guards, in order: `blocked` needs a reason and, on a chat, a delivery (`execute.ts:6672-6780`); an unresolved failure of a **delivery** tool gets 2 nudges then `unresolved_tool_failure` (`execute.ts:6782-6832`); a tool-only channel that got nothing gets 2 nudges then `telegram_not_delivered` (`execute.ts:6849-6880`); an empty answer gets 1 nudge then `empty_deliverable` (`execute.ts:6883-6995`); declared files become `declared` state rows (`execute.ts:7030`, `verification/declared-deliverables.ts:96`).
5. `finalizeJobSuccess` (`finalize.ts:789`): transaction 1 locks the job, claims it, loads each state row's verifier config (`finalize.ts:817-1003`); the proof runs outside any transaction (`finalize.ts:1018`); transaction 2 re-checks generation, epoch and the proved hash (`finalize.ts:1105-1170`), opens at most N repair turns (space setting 0-3, default 1; `finalize.ts:1204`, `ouvrirReparation`), fails a **declared** row that is not green as `deliverable_not_verified` with a platform line sent where the promise went (`finalize.ts:1244-1300`), else writes `completed` (`finalize.ts:1315`). `completed_unverified` is computed and returned (`finalize.ts:1397`), stored nowhere, read by nobody.
6. Verifiers: `document` is always ready and has no power (`apps/runner/src/verification/document.ts:854-1074`); `office_file` always answers `not_configured` (`verification/office-file.ts:61`); `code_project` runs only an owner-approved command manifest (`verification/code-project.ts`, `loadConfig`).
7. Repair brief: the red command verbatim, bounded tails, turns left per deliverable, "do not repeat outside actions" (`verification/repair-brief.ts:135-174`); the turn counts on `chain_count`.
8. Delegation: the parent receives a typed `DelegationOutcomeRecord` (status, exit_reason, subtree verdicts, `delivery_blocked`, `sub_delegations`, `files_written` with states; `packages/orchestration/src/router/resume.ts:36-110`); the harness appends `[delegation stopped: … — no deliverable]` to the parent's result (`execute.ts:3756-3771`).
9. Review: `review_verdict` validates shape only (`packages/tools/src/builtin/review-verdict.ts:44-88`); verdicts are read from `tool_calls` (`router/job-deliverable.ts:121`); the reviewer's commands are copied to `verification_runs` (`apps/runner/src/verification/reviewer-runs.ts`).
10. Delivery: harness notices and CLI answers go through an outbox prepared inside the terminal transaction, claimed atomically, `rejected` alerts the owner (`apps/runner/src/delivery/outbox.ts:1-48`).
11. CLI runtime: a turn with any final text and no session error is a success (`apps/runner/src/cli-runtime/run-job.ts:476`), finalized with `repairTurn: 'unsupported'` (`run-job.ts:1109-1125`).
12. Restart: a turn is replayed only if no non-read effect happened after its checkpoint (`apps/runner/src/cron/reclaim-jobs.ts:140`, `:155-198`).

### 2b. What each kind of claim rests on (question 1)

| Claim | Checked by code? | How | When the check fails |
|---|---|---|---|
| File written by a file tool | yes (existence + content change) | sha256 before/after the call; state row typed by place: `document` (proved at end), `code_project` (approved commands, else `not_configured`), office tools → `office_file` (never proved) | undeclared red → repair turn, then `completed` with no line; declared → `failed` + line on the channel |
| File produced by a command (render, export) | only if declared, or seen by the git delta in a git tree | document proof; binary formats by header bytes only (`document.ts:540-542` says a truncated body passes) | undeclared → nothing |
| File moved | yes for `file_move` (declared + confirmed, `absent:moved-to`); a shell `mv`/`rm` is `exists:removed-by-this-run`, red (#916) | `verification/removed.ts` | repair turn on an undeclared row |
| Message sent by a send tool | yes | adapter's API answer (`communication/telegram-send-message.ts:209-224`), partial-chunk resume, delivery guard on tool-only channels | a failed send: 2 nudges, then `unresolved_tool_failure` with no notice to the chat (VER-02); nothing sent at all: `telegram_not_delivered`, notice delivered |
| E-mail, calendar, Drive/Notion write (connectors) | per call only | the API answer of that call; approval required by default (`packages/adapters/*/src/operations.ts`, `requiresApproval: true`) | a failed call does **not** stop a success (VER-01) |
| Print / any MCP action | per call only | MCP `isError` → tool error; "printed" is the model reading the server (#668; PR #1073 open) | same as above |
| Answer to a question | no | an answer must exist (guard 3c) | empty → 1 nudge, `empty_deliverable` |
| Delegated task | outcome only | typed record + `[delegation stopped]` line | the parent can still end `completed`; the line tells the person |
| Review verdict | shape only | Zod contract, typed travel, `delivery_blocked` field | nothing gates the parent (VER-07) |
| "Nothing to do" | no | — | — |
| "Every action the request named was done" | no | — (#654) | — |

**Cost (question 6).** A tool-less one-line answer pays two short transactions in `finalizeJobSuccess` and no proof, no git, no checkpoint: proportionate. A mutating turn pays one checkpoint per workspace per turn, bounded at 30 s (`packages/checkpoints/src/checkpoints.ts:824`), and refuses the write if the snapshot fails. Each `run_command` / `code_task` in a git tree pays two `git status` plus a serial fingerprint of every dirty file, unbounded below 1,000 entries (#1038: 21.5 s for 1,000 files on CI Windows; `git-constat.ts:295`, `:749`). A declared file is read in full three times, twice inside a transaction (VER-10). The self-recheck that cost 13.6k input tokens and 3.1 s per prose ending was removed from jobs after measurement (#886).

**Recovery (question 7).** Proof red → the agent gets the failing command verbatim and its turns left; it has what it needs, except how to withdraw a path it should not have declared (#644). Unresolved declaration → one nudge with the resolver's reason. Delivery failure → 2 nudges. After that the run fails with a code; the person on a chat reads a line only for `deliverable_not_verified`, `telegram_not_delivered` and `blocked` (VER-02).

## 3. What is solid

- **One terminal success gate for every runtime** (native loop, text and `return_result` branches, CLI runtime, task-board cron: `finalize.ts:789`, called at `execute.ts:5535`, `:7144`, `cli-runtime/run-job.ts:1109`, `cron/deliver-results.ts:283`). Two-transaction protocol with a claim marker, generation guard, epoch guard and "compare to what was proved" (`provedManifestHash`, `finalize.ts:1105-1135`) close the A→B→A race. This is better engineered than anything in Hermes for the same question.
- **A declared promise fails loud and the person hears it where the promise went**: failure line written with the result in one transaction, delivered via the outbox (`finalize.ts:1244-1300`, `noticeTarget`).
- **Repair is bounded in the database**, not in memory (`repair_attempts` in the `WHERE`, space setting 0-3, counted on `chain_count`; `finalize.ts:709-773`), and the brief now forbids redoing outside actions (`repair-brief.ts:157-161`, from the duplicate e-mails of #711).
- **The document proof is honest about its limits**: it says "no well-formedness rule for .x", "not decoded", "form not checked above 32 MB" instead of inventing a verdict (`document.ts:1025-1058`), and admits header-only binaries (`document.ts:540-542`).
- **Typed delegation outcome** carried by the harness, never parsed from prose, including the subtree's failures and the files a stopped child left, with per-file provenance states (`resume.ts:36-110`, `orchestration/src/router/delegated-files.ts`).
- **Freshness rule already exists for a delegate's files**: current content must be what the delegate fingerprinted, or modified during its run window (`packages/tools/src/descendant-files.ts:9-31`). (It is not applied to the job's own declarations: VER-03.)
- **Side effects are not replayed blindly**: restart resume refuses a turn with non-read effects after its checkpoint (`reclaim-jobs.ts:140`); approved calls carry `executed_at` (`execute.ts:3570-3571`); outward connector operations require approval by default; a reviewer re-delegation on an untouched target is refused (`router/duplicate-review.ts`).
- **Evidence-driven removal**: the job-loop self-recheck was removed after a month's data showed 194 repeated actions for 13 real catches (#886, `apps/runner/src/llm/action-recheck.ts:9-14`).
- **Empty success refused** on every channel (`execute.ts:6883-6995`), whitespace included (`execute.ts:5446-5452`) — Hermes applies the same rule to delegated children only (`tools/delegate_tool_child_run.py:645`, `:672`).
- **The outbox** turns harness notices and CLI answers into claimable, bounded, resumable sends, and a `rejected` send alerts the owner (`delivery/outbox.ts:19-45`).
- **`get_task` returns the deliverables with their verification state** (`packages/mcp-server/src/get-task.ts:107`), and a messaging-origin run gets a live "🔎 Review: changes requested" line (`apps/runner/src/notify/code-transitions.ts:36-48`).

## 4. Findings

### VER-01 · P1 · CONFIRMED · NEW (same family as #654, #668)
**A requested action that failed (e-mail, print, calendar, any MCP or connector call) does not stop the run from ending `completed`; the person reads the agent's "done".**
- Where: `apps/runner/src/job/execute.ts:4352-4353`, `:6782-6832`, text branch `:5456-5471`
- Evidence:
  ```ts
  const stuckDeliveriesNow = (): string[] =>
    [...unresolvedToolFailures].filter((t) => DELIVERY_OR_TERMINAL_TOOL_NAMES.has(t));
  …
  trace('unresolved_side_tool_failures_accepted', { turn, stuck });
  ```
- Scenario: "Envoie ce PDF à X par mail". `gmail_send_email` returns a 403 (or the print MCP returns `isError`) at turn 3. At turn 4 the agent writes "Mail envoyé ✅" and calls `return_result{success}`. `gmail_send_email` is not in `DELIVERY_OR_TERMINAL_TOOL_NAMES` (`return_result`, `dashboard_publish`, the six send tools), so the run is accepted, `completed`, and the only trace is a log line. The transcript holds the error; no screen or channel says it.
- Fix (general form): do not block (blocking all side failures produced false reds, the reason given at `:6784-6793`); **state** it. At every terminal success, the harness appends a platform line from its own ledger — `[unresolved: gmail_send_email — <error code>]` for every tool whose last outcome is an error — exactly as `failedDelegationNotice` does for delegations (`execute.ts:3756`), and carries it in the delegation record. One mechanism, every tool, every runtime that has a ledger; no request parsing. Reaches every run that ends with an uncleared tool error (both end branches).
- Effort: S.
- Hermes / best practice: Hermes does not cover it (its child status comes from completion fields, `tools/delegate_tool.py:403-412`; its stop gate is code-only, `agent/verification_stop.py`). Anthropic, *Building effective agents*: the agent's progress must be judged on "ground truth from the environment" (tool results), here already held by the runner.

### VER-02 · P1 · CONFIRMED · NEW (general form already written for the reaper in #1086)
**On Telegram, WhatsApp, Discord or Slack, most failed runs end in silence: the explanation is written to the database and sent nowhere.**
- Where: `apps/runner/src/job/execute.ts:4165`, `:5030`, `:5338`, `:5470`, `:6826`, `:6953`, `:6988`, `:7298`, `:7429-7537`; `apps/runner/src/job/state.ts:636-724`
- Evidence:
  ```ts
  await failJob(db, jobId as string, 'unresolved_tool_failure', runStats(), messages);
  …
  if (landed) await announceTransitions(db, { endedJobIds: [jobId] });
  ```
- Scenario: a Telegram request hits the token budget, an LLM timeout, `quota_exhausted`, `unresolved_tool_failure` or `no_progress_detected`. `failJob` writes `failed` and a `genericFailExplanation` into `result`; `announceTransitions` feeds the web event bus and the voice announcer (`apps/runner/src/server.ts:139`, `events/publish.ts:504-517`), not a chat. Only three exits go through `failJobWithHarnessNotice` (`execute.ts:3909`, `:5498`, `:6761`, `:6873`). The person who asked on Telegram waits and gets nothing, which contradicts the product rule written above `genericFailExplanation` ("a job must NEVER leave the user without an explanation", `state.ts:214-222`).
- Fix: one terminal failure gate that prepares the delivery for **any** head job whose reply destination is a channel (`replyDestination`, `job/channel-delivery.ts:162`), inside the transaction that writes `failed` — the seam `finalizeJobFailure` already has (`finalize.ts:1421-1456`). Remove the per-code choice; every exit calls the gate. Reaches every failure path of the native loop, the CLI runtime (`run-job.ts` `fail()`), and the reaper (#1086).
- Effort: M.
- Hermes / best practice: Hermes settles each cron delivery's outcome back onto the run and surfaces refused sends (`cron/delivery_outcome.py:1-13`); it does not have this gap for cron. Not covered for interactive gateway failures in the files read.

### VER-03 · P2 · CONFIRMED · partly tracked (#644 "open question")
**A declared deliverable is proven green if it exists, even when this run never wrote it: an input file, last week's render, or the file in the wrong folder.**
- Where: `apps/runner/src/job/finalize.ts:1190-1192`; `apps/runner/src/verification/document.ts:940-950`; `packages/tools/src/verification/declared-deliverables.ts:119-123`
- Evidence:
  ```ts
  if (plan.declared && effective !== 'green') {
    promisNonTenus.push({ plan, effective, proof });
  }
  ```
  (`produced`, the run-window mtime, and constated writes are never consulted for a declared row.)
- Scenario: (a) #644's own data: `pr641.diff`, a review **input**, `declared=true produced=false`, green. (b) A render command fails or times out (VER-04), the agent declares `out/film.mp4` left by yesterday's run: exists, non-empty, `ftyp` header → green → `completed` "Film livré". (c) #434: the note written in `shared/` instead of the vault is "verified" by its author.
- Fix: add a constat `written-this-run` to the document proof, satisfied by a constated write of this job, by the delegate rule that already exists (`descendant-files.ts:9-31`: content fingerprinted by a descendant, or mtime inside its run window), or by an mtime inside this job's window. A file not written in the run is said in the platform line ("exists, not written by this run"), not silently green. One rule for own and delegated files. Reaches every `return_result.deliverables` and the task-board root finalize.
- Effort: S-M.
- Hermes: not covered (no deliverable declaration); `tools/delegate_tool.py:786-789` asks the parent in prose for "a verifiable handle … and verify it yourself".

### VER-04 · P2 · CONFIRMED · NEW
**A shell command that timed out or could not start is a successful tool call, so neither the same-turn deferral nor the unresolved-failure guard ever sees it.**
- Where: `packages/tools/src/builtin/run-command.ts:274-288`; `apps/runner/src/job/tool-result-shape.ts:95-100`
- Evidence:
  ```ts
  exitCode: o.kind === 'exit' ? o.exitCode : null,
  …
  timedOut: o.kind === 'timeout',
  ```
  ```ts
  return 'error' in v ? 'error' : 'ok';
  ```
- Scenario: `run_command "npx remotion render …"` is killed at its timeout; the result is `{exitCode: null, timedOut: true}` → shape `ok`. The agent says "rendu terminé"; nothing defers or nudges. Combined with header-only binary proof (`document.ts:540-542`), a truncated MP4 that the killed render left behind proves green if declared. #668's print ran `Exited=False` and was claimed printed.
- Fix: keep a non-zero exit as data (grep returns 1), but classify `timeout` and `spawn_error` — outcomes the shell engine already types (`code-project.ts` maps them to `infra_error`) — as tool failures in the result shape, so VER-01's ledger and the same-turn deferral see them. Reaches `run_command`, `run_skill_script`, and `code_task`.
- Effort: S.
- Hermes: records terminal results with exit status in a passive ledger (`tools/terminal_tool_result.py:196-204`, `agent/verification_evidence.py:1-3`) and only for coding verification; does not cover it at task end.

### VER-05 · P2 · CONFIRMED · #643 (still open)
**A Claude Code / Codex runtime run is `completed` whenever the CLI prints a final text: its internal tool errors are recorded as successes and it cannot declare deliverables.**
- Where: `apps/runner/src/cli-runtime/claude-turn.ts:263-268`; `apps/runner/src/cli-runtime/run-job.ts:476`, `:1109-1125`
- Evidence:
  ```ts
  } else if (block['type'] === 'tool_result') {
    onEvent?.({
      kind: 'tool_result',
      toolUseId: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined,
      output: stringifyCapped(block['content']),
    });
  ```
  ```ts
  if (!turn.isError && turn.finalText !== '') return null;
  ```
- Scenario: a CLI-runtime agent's `Bash` call fails three times, the session prints "Done, tests pass"; `is_error` is dropped, the run is `completed`, its writes are `code_project` rows that are `not_configured` without approved commands, and a red proof would only be observed (`repairTurn: 'unsupported'`).
- Fix: carry `is_error` into the event and the `tool_calls` row (one field), feed the same ledger as VER-01 so the same end-of-run line applies; give the CLI runtime the same declaration path (a final structured line or an MCP `return_result` tool exposed to the session). Reaches Claude and Codex bindings and the chat CLI path (`run-chat.ts`).
- Effort: M.
- Hermes: its CLI-agent bridges are out of what was read; not confirmed.

### VER-06 · P2 · CONFIRMED · NEW (plan item ③ "Garde active" not tracked by an issue)
**When an approved test suite (or a document proof) is still red after the repair turn, the run ends `completed` and nobody is told outside the web Files block.**
- Where: `apps/runner/src/job/finalize.ts:1222-1243`, `:1393-1397`
- Evidence:
  ```ts
  const kind: FinalizeKind = observedOutcome === 'completed' ? 'completed' : 'completed_unverified';
  ```
  (`completed_unverified` has no consumer in `apps/` or `packages/`: `grep -rn completed_unverified` finds only `finalize.ts`.)
- Scenario: an agent edits a project whose owner approved `pnpm test`; the proof is red, the repair turn does not fix it, `red_streak + 1`, `completeJob` writes `completed`; on Telegram the person reads the agent's "c'est corrigé". The plan's guard (③, `docs/plans/verifier-corriger.md:41`) was never switched on; only declared rows (#509) fail.
- Fix: either persist the observed outcome (a `verification_outcome` beside `status`, shown on every surface and in the delegation record) or append the same platform line family as `deliverableNotVerifiedLine` for any red-after-repair row, declared or not. Same line, one gate, no new status branch.
- Effort: S.
- Hermes: its verify-on-stop gate is opt-in, default off, and never blocks (`agent/verification_stop.py:57-83`, `:166-244`); Nodal already does more.

### VER-07 · P2 · CONFIRMED · NEW (#434 partially)
**A reviewer's "changes requested" binds nobody: the author/orchestrator can end `completed` saying "approved", the reviewer may run on the author's model, and nothing checks it read the work.**
- Where: `packages/orchestration/src/router/resume.ts:553`; `packages/catalog/src/skills/code-review.ts` (discipline 1); `packages/tools/src/verification/tool-call-reads.ts:1-22`
- Evidence:
  ```ts
  delivery_blocked: verdictsBlockDelivery(verdicts) ? REVIEW_CHANGES_REQUESTED : null,
  ```
  (`delivery_blocked` is read only by the model; no runner path consults it. "NEVER emit a verdict from the task description alone" is skill text only.)
- Scenario: root → Lead → Reviewer A; Reviewer A records `request_changes` (major). Lead resumes, writes "Revue OK, livré", `return_result{success}` → `completed`; the root relays it; on MCP/Telegram the person reads "OK" (the live "🔎 changes requested" line exists only for messaging channels). A reviewer agent whose `findings[].file` was never opened in its job (`tool_call_reads` has no row for it) is accepted the same way, and the reviewer can be on the author's model with no warning (#434: "verified by its own author").
- Fix: (1) a delegation whose record carries `delivery_blocked` makes the parent's success carry a platform line naming the blocking verdict and its author (same family as `[delegation stopped]`); (2) a "grounded verdict" constat from data already stored: each finding's file and, for `approve`, the reviewed paths appear in the reviewer's `tool_call_reads` with the current fingerprint; (3) the roster/delegation record names the reviewer's and author's models so the parent and the screen can see "same model". Reaches every agent holding `code-review` and every relay path (`state.ts` `compileChildResults`, cron task board).
- Effort: M.
- Hermes: no structured review verdict; delegation prompt says child summaries are self-reports (`tools/delegate_tool.py:786-789`). Best practice: Anthropic, *Harness design for long-running apps* — a separate evaluator with hard pass thresholds and feedback the generator must address; *Effective harnesses for long-running agents* — models declare work complete without end-to-end checks.

### VER-08 · P2 · CONFIRMED · #644 (still open)
**A correct read-only run fails `deliverable_not_verified` because "omit `deliverables`" means both "keep my list" and "I deliver no file", and a directory is accepted as a declared file until the proof refuses it.**
- Where: `packages/tools/src/builtin/return-result.ts:44-46`; `packages/tools/src/verification/declared-deliverables.ts:119`
- Evidence:
  ```ts
  'this run, so a file you no longer deliver is simply left out. Omit the field to keep ' +
  'your earlier list, or when the task delivers no file.',
  ```
- Scenario: exactly #644 (job `310cecd6`): declared a directory, red `is not a file`, repair turn, model omits the field as told, promise stands, run fails. The repair brief was reworded since (#711) but still does not say how to withdraw a path.
- Fix: as #644 proposes — one form, one meaning (`[]` = no file), and refuse at declaration (`unresolved`, existing nudge) a path that exists and is not a regular file.
- Effort: S.
- Hermes: not covered.

### VER-09 · P2 (cost) · CONFIRMED · #645 (still open)
**22% of review verdicts are refused for a 1,000-character cap on `findings[].issue`, and each refusal re-sends the whole verdict and replays the review context.**
- Where: `packages/tools/src/builtin/review-verdict.ts:31-34`
- Evidence:
  ```ts
  issue: z
    .string()
    .min(1)
    .max(1000)
  ```
- Scenario: #645's 7-day count — 28 of 128 calls refused, 25 of 85 verdict jobs paid at least one extra turn, 118,636 characters re-emitted. The cap has no consumer.
- Fix: #645's general form — a prose bound exists only against runaway output and is sized from a real consumer; an architecture test lists every small `.max(n)` on a model-written string.
- Effort: S.
- Hermes: not covered.

### VER-10 · P3 · PLAUSIBLE · NEW
**The document proof hashes each declared file in full inside the finalization transactions that hold the job's row lock — the very thing the module's header forbids for spawns.**
- Where: `apps/runner/src/verification/document.ts:883`; called at `apps/runner/src/job/finalize.ts:917` (transaction 1) and `:1114` (transaction 2); `packages/db/src/client.ts:55-56`
- Evidence:
  ```ts
  manifestHash: `${DOCUMENT_MANIFEST_HASH}:${await fileStamp(path)}`,
  ```
- Scenario: a run declares several multi-gigabyte renders on a slow or network disk. Each file is read three times (tx 1, proof, tx 2); while Node hashes, the session is idle in transaction (60 s limit) and the heartbeat's `UPDATE` on the same row waits behind `FOR UPDATE` (30 s `lock_timeout`). Missing link: no measurement of the read time on a real large file; the failure needs a total above 60 s per transaction.
- Fix: stamp outside the transaction (stat + hash before tx 1, re-stamp after tx 2's commit-time check through `provedManifestHash`, which already exists), so transactions carry only the stored hash. Reaches the `document` and `removed` verifiers.
- Effort: S.
- Hermes: not covered.

### VER-11 · P2 · CONFIRMED · #1038 (still open)
**In a git project, every shell command pays an unbounded serial fingerprint of every dirty file, twice.**
- Where: `packages/tools/src/verification/git-constat.ts:295`, `:749`
- Evidence: `      fingerprint: await fingerprint(absolu),`
- Scenario: a workspace with ~500 changed or untracked files on Windows; each `run_command` adds roughly 2 × 10 s before and after (21.5 s per 1,000 files measured in #1038), invisible to the person, outside any budget.
- Fix: as #1038 — a total time budget that declines like `GIT_CONSTAT_TREE_TOO_DIRTY`, with bounded concurrency measured on Windows.
- Effort: S.
- Hermes: checkpoints only (`tools/checkpoint_manager.py`), no per-call git delta; not comparable.

### VER-12 · P3 · CONFIRMED · NEW
**The only request-reading verification guard (Guard 1g, "verify before asserting a cancel") recognizes French and English verbs only.**
- Where: `packages/orchestration/src/chain-counters.ts:289-290`
- Evidence:
  ```ts
  export const CANCEL_UNDO_INTENT_RE =
    /\b(annule[rz]?|cancel|undo|supprime[rz]?|enl[eè]ve[rz]?|retire[rz]?|d[ée]sactive[rz]?|arr[êe]te[rz]?)\b/i;
  ```
- Scenario: a Spanish or German user writes "cancela la rutina" / "lösche den Zeitplan"; no nudge; the 2026-07-11 incident shape (asserting nothing exists without reading) stays open for them.
- Fix: drop the verb list (invariant #11); the structural form is already there — "a run that answers about platform state with only delivery/terminal tools on its first turn" — or rely on the exchange record (`job/tool-acts.ts`) that now replays the agent's past acts.
- Effort: S.
- Hermes: not covered.

### VER-13 · P3 · CONFIRMED · NEW
**The duplicate-review guard recognizes a review target only in PR numbers or in this repository's own layout (`packages/…`, `apps/…`).**
- Where: `packages/orchestration/src/router/duplicate-review.ts:84`
- Evidence: `  for (const m of task.matchAll(/\b((?:packages|apps)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/gi)) {`
- Scenario: another user's repo uses `src/`, `lib/`, `services/`: the guard never fires and a parent can re-ask the same reviewer about an untouched target.
- Fix: key the target on what the platform knows — the reviewed paths in the reviewer's `tool_call_reads` and their fingerprints — rather than on text shapes.
- Effort: S.
- Hermes: not covered.

### VER-14 · P3 · CONFIRMED · NEW
**A comment states that failed delegations block a parent's success; the code a few lines below excludes them.**
- Where: `apps/runner/src/job/execute.ts:6795-6799` vs `:4322-4353`, `:4352-4353`
- Evidence: `// \`assign_*\` joins the delivery tools here (#107): a delegation that`
- Scenario: a reader trusts the comment and believes a parent cannot report success over a failed `assign_*`; in fact only the `[delegation stopped]` line covers it.
- Fix: delete the stale paragraph.
- Effort: S.
- Hermes: n/a.

### 4a. Status of the issues named in the brief, grouped by mechanism

| Mechanism at fault | Issue | Stands? | Evidence |
|---|---|---|---|
| **The end of a run has no account of the request** (success/blocked only; no "not done", no claim→evidence link) | #654 | yes | `return-result.ts:14-15` still `z.enum(['success', 'blocked'])`, no account field |
| | #668 | yes | no mechanism; PR #1073 (skill) still OPEN |
| | #1098 | yes | `DEFAULT_ELICITATION_TIMEOUT_MS = 10 * 60_000` (`approvals/elicitation.ts:55`); a tool's "waiting on a person" is "delivered" by contract (`return-result.ts:76-81`) |
| | VER-01, VER-04 | new | above |
| **The model reads its own history as a present fact** | #662 | yes | the roster (`orchestration/src/team-block.ts`) carries no teammate's current outcome |
| | #1112 | yes (P3 backlog on how a task end is told in chat) | not re-measured |
| **The deliverable contract** (what a declaration means, what its proof covers) | #644 | yes | `return-result.ts:44-46`, `declared-deliverables.ts:119` (no `isFile`) |
| | #434 | yes (the "author verifies its own work" part) | no rule; VER-03, VER-07 |
| | VER-03, VER-10 | new | above |
| **The review flow** | #645 | yes | `review-verdict.ts:34` `.max(1000)` |
| | VER-07, VER-13 | new | above |
| **Terminal-state writers** | #1081 | yes | `packages/db/src/repos/transitions.ts:209` sets no `completedAt` |
| | VER-02 (and #1086) | new / yes | above |
| **The CLI runtime cannot see or declare** | #643 | yes | `claude-turn.ts:263-268` |

## 5. The three changes that would most improve output quality or cost here

1. **Every end of a job is told to the person where they asked (VER-02).** One failure gate prepares the outbox delivery for any head job whose reply goes to a channel, inside the terminal transaction, for every code. For the user: a Telegram request that hits a budget, a timeout or a guard is answered with what stopped it instead of silence. Cost: M; it removes the per-exit choice between `failJob` and `failJobWithHarnessNotice` (fewer paths), reaches the native loop, the CLI runtime and the reaper (#1086).
2. **The harness states what its own ledger contradicts, at every success (VER-01, VER-04, VER-06, VER-07), then #654's account.** Step 1, deterministic and without a model call: a platform line for every tool left in error (timeouts and spawn errors included), every red-after-repair proof, every blocking review verdict — the `[delegation stopped]` pattern generalized, carried up in the delegation record. Step 2: #654's `not_done` field plus "claims cite evidence": each outward action the agent reports as done names a tool-call id of this run, which the runner checks exists, ran, and did not error. The comparison request↔work stays the model's (no verb lists), the link claim↔evidence becomes the runner's. For the user: "completed" stops hiding a failed send, print or review. Cost: S for step 1 (no tokens), M for step 2 (one field in an eager schema; one bounded nudge per run that ends on text alone). Hermes has the closest analogue for delegated work: an optional per-task `output_schema`, validated by code, one bounded retry with the errors verbatim, and `schema_valid: false` exposed rather than failing the run (`tools/delegation_output_schema.py:1-8`, `tools/delegate_tool_child_run.py:665-672`). #886 showed a model re-reading its own reply and acting does harm; this design never lets the check act.
3. **Prove what was produced and what was read, from data already recorded (VER-03, VER-07, VER-13).** A declared file must be written by this run (constated write, the delegate rule of `descendant-files.ts`, or mtime in the job window), and a verdict must rest on reads of the files it judges (`tool_call_reads` fingerprints equal to current content). For the user: "verified" means "made here and looked at", not "a file with that name exists". Cost: S-M, no LLM call, one or two queries per finalize.

## 6. Leads not confirmed, and what needs a live run

**Leads not confirmed**
- A file the agent wrote with `file_write` and then deleted on purpose with a shell `rm` (a temp script) proves red `exists:removed-by-this-run` and opens a repair turn on a deliberate deletion. Decided as the reduced rule of #916 (`packages/tools/src/verification/removed.ts:22-24`); frequency unknown.
- A repair turn or a later turn can redo an outward action already performed; only the brief's sentence (`repair-brief.ts:159-161`) and default approvals on connector writes stand between them. MCP tools' default approval was not checked.
- A reviewer that cannot read the author's workspace reviews the brief it was given; not verified on a real tree.
- `office_file` deliverables (xlsx/docx/pptx made by office tools) are never verified unless declared, and then by the `PK` header only (`office-file.ts:61`, `document.ts:706-725`). Not a defect of the code (v7-B never shipped), a gap of scope.

**What could not be checked without a live run (or the owner's database, out of bounds)**
- How often a run ends `completed` with a non-empty `unresolvedToolFailures` (the `unresolved_side_tool_failures_accepted` trace) and on which tools.
- How many failed runs on messaging channels ended with no message to the person (count `failed` head jobs by channel and error code against `job_deliveries`).
- How often declared deliverables have `produced = false` and no constated write (VER-03's real frequency).
- Real duration of the document stamp on large declared files (VER-10).
- Whether reviewer agents in service run on the same model as the agents they review.

Sources (best practice): Anthropic, [Building effective agents](https://www.anthropic.com/research/building-effective-agents); Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents); Anthropic, [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps).
