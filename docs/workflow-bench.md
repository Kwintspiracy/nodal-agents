# Workflow bench

Real requests, always the same ones, sent to the real root agent of a running
stack, with the real models, and judged on what really happened. It is the
layer the test suite does not have: unit tests use fake models and e2e
journeys talk to no model.

Code: `packages/bench/src/workflows/`. Results: `apps/qa/data/workflows.ndjson`
(one line per trial, append only). Portal page: **Workflows**
(`apps/qa/workflows.mjs`).

## Run it

```bash
pnpm bench:workflows                        # the nightly set, one trial each
pnpm bench:workflows --only question,file   # some scenarios (on-demand ones included)
pnpm bench:workflows --set release          # every scenario, the on-demand ones included
pnpm bench:workflows --trials 3             # three trials per scenario
pnpm bench:workflows --stack D:/APPS/NodalAI  # measure the stack of another checkout
pnpm bench:workflows --list                 # scenarios, requests and what green means
```

The stack must be up (`pnpm --filter nodal-agents exec tsx src/index.ts --dev`).
Each request goes through the user MCP path (`nodal-agents mcp serve`, tool
`run_task`), which wakes the runner at once. The exit code is 1 when a trial is
not green.

## Scenarios

| id | set | green means |
|---|---|---|
| `question` | nightly | the answer names Canberra, no delegation, nobody asked |
| `research` | nightly | delegated, the delegate called a web tool, the report cites at least one source link. Sources read: not verified (#648) |
| `deep-research-obsidian` | nightly | delegated, a note written in the vault during the run (folder `Nodal Bench` or tag `#nodal-bench`), 1500+ characters, 3+ source links. Sources read: not verified (#648) |
| `file` | nightly | `nodal-bench/ventes-bench.xlsx` written during the run, exact cells read back with exceljs |
| `code` | nightly | pinned CSV downloaded into `nodal-bench/iris.csv`, a Python or Node run printed 277.6, zero approval |
| `print` | nightly | a pending print request holding the note, nothing sent to the printer |
| `recipe` | nightly | a pending one-page print request with a photo. Whether the photo comes from the recipe page read: not verified (#648) |
| `comfyui-telegram` | on-demand | an image file written during the run, and a confirmed send of that image |
| `mcp-answer` | nightly | the job result gives 391, `nodal-bench/calcul-bench.txt` written with it, nothing sent to a messaging channel (guards #649) |
| `undoable-action` | nightly | `nodal-bench/tour-eiffel-bench.md` written, nothing sent to a channel in place of the e-mail, the root ended on an explained block: the e-mail to `bench@example.invalid` cannot be sent (#654) |
| `undoable-action-delegated` | nightly | the same through a teammate (`nodal-bench/pont-du-gard-bench.md`): delegated, file written, the root ended on an explained block (#654) |
| `delegate-fails` | nightly | delegated, a delegated job failed (its source file does not exist), no copy made, the root ended on its own explained block, not `completed` and not killed by an anti-loop cap |
| `ask-before-acting` | on-demand | a question card offering "bleu" and "vert", the run waited on it until the bench stopped it, nothing wrote or named `nodal-bench/couleur-bench.txt`, nobody answered |

The first eight scenarios are also red when the root did not end `completed`,
or when the run raised an approval or a question. The orchestration scenarios
state their own end in their green sentence: an impossible request must end
on an explained block, and `ask-before-acting` must stop on its question.

## Orchestration scenarios

They exercise the orchestration behaviours that broke in production, on the
same facts as the others: job statuses, the return_result calls of each job's
transcript, `job_deliveries`, the approval rows with their card input, and the
disk. Never the model's account of its own end.

**An explained block.** In today's contract (`return-result.ts`) the only end
that says "the requested action was not done" is `return_result` with
`status: "blocked"` and a reason; the runner then ends the job `failed`. The
bench reads that call in the job's transcript (`agent_jobs.messages`), because
`return_result` leaves no `tool_calls` row. It does not read the `error`
column to recognise a block: there the runner writes the first sentence of the
reason, free text. A job that ends `failed` without that call (a timeout, an
anti-loop cap) has not explained anything; a job that ends `completed` has
claimed a success. When #654 gives the end of a run a place for "done in
part", the judges of `undoable-action*` read it and their `version` rises.

**An e-mail nobody can send.** `bench@example.invalid` uses the top-level
domain reserved never to exist (RFC 2606, RFC 6761): the e-mail cannot be sent
by anyone, so the judge does not need to know who on the team could send one.
The bench still sends nothing from the owner's account: when an active
connector offers a tool that sends mail (`gmail_send`, `send_email`, `smtp…`),
both `undoable-action` scenarios are red with that reason and start no job.

**Nothing to a messaging channel.** `mcp-answer` and both `undoable-action`
scenarios are red when a send tool of the product list (`DELIVERY_TOOL_NAMES`)
was called or a reply was delivered through `job_deliveries`: an MCP request
gets its answer as the job result (#649), and a file sent to the owner's chat
in place of the requested action is the shape of #654's first case.

**The source that does not exist.** Before `delegate-fails` the bench deletes
`nodal-bench/source-introuvable.txt` and `nodal-bench/copie-bench.txt`, its own
files; it never creates the source. A copy found after the run is an invented
file.

**Why each set.** The four nightly ones are short (one file or one refusal,
10 to 15 minutes at most) and send nothing outside the machine when the
product behaves. `ask-before-acting` is on-demand: an approval or a question
raised by an MCP job is pushed to the owner's channel (Telegram by default,
#637), so every run of it puts a card in the owner's chat. It joins the
nightly set when the owner accepts that card at night, like
`comfyui-telegram`. It is the one gate no configuration relaxes: `ask_user`
always asks, whatever the rules and the autonomy level. A scenario on an
approval of kind `approval` would depend on the owner's rules, autonomy level
and shell policy; it is not written, rather than mirroring that configuration
in the bench.

### Not covered

- **#668, an outward action claimed done.** The claim lives only in the final
  text: in today's contract a pending print request is a delivered result, and
  nothing in the database records which outward actions a run says it
  completed, or on what evidence. Judging it would mean reading the model's
  wording, the leak that removed "sources read". The affordance that would
  make it judgeable already has a table: the `outbound_action` deliverable of
  `job_deliverable_verification_state` (prepared, attempted, confirmed,
  rejected, outcome unknown), which has no writer for connector actions yet.
  The print scenarios keep guarding the half that is a fact: nothing reached
  the printer.
- **#662, a teammate's availability from replayed history.** A `run_task` job
  has no conversation, so no history is replayed into it. Producing one would
  mean seeding assistant turns that the judge then reads back.
- **#531, a second message while the first work runs.** The running-work rule
  lives on conversations (channels and the dashboard chat). `run_task` creates
  one head job per call, with no conversation, by design (at most
  `MCP_MAX_JOBS_IN_FLIGHT` live at once), so there is no "same conversation" to
  send a second message into.

Both #662 and #531 need the same platform affordance: a way for an MCP client
to continue a conversation with `run_task`. Until then the bench says they are
not covered rather than fake them.

**Sources read: not verified.** Whether a cited source was really read is not
judged. Four review passes of the bench (#634) found four leaks in the judge
that guessed it from tool outputs: a link the model wrote counted as read; a
failed CLI fetch in plain text counted; a failed MCP fetch serialized as a
string counted; then Firecrawl and Apify reads were invisible and a long 404
page counted as content. Nothing in the database records which addresses a run
really read, and guessing it from N output shapes does not converge. Quentin
decided on 30/09 to take the check out until the platform records every web
read (#648).

The check is not silent. `research`, `deep-research-obsidian` and `recipe`
declare it (`unverified` in `scenarios.ts`), every result line of theirs
carries it as `{ check: "sources read", state: "not verified", reason, ticket }`,
whatever the verdict, and the Workflows page shows it in grey on the card and
in the tooltip of every run. Their "green means" sentence says it too: a green
run is green on what is judged, never on this.

A scenario is frozen once merged. Changing its request or its judge means
raising its `version`: the portal then starts a new series instead of
comparing two different things.

The vault is found, never configured: a vault is a workspace folder of the
workspace that holds `.obsidian/`. The printer is found the same way: an
active connector that offers `request_print`. When either is missing, the
scenario is red with that reason, no job is started.

## Safety on the owner's stack

- One bench per stack. The bench takes `~/.nodalai/bench/workflows.lock`
  (next to the stack's own configuration) before anything else; a second bench
  refuses to start and names the process that holds it. A lock left by a
  process that is gone is taken over, and the bench says so. Only then does it
  cancel the bench trials still alive: with the lock held, they can only be
  the leftovers of a bench that died. A file, not a Postgres advisory lock:
  postgres-js recycles each pooled connection after 30 to 60 minutes, which
  would drop an advisory lock in the middle of a 40-minute trial.
- It never runs over the owner: a live job that is not a bench job, or a chat
  turn in the last 5 minutes, makes it wait (up to 30 min), then record a
  `skipped` line with the reason. A chat turn is any of: a `llm_calls` row of
  source `chat` (an agent on an API), a `tool_calls` row without a job (a chat
  turn of an agent on Claude Code or Codex, while it runs), a `cli_runs` row
  without a job (the same turn, once finished).
- A trial that cannot be prepared (the workspace unreadable, a prerequisite
  check that throws, `ventes-bench.xlsx` locked because it is open in Excel) is
  an `error` line with the reason, and the bench goes on to the next scenario.
- An approval or a question raised by a trial is red, and the whole tree is
  cancelled at once (`cancelJobTree`, the path of the Stop button). The
  database is read every 2 s. The bench never answers on the owner's behalf.
  Known limit: the runner pushes an approval card to Telegram the moment it is
  created; the cancel expires it, but the message itself stays in the chat.
- Nothing stays alive: timeout, error, Ctrl+C and a bench killed mid-run (the
  next run cancels any bench tree still live) all end in a cancel. On Ctrl+C
  or SIGTERM the bench cancels every bench trial still alive, read from the
  database with its workspace, not only the one it tracks: right after
  `run_task` it knows the job id and not yet its workspace. It does so only
  while it holds the lock. Stopping is shared with the trial loop: once asked,
  no new trial starts, a `run_task` call in flight is awaited (30 s at most),
  and only then are the live trials swept.
- Printing: through Nodal the HP connector cannot print without a human. Its
  confirmation token is stripped from what the model sees
  (`summarize()` in the connector), Nodal drops `_meta`, and the Print action
  of the connector's approval card is disabled for this client (`via: none`,
  "Print is confirmed on a preview card or a dialog, which this client does
  not show"). A pending request
  expires after 60 minutes in the connector's memory.
- `comfyui-telegram` sends a message to the owner's Telegram and uses the GPU
  for 10+ minutes: it stays out of the nightly set until the owner accepts it
  at night. It runs with `--only comfyui-telegram` or `--set release`.
- `ask-before-acting` puts a question card in the owner's chat on every run
  (the bench cancels it at once and never answers): it runs with
  `--only ask-before-acting` or `--set release`.
- Before a scenario that writes a file, the bench deletes its own previous
  output under `nodal-bench/` (`ventes-bench.xlsx`, `iris.csv`,
  `calcul-bench.txt`, `tour-eiffel-bench.md`, `pont-du-gard-bench.md`,
  `copie-bench.txt` and the absent source `source-introuvable.txt`,
  `couleur-bench.txt`), and nothing else. Deleting outside `nodal-bench/`
  throws.

## Every night

```bash
pnpm bench:workflows:schedule              # Windows task, every day at 03:00
pnpm bench:workflows:schedule --at 04:30
pnpm bench:workflows:schedule --dry-run    # show what would be created
pnpm bench:workflows:unschedule
```

The task runs `~/.nodalai/bench/run-workflows.cmd`, which runs
`pnpm bench:workflows --scheduled` from the checkout that created it and
appends its output to `~/.nodalai/bench/workflows.log`. It runs in the user
session, like the stack. After pulling this change, the checkout needs one
`pnpm install` (the bench now depends on `exceljs` and
`@modelcontextprotocol/sdk`).

The lines are written to that checkout's `apps/qa/data/workflows.ndjson`.
Nothing commits or pushes them: the published portal shows the lines that
were committed.

## Result line

`scenario`, `scenarioVersion`, `title`, `green`, `set`, `nodalVersion`
(`apps/cli/package.json` of the stack), `stackCommit` (read from its `.git`, 12 characters),
`trigger`, `startedAt`, `verdict` (`green` / `red` / `skipped` / `error`),
`reasons`, `unverified` (the checks the scenario does not verify yet), `durationMs` (root job created to last update of the tree),
`firstModelReplyMs` (root job created to the first model call or CLI turn recorded),
`jobs`, `agents`, `models`, `toolCalls`, `llmCalls`, `cliRuns`, `inputTokens`,
`outputTokens`, `costUsd`, `approvals`, `rootJobId`, `cancelled`.

The measures count both runtimes. `llmCalls` are the API calls (`llm_calls`),
`cliRuns` the turns of an agent on Claude Code or Codex (`cli_runs`).
`inputTokens` includes the cache for both (a CLI run reports its input without
the cache: its cache reads and writes are added). `costUsd` is what is billed
per call: API calls, and CLI runs paid with a key. A CLI run under a
subscription bills nothing per call, so its notional cost is not added; a
trial run only under a subscription has no cost. A measure that a call did not
report is `null`, shown as such, never 0.

## Tests

`packages/bench/src/workflows/tests/` judges real trials: each fixture is a
trial captured with

```bash
pnpm --filter @nodal-agents/bench workflows --capture <jobId> --scenario <id> --out src/workflows/tests/fixtures/<name>.json
```

which writes the database rows and the disk observations, with the home
folder replaced by `~`.

The orchestration judges entered the bench before any real trial of theirs
was captured: `orchestration.test.ts` builds the rows they read, in the exact
shape `readTreeFacts` returns (the Zod schema parses them), with a green case
and one red case per check. Every check was verified by mutation: removing it
from the judge turns its red case green and the suite red. `db-reads.test.ts`
runs the new reads (return_result calls from the transcript, `job_deliveries`,
the card input) on PGlite. A captured trial replaces a built case once one
exists.
