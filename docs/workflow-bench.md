# Workflow bench

Real requests, always the same ones, sent to the root agent of the bench
space (a copy of the owner's team that can send nothing, `pnpm bench:space`)
on a running stack, with the real models, and judged on what really happened. It is the
layer the test suite does not have: unit tests use fake models and e2e
journeys talk to no model.

Code: `packages/bench/src/workflows/`. Results: `apps/qa/data/workflows.ndjson`
(one line per trial, append only). Portal page: **Workflows**
(`apps/qa/workflows.mjs`).

## Run it

```bash
pnpm bench:workflows                        # the nightly set, one trial each
pnpm bench:workflows --only question,file   # some scenarios (on-demand ones included)
pnpm bench:workflows --activity excel,word  # every scenario of these activities (on-demand ones included)
pnpm bench:workflows --set release          # every scenario, the on-demand ones included (not the owner-sending ones)
pnpm bench:workflows --only comfyui-telegram --allow-owner-sends
                                            # a scenario that sends TO THE OWNER: named, and this flag
pnpm bench:workflows --trials 3             # three trials per scenario
pnpm bench:workflows --models openrouter:z-ai/glm-5.3,deepseek-chat --dry-run
                                            # the model matrix: the plan and its cost, nothing run
pnpm bench:workflows --stack D:/APPS/NodalAI  # measure the stack of another checkout
pnpm bench:workflows --list                 # scenarios, activities, needs, requests, what green means
pnpm bench:workflows --catalog              # rewrite apps/qa/data/workflow-catalog.json
```

The stack must be up (`pnpm --filter nodal-agents exec tsx src/index.ts --dev`),
and the bench space must exist (`pnpm bench:space sync --apply`). Each request
goes through the user MCP path (`nodal-agents mcp serve`, tool `run_task`),
which wakes the runner at once. The exit code is 1 when a trial is red or a
bench error; a skipped trial does not fail the run.

## Where trials run: the bench space, never the owner's

Trials never run on the owner's agents (decision of 16/10). The session
resolves its target ONCE, before anything else (`resolveBenchTarget`,
`packages/bench/src/space/space.ts`): the bench space and its root agent. That
single resolution drives everything that depends on where a trial runs:

- **run_task.** Every `mcp serve` is pinned to the bench root
  (`NODAL_MCP_AGENT_ID`), and every `run_task` names it (`agent: <slug>`). The
  server neither chooses nor re-resolves the target. A `NODAL_MCP_AGENT_ID`
  inherited from the shell is dropped, whatever its case.
- **What the judge reads.** The scenario environment, the root's model, the
  workspace folders and the deliverables all come from the bench space.
- **The CLI and its scheduled task.** They both go through the same session
  code (`runBench`).

Before each trial, the space's structural check must pass
(`assertSpaceCannotSend`: no channel, connector or MCP server within reach).
Otherwise the trial does not start, and its line says why. After each
`run_task`, the job the server created is read back. If it is anywhere but the
bench root, it is cancelled, and the trial is an `error` whose reason says
where it landed.

With no bench space, or a bench space without an active root, the session
refuses before it touches anything, with
`bench_space_missing`, which names the fix: `pnpm bench:space sync --apply`.
It never falls back to the owner's space.

## Activities and needs

Every scenario declares an **activity**, from a closed list
(`ACTIVITIES`, `packages/bench/src/workflows/types.ts`): question, research,
deep-research, code, excel, word, powerpoint, pdf, image-comfyui, html-page,
email, airtable, notion, google-workspace, delivery, print, orchestration,
memory. The portal draws one matrix row per activity. E-mail, Airtable,
Notion, Google Workspace, delivery and memory have no scenario yet: they need
a test account or a send, which waits on an owner decision, and the portal
says "no scenario yet".

A scenario also declares its **needs** (`needs.ts`): `comfyui`,
`obsidian-vault`, `bench-printer`, `no-mail-sender`. A missing need SKIPS the trial,
with its reason, without starting a job: a `skipped` line, grey on the
portal, never red (nothing was tried). One mechanism for every scenario; it
replaced the per-scenario `requires`, which made such a trial red.

- `comfyui`: an address declared in `~/.nodalai/bench.json`
  (`{"services": {"comfyui": "http://127.0.0.1:8188"}}`) that answers a GET
  within 3 s. Nothing about the owner's machine is written in the code.
- `obsidian-vault`: a workspace folder holding `.obsidian/`.
- `bench-printer`: the bench's own recording printer (#794), a print MCP
  server that records what it received. Every print scenario (`print`,
  `print-file`, `recipe`) needs it: a bench trial never prints on a real
  printer, and an agent having `request_print` (the owner's real connector)
  does not count. It does not exist yet, so the need is always missing and
  the three print scenarios are skipped, with the reason.
- `no-mail-sender`: no agent of the workspace can send e-mail, and no MCP
  server of the team has unknown tools (see below).

The team's tools are read by the **product's own rule**,
`computeAgentToolNames` (`@nodal-agents/orchestration`), for every active
agent: adapter connectors (`connectors` + `agent_connector_assignments`) and
MCP servers, with each agent's whitelist. Until bench v2 the bench read only
`mcp_servers.available_tools`; Gmail, an adapter connector, was invisible to
the mail guard, and seven e-mails left the owner's account (#711). The mail
guard reads the full tool name by words, camelCase split, server prefix
included (a word starting with a sending verb, and a word containing "mail" or
naming a mail service, or `smtp`): it sees `gmail_send_email`,
`outlook_reply_message`, `outlookForwardMessage`, `gmail_users_drafts_create`,
`mailchimp__campaign_send`, `gmail_mcp__send_message`, and not Telegram's
`send_message`. It fails CLOSED on an MCP server whose tools are not known (no
usable cache by the runner's own rule, `isUsableMcpToolCache`, now in
`@nodal-agents/adapter-mcp`): the runner connects to such a server when a job
starts and may offer any tool, so the scenario is skipped with that reason.

**The name guard is defence in depth, not the protection.** No list of names
will ever see an e-mail sent by a generic tool (`run_command` with smtplib or
curl, `run_skill_script`). The protection is that the bench holds **no real
recipient anywhere**: `recipients.test.ts` scans every scenario request and
every file under `packages/bench/fixtures` (Office and PDF text included, read
with the judges' readers) for e-mail addresses, phone numbers and chat ids, and
fails unless each address is under a reserved domain (`.invalid`, `.test`,
`.example`, `example.com/.net/.org`) or a declared test recipient
(`BENCH_TEST_RECIPIENTS`, empty until the owner decides on test accounts);
phone numbers and chat ids must be declared. Later, a bench workspace whose
only accounts are test accounts. The general form of the name guard would be
an `outbound` mark on each connector operation (`OperationDescriptor`) and
reading `openWorldHint` on MCP tools.

## Model matrix

`--models a,b,c` runs every selected scenario once per model (times
`--trials`). A model is `provider:model`, or a bare model the catalog knows
under exactly one provider; an unknown or ambiguous one is an error.

A model is to be applied to the bench space's copies only (the owner's
decision of 16/10; `applySpaceModel` in `space/model.ts`). That is not wired
yet: the seam is `ModelApplier` (`matrix.ts`), and its only implementation
refuses, before the database is even opened. `--dry-run` prints the plan: scenario × model × trials, grouped
by activity, each cell priced from the model catalog and the medians of the
scenario's past runs (input, cached and output tokens, current version only,
skipped and error runs excluded). A cell without a past run or without a
catalog price says so; it is never priced at zero.

## Scenarios (the catalogue of 2026-10-17)

Quentin validated the catalogue on 2026-10-17. Each scenario is named by **what
it tests**, never by the subject of its request: two trials judged the same way
are the same trial, and only one is kept. 37 scenarios (the memory scenario of
the page waits for a bench that chains two conversations; see below).
`pnpm bench:workflows --list` prints each one's French request and its green
sentence; Bench Studio shows its card: what it tests, the expected path, the
deliverable, "Green if", what every trial measures, what is not verified, and
the example request last.

| activity      | scenarios                                                                                                   | expected path                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| question      | `question`, `question-weekday`                                                                              | the root answers alone; a delegation is red. The weekday's tool calculation is measured, not required                                               |
| research      | `research`                                                                                                  | the root alone with a web tool (decision 2); a delegation is red. Calibrated subject (#776)                                                         |
| deep-research | `deep-research-report` (report in `nodal-bench/rapport.md`), `deep-research-obsidian` (a note in the vault) | handed to the specialist: no delegated job calling a web tool is red. Calibrated subject (#776)                                                     |
| code          | `code-bugfix`, `code-http-server`, `code-install-dep`, `code`                                               | the script IS the subject: no product tool. `code` downloads the pinned iris CSV and writes one total per species in `nodal-bench/iris-totaux.json` |
| excel         | `file`, `excel-edit-column`, `excel-read-answer`, `excel-csv-import`                                        | `xlsx_*` product tools (decision 1)                                                                                                                 |
| word          | `word-create` (heading, paragraphs and a table), `word-replace`, `word-append`, `word-read-answer`          | `docx_*` product tools                                                                                                                              |
| powerpoint    | `ppt-create`, `ppt-append`, `ppt-replace`, `ppt-read-answer`                                                | `pptx_*` product tools                                                                                                                              |
| pdf           | `pdf-read-total`, `pdf-from-markdown`                                                                       | no product PDF tool: a command or a skill is the right path, measured                                                                               |
| html-page     | `html-landing`, `html-table-csv` (a table and an SVG chart of the CSV), `html-edit`                         | `file_write` / `file_edit`                                                                                                                          |
| image-comfyui | `comfy-exact-size`, `comfy-variants`, `comfyui-telegram`                                                    | a ComfyUI workflow; need `comfyui`                                                                                                                  |
| print         | `print` (a dictated shopping list), `print-file`, `recipe`                                                  | `request_print`; need `bench-printer` (#794), never a real printer; never confirmed                                                                 |
| orchestration | `mcp-answer`, `undoable-action`, `undoable-action-delegated`, `delegate-fails`, `ask-before-acting`         | the path IS the verdict (below)                                                                                                                     |

Retired on 2026-10-17, with why: `question-percent`, `question-seconds`,
`question-river` (the same trial as `question` on another subject);
`research-penicillin`, `-transistor`, `-rabies`, `-voyager` and
`deep-research-gps`, `-gutenberg`, `-apollo` (facts known from memory: they
tested "give your sources", not research); `excel-new-sheet` (the same
capability as `excel-edit-column`); `word-table`, `pdf-read-pages`,
`pdf-create`, `html-svg-chart`, `print-list`, `code-data` (merged into the
scenario named above); `comfy-square`, `comfy-landscape` (the same capability
as the portrait format). A merge keeps the id of the first scenario listed:
an id is the key of a series. **An id that names a subject the scenario no
longer tests is renamed after what it tests** (`RENAMED_IDS`, catalog.ts):
`deep-research-dna` became `deep-research-report` (its subject is calibrated,
no longer DNA), `comfy-portrait` became `comfy-exact-size` (it proves exact
dimensions; square and landscape merged into it). Every other id still says
what its scenario tests. The lines of an old id stay under it as a **closed
series**: the portal and Bench Studio show it marked "closed series, renamed X"
(or "retired"), never file its runs under the new id, and count it in no
summary of a column or an activity and in no "to look at". The new id starts
its own series at version 1. A kept scenario whose request or judge changed
raised its `version`, so its new series is never compared with the old one.
Old lines of a retired id stay in `workflows.ndjson`; the portal still shows
them under their recorded activity.

Every scenario is also red when the root did not end `completed`, or when the
run raised an approval or a question, except the orchestration scenarios,
which state their own end in their green sentence.

### Path rules

Written once in `judge-kit.ts`, applied by `runTrial` to every scenario that
declares them, never inside one judge:

- **A product tool available must be used (decision 1).** A scenario declares
  `productTools`: the product tools of its path, the deliverables they must
  WRITE (`writes`) and the files they must READ (`reads`). The rule guesses
  nothing (two earlier versions did, from a mention of the file name, then
  from the file's time, and each review found holes). It reads what the
  platform records of every write, `tool_call_writes` (#779): for each call
  and each file it targeted, the hash before and after, and whether the after
  hash is the bytes the tool WROTE (`written`) or a re-read (`read`).
  - a deliverable follows a hash chain in `seq` order: from the state the
    bench prepared (its fixture, otherwise no file) through every recorded
    write, each starting from the state the previous one left, to the file on
    disk at the end. Every write that changes it is one of the product tools,
    proven by the bytes it wrote. A break means something that left no record
    wrote the file (a command, a script, an MCP tool, whatever its name), and
    it is red. A command that only reads the deliverable changes nothing. A
    re-read or a missing row reads as not recorded, never green;
  - a file to read is read by a product tool. The rule does not reconstruct
    the file a call designated: it reads what the platform recorded when the
    file was read, `tool_call_reads` (#783), the real path the tool opened and
    the hash of the bytes it read. The read counts when one of the product
    tools read the real path where the bench posed the file (the shared
    folder), with the bytes of the fixture. An identical copy elsewhere
    (same hash, other path), the posed file changed before the read (same
    path, other hash), or no row (not recorded) is red, never green. An MCP
    tool (`request_print`) opens the file in its own process and leaves no
    read (#784). Reading the arguments of a print server cannot tell which
    field it prints (review of #777, passes 5 to 7), so the bench does not try:
    `print-file` needs the bench's own recording printer (`bench-printer`,
    #794), which will say which file it received. Its judge is closed: it
    is green only when that printer's record shows the content of the posed
    file (its sha-256) and no other file. Until the record exists the judge
    is never green, and the trial is skipped like every print scenario.

  Otherwise the trial is red, "product tool available, not used". When none
  is in the team's tools, the trial is skipped with that reason, like a missing
  need. PDF and code declare none.

- **The specialist, for in-depth research only (decision 2).** `research`:
  the root searches itself, a delegation is red. `deep-research-*`: handed to a
  teammate, and a delegated job must call a web tool.

### Calibrated research subjects (decision 3, #776)

A research subject is accepted only if every compared model, asked without
tools, is wrong or refuses at least 2 times out of 3. The research scenarios
read theirs from `packages/bench/subjects/research-subjects.json`
(`subjects.ts`; their request carries `{subject}`). While no calibrated subject
of their kind exists, they are **skipped**: "no calibrated research subject"
and the ticket. There is never a default subject. A file whose calibration does
not meet the rule is an error, never a subject accepted silently. The
calibration itself comes with the LLM judge.

### Seen on the web (#648, the measurable part)

Each link a research answer or report cites is classified **seen** when it is
in the output of a web tool of the tree that did not receive it as input (a
page fetched from memory that only echoes its own address, a 404, is not
seen), and **not seen** otherwise. The expected facts of the subject must be
held by a web tool output too: the proof they come from the web, not the
model's memory. For a research scenario an unseen link is red; every trial
records its links on its line (`links`).

Fixtures live in `packages/bench/fixtures/` (`make-fixtures.ts` writes the
office ones from `fixture-data.ts`; a scenario is frozen, so is its fixture).
Before a trial the bench installs them under `nodal-bench/` of the shared
workspace folder, after deleting what an earlier trial left there in every
workspace folder. **The bench never executes agent-written code outside a
sandbox.** A rule on the tool name and the command ("the agent ran `npm
test`") is bypassed by an `echo`, a `cd` elsewhere or an MCP tool merely named
`bash`. The code judges read the output of the agent's last command run that
reports EVERY test of the project (passed or failed): a later `✔ done` from a
lint step, a `cat`, another folder's suite or a partial run does not replace
it, and with no complete run the trial is red, "no test run of this project
found". Every line says "tests re-run by the bench: not verified" (a tool
output could be faked). Once the platform sandbox is
available (#753), re-running the suite inside it restores the check.

The portal reads `apps/qa/data/workflow-catalog.json` (`--catalog`; a test
refuses it out of sync with the code) for the activity order and the
scenarios never run.

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
The bench still sends nothing from the owner's account: when an agent of the
workspace has a tool that sends mail (an adapter connector such as Gmail or
Outlook, or an MCP server), both `undoable-action` scenarios are skipped with
that reason and start no job (need `no-mail-sender`).

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

**Sources read: not verified.** Whether a cited source was really READ is not
judged; whether it was SEEN in a web tool output is (above). Four review passes of the bench (#634) found four leaks in the judge
that guessed it from tool outputs: a link the model wrote counted as read; a
failed CLI fetch in plain text counted; a failed MCP fetch serialized as a
string counted; then Firecrawl and Apify reads were invisible and a long 404
page counted as content. Nothing in the database records which addresses a run
really read, and guessing it from N output shapes does not converge. Quentin
decided on 30/09 to take the check out until the platform records every web
read (#648).

The check is not silent. `research`, `deep-research-report`, `deep-research-obsidian` and `recipe`
declare it (`unverified` in `scenarios.ts`), every result line of theirs
carries it as `{ check: "sources read", state: "not verified", reason, ticket }`,
whatever the verdict, and the Workflows page shows it in grey on the card and
in the tooltip of every run. Their "green means" sentence says it too: a green
run is green on what is judged, never on this.

A scenario is frozen once merged. Changing its request or its judge means
raising its `version`: the portal then starts a new series instead of
comparing two different things.

**Memory, from one conversation to the next: not covered yet.** The catalogue
of 2026-10-17 has a memory scenario in two steps (state a preference, then, in
a new conversation, ask something that depends on it). A trial today is ONE
`run_task`: the bench cannot chain two conversations. Its general form (a
scenario declares `steps`, each a fresh `run_task`, the judge reading one tree
per step) changes the signature of every judge, and the bench must not count
a preference left by an earlier trial; it comes in its own change.

The vault is found, never configured: a vault is a workspace folder of the
workspace that holds `.obsidian/`. When it is missing, the scenario is
skipped with that reason, no job is started (need `obsidian-vault`). The
print scenarios never use the owner's printer: they need the bench's own
recording printer (`bench-printer`, #794), and are skipped until it exists.

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
- Nothing a scenario asks may reach a real recipient. The only address any
  request names is `bench@example.invalid`, and the scenarios that ask for an
  e-mail need `no-mail-sender` (see Activities and needs); a send to a
  messaging channel during a trial is red.
- A trial that cannot be prepared (the workspace unreadable, a need check
  that throws, `ventes-bench.xlsx` locked because it is open in Excel) is
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
- Every scenario declares where it sends (`sends`): `nothing`, `owner`, or
  `test-account:<name>` (none is wired: such a scenario is skipped).
  `recipients.test.ts` fails on a request that asks to send to the owner
  ("envoie-la-moi", "send it to me", "sur Telegram" with no named recipient)
  unless it declares `owner`. An `owner` scenario is in no set, no activity, no
  matrix and not in the nightly run: it runs only when named with `--only` AND
  given `--allow-owner-sends`, otherwise it is skipped with that reason. It
  allows exactly ONE outbound thing: the product's delivery to the owner's
  chat, recognised by the tool's identity, its exact registered name as the
  runner records it (`send_image`, `telegram_send_message`…, unprefixed). An
  MCP or CLI tool with the same bare name (`x__send_image`,
  `cli:send_image`) is not the product's, and a mail send is not the owner's
  chat (its recipient cannot be verified): both are outbound, so red. The
  check of the product's delivery is structural, never a pattern searched in
  its text: with no target the product delivers to the conversation's owner,
  and a delivery that names a target (a destination field of its schema,
  `chatId` or `channel`, whatever its value) is red, because the tools
  deliver to any approved conversation, a member's included. A field the
  bench does not know is red too: it may name a target. Every other outbound
  tool (a print, a post, a publish) is red too, by the rule below. Today only `comfyui-telegram` (an
  image to the owner's Telegram, 10+ minutes of GPU) declares `owner`.
- The judge fails CLOSED, whatever the scenario's own judge says: any tool
  that may have sent something makes the trial red, naming the tool, under
  `nothing` and under `owner` alike (`destinationReasons`, review of #777
  pass 9). Under `nothing`, a reply delivered to a channel or a send tool of
  the product is red too; under `owner`, the one exemption is the product's
  delivery to the owner's chat. A tool
  is decided by its ACTION verb, at its position (the first word of its name,
  or the second after a service prefix: `gmail_send_email`,
  `chat_postMessage`, `drive_upload_file`):
  - a product tool (exact name in the product's tool registry,
    `registerBuiltins`, read from the registry itself) never sends; a
    connector op (`file_upload`, one underscore), an MCP tool (`x__y`) or a CLI
    tool (`cli:…`) is never internal;
  - a read verb in action position is a read (`list_posts`, `get_posted_at`,
    `slack__list_channels`, `gmail_get_message`), UNLESS an outbound BASE
    verb, optionally prefixed with `re`, follows it in the name
    (`get_and_send`, `checkBeforeSend`, `list_then_resend`,
    `check_before_retweet` are sends); after a read verb the -ing, -ed and -s
    forms are things, never actions (`list_posts`, `list_sending_domains`,
    `get_posting_rules`), and a messaging service is exempt only on a pure
    read;
  - an outbound verb in action form (send, post, publish, share, forward,
    reply, notify, tweet, upload, print… as base, -s, -es or -ing) in action
    position is a send (`mcp-telegram__send_message`, `discord__sendMessage`,
    `slack__file_upload`). Printing is one: paper leaves the machine like a
    message does, so `request_print` or `confirm_print` makes the trial red
    in any scenario (under `owner` too, see below), and a printer read
    (`list_printers`) does not. After a read
    verb the base `print` still counts, so `get_print_request` is red too:
    closed, like `get_post`;
  - otherwise, closed: an outbound verb in action form anywhere in the name
    (`blog__create_posts`, `notify__push`), a name starting with "message", or
    a messaging or mail service (`telegram__chat`, `smtp_relay`) is a send. A
    participle describes a thing and does not act (`published_at`,
    `sent_items`, `shared_with_me` stay green).
    A false red is preferred to a false green (a local upload to ComfyUI would be
    one). **This guard is an ALARM, not a gate.** It reads names and reports a
    send AFTER THE FACT; it prevents nothing, and it stops growing here (review
    passes 3 to 7). The gate is the bench space (#758): real trials run only
    there, behind a STRUCTURAL pre-trial check that no tool of the bench team can
    send anything, on a throwaway instance with no real connector, printer
    included. Until then a trial on the owner's agents CAN still send him a
    message or print at his place, and the bench only says so. In the bench
    space, this alarm ringing means the gate has a hole. The bench's own
    printer (#794) will expose a print tool too: its exemption will come from
    its server's identity, never from its tool's name.
- The real `research` trial of 30/09 called `telegram_send_message` from the
  delegate: a message reached the owner during a bench trial. Its judge said
  green; the declared destination (`nothing`) now makes such a run red.
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

Since bench v2, also: `activity`, `needs`, `modelUnderTest` (the model the
matrix imposed, `null` otherwise), `rootModel` (the root agent's configured
model when the trial started), `cachedTokens` and `cacheWriteTokens` (cache
reads and writes, included in `inputTokens`), `modelUse` (per job and per
combination: `requested` and `effective` model, `provider`, `via` api or
cli, `reasoningEffort`, `failover`, `calls`, tokens and cost), `deliverables`
(the files written under `nodal-bench/` during the trial, path and size) and
`answer` (the root's final answer, 1200 characters at most, home folder
masked). Since the catalogue of 2026-10-17, also: `path` (per job, its agent,
the job that delegated it and the tools it called, by name and in order),
`delegatedTo` (the agents of the delegated jobs), `links` (the links of the
answer, or of the report a scenario names, each `seen` or not) and `subject`
(the calibrated subject played, or `null`). A line without `path` says
"not recorded", never "no tool". The file stays append-only and older lines still render: the portal
says "not recorded on this run" for what they do not carry, and takes their
activity from the catalog. They go in one matrix column, "before the matrix":
`models` says which models ANSWERED, not which one the run was set to.

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

The bench v2 scenarios have no captured trial yet. Their judges are tested
end to end without a model (`tests/harness.ts`): the real `prepare` installs
the fixtures in a temporary workspace folder, the test writes the deliverable
on disk with the library an agent would use (exceljs, docx, pptxgenjs, a
hand-written PDF, HTML), then the real `observe` and `judge` run. Only the
database rows are built. The code judges run the real fixture projects: each
suite is shown failing as delivered and passing with the reference solution
(`fixtures/solutions`). Seventeen guards were verified by mutation (each one
removed turns a test red), and the three portal guards too.

## Portal

The Workflows page opens on one sentence saying what is compared: the
models, the last five trials at most of each scenario, and the date range.

Below it, a matrix: one row per activity (catalog order), one column per
model. A column is the model the run was SET to (the one the matrix imposed,
or the root agent's configured model), never the set of models that answered;
lines from before bench v2 share one column, "before the matrix". The first
row sums up each column over the trials shown: the share of green among the
trials tried (a skipped trial tried nothing and is not counted), the medians
of time and cost of the green ones, and the total cost of the trials tried
(trials without a cost are said, never counted as zero). An activity with no
trial on a model shows a dash; otherwise its cell shows the last verdict of
each scenario run there. An activity opens on its scenarios: per model, the
bars of the last five runs, the green count, and the medians of the green
runs, or "not run". One rule on the whole page: a skipped trial tried nothing,
so it is in no denominator (scenario cell, card, column summary) and is shown
apart ("1 skipped"); every count is over the trials shown. A skipped run is
grey with its reason in the cell, never red, and does not count as a workflow
to look at. A scenario name leads to its
card: series by Nodal version, slow-down flag, and for a v2 line the models of
each job (requested to answered, provider, effort, fallback, cache tokens),
the deliverables and the answer.
