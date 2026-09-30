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
pnpm bench:workflows --set release          # every scenario, comfyui-telegram included
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
| `research` | nightly | delegated, the delegate read web sources, at least one cited link was returned by a successful web search or page read |
| `deep-research-obsidian` | nightly | delegated, a note written in the vault during the run (folder `Nodal Bench` or tag `#nodal-bench`), 1500+ characters, 3+ source links, at least one returned by a web retrieval |
| `file` | nightly | `nodal-bench/ventes-bench.xlsx` written during the run, exact cells read back with exceljs |
| `code` | nightly | pinned CSV downloaded into `nodal-bench/iris.csv`, a Python or Node run printed 277.6, zero approval |
| `print` | nightly | a pending print request holding the note, nothing sent to the printer |
| `recipe` | nightly | a pending one-page print request whose photo comes from a site a page reader really returned |
| `comfyui-telegram` | on-demand | an image file written during the run, and a confirmed send of that image |

Every scenario is also red when the root did not end `completed`, or when the
run raised an approval or a question.

A source is an address that a web retrieval RETURNED: the output of a search
or page-read tool (`web_search`, Tavily, the MCP fetch server) whose success is
established, without the part that lists failures (`failedResults`). Never the
input of a tool, which the model writes, and never the output of another tool:
reading back a note the run just wrote returns the links the model put there,
not a source.

Success is established only on a row written by the runner's tool path, which
always writes JSON and turns every failure into `{ "outcome": "error" }`. A
`cli:*` row (a tool used inside a Claude Code or Codex session) is not: the
runner stores the text of the CLI's `tool_result` and drops its `is_error`, so
"Failed to fetch https://…" reads like a page. Such rows are never a source.
Sources read only through a CLI therefore give a red, said, never a false
green; recording `is_error` on the audit row would lift this.

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
  while it holds the lock.
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
- Before `file` and `code`, the bench deletes its own previous output
  (`nodal-bench/ventes-bench.xlsx`, `nodal-bench/iris.csv`), and nothing else.

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
`reasons`, `durationMs` (root job created to last update of the tree),
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
