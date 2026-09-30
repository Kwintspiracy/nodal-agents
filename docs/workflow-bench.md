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
| `research` | nightly | delegated, the delegate read web sources, at least one cited link was seen by a tool |
| `deep-research-obsidian` | nightly | delegated, a note written in the vault during the run (folder `Nodal Bench` or tag `#nodal-bench`), 1500+ characters, 3+ source links |
| `file` | nightly | `nodal-bench/ventes-bench.xlsx` written during the run, exact cells read back with exceljs |
| `code` | nightly | pinned CSV downloaded into `nodal-bench/iris.csv`, a Python or Node run printed 277.6, zero approval |
| `print` | nightly | a pending print request holding the note, nothing sent to the printer |
| `recipe` | nightly | a pending one-page print request whose photo comes from the recipe site read |
| `comfyui-telegram` | on-demand | an image file written during the run, and a confirmed send of that image |

Every scenario is also red when the root did not end `completed`, or when the
run raised an approval or a question.

A scenario is frozen once merged. Changing its request or its judge means
raising its `version`: the portal then starts a new series instead of
comparing two different things.

The vault is found, never configured: a vault is a workspace folder of the
workspace that holds `.obsidian/`. The printer is found the same way: an
active connector that offers `request_print`. When either is missing, the
scenario is red with that reason, no job is started.

## Safety on the owner's stack

- It never runs over the owner: a live job that is not a bench job, or a chat
  turn in the last 5 minutes, makes it wait (up to 30 min), then record a
  `skipped` line with the reason.
- An approval or a question raised by a trial is red, and the whole tree is
  cancelled at once (`cancelJobTree`, the path of the Stop button). The
  database is read every 2 s. The bench never answers on the owner's behalf.
  Known limit: the runner pushes an approval card to Telegram the moment it is
  created; the cancel expires it, but the message itself stays in the chat.
- Nothing stays alive: timeout, error, Ctrl+C and a bench killed mid-run (the
  next run cancels any bench tree still live) all end in a cancel.
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
`firstModelReplyMs` (root job created to the first model call recorded),
`jobs`, `agents`, `models`, `toolCalls`, `llmCalls`, `inputTokens`,
`outputTokens`, `costUsd`, `approvals`, `rootJobId`, `cancelled`.

## Tests

`packages/bench/src/workflows/tests/` judges real trials: each fixture is a
trial captured with

```bash
pnpm --filter @nodal-agents/bench workflows --capture <jobId> --scenario <id> --out src/workflows/tests/fixtures/<name>.json
```

which writes the database rows and the disk observations, with the home
folder replaced by `~`.
