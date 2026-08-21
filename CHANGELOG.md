# Changelog

Notable releases of **Nodal-Agents**, newest first. Pre-1.0: minor versions can
carry breaking changes. Every release is published to npm as `nodal-agents` and
tagged on GitHub.

```bash
nodal-agents update   # upgrade in place — your data is preserved
```

---

## v0.8.5 — Aug 21, 2026

Fixes a package that broke itself weeks after it was published. **If you installed
0.8.0 or 0.8.1, upgrade — a fresh install of either is dead on arrival today.**

- **Every install since Aug 3 got a dashboard that crashed before it rendered.** The
  published package ships a *pre-compiled* Next.js bundle, but declared 43 of its 46
  runtime dependencies as floating `^` ranges. The day `next@16.3.0` was published,
  npm started pairing a 16.3 runtime with a 16.2.6 build, and the server died on
  `TypeError: Cannot read properties of undefined (reading 'validationLevel')` before
  any application code ran. Installs of 0.8.1 made *before* Aug 3 were unaffected.
- **A pre-compiled bundle now ships pinned to the exact versions it was built
  against.** `build-pack` rewrites all 46 runtime dependencies to their exact
  installed versions and fails the build if any range survives. A published package
  can no longer re-resolve its own runtime months later.
- **Next.js 16.3.** The workspace, the pack and the docs site all move to 16.3.0, and
  the pack was booted from an isolated install before release — every dashboard page
  served, not just `/api/health`.

**Coding under your subscription**

- **Agents can delegate development work to a coding CLI.** A new `code_task` tool
  hands a scoped task to Claude Code or Codex running under your own subscription,
  streams the work back, and records what was actually changed. Which CLI provider
  an agent uses is set per agent.
- **A Code tab.** Mission control for everything your agents write: files touched,
  the diff of the selected file, the activity trail per turn, and token accounting
  broken down per model.
- **Inference is now traceable.** Every LLM call and tool call is persisted and wired
  to the transcript, so a run can be read back after the fact instead of guessed at.

**Connectors and skills**

- **Cloudflare connector.** Deploy what your agents build straight to Workers, with
  the compatibility date pinned on every deploy.
- **ComfyUI in the MCP catalog**, via the official local `comfy-mcp` server.
- **The review loop closes.** Agents can request a review of their own work, and the
  verify-before-done skill picked up what the community version did better.

**Security — the audit is fully closed**

- **A stranger can no longer take over your bot.** A bot's username is public, and
  whoever messaged it first used to become its owner — so between pasting the token
  and sending your own first message, anyone who had found the bot could take your
  place, task your agent, and receive its approval cards. The first message now only
  *requests* ownership; you approve it from the dashboard. Telegram, Discord, Slack
  and WhatsApp.
- **You see a skill update before it reaches your agents.** Updating a community
  skill used to show a category ("content changes") for text that goes straight into
  the system prompt of every agent holding it. You now get the actual diff, and the
  install refuses if upstream changed after you read it — consent applies to the text
  you saw, not to whatever the repo holds at click time.
- **Narrower Google access, and honest about the rest.** Google Calendar no longer
  asks for permission to delete your calendars. Drive, Sheets and Docs still need
  full access for their tools to work at all — so the product now says exactly how
  far that reaches, in plain language, before Google's consent screen.
- **Command injection through `cmd.exe` closed** — prompts are passed over stdin,
  never through a shell argument. Two independent reviews were run to closure.

**Reliability**

- **Office tools, one format at a time.** Spreadsheet, Document and Presentation
  editing are now separate skills. An agent that only touches workbooks stops
  carrying the Word and PowerPoint tool definitions — roughly 3,000 tokens off every
  turn, and 5,800 for a documents-only agent. The all-formats skill still exists.
- **A failed start now tells you what failed.** When a service doesn't come up, the
  CLI names which one it is still waiting for, how long it has waited, and prints the
  tail of that service's own log — where the actual cause has been sitting all along.
  `down` also verifies Postgres actually stopped before saying it did, and an
  orphaned Postgres is detected by its data directory rather than by an open port,
  which is the only way to see one that crashed during startup.
- **Ctrl+C is honoured from the moment Postgres starts**, not five minutes later —
  interrupting a slow first boot no longer leaves a database running behind.
- **Interrupting the dev server no longer strands a Next.js process on :3000.**
  Ctrl+C under a `.cmd` launcher makes Windows destroy the whole process group at
  once, the CLI's own cleanup included, mid-run — so cleanup cannot live there. The
  process tree is now recorded while the services are healthy, and the next start
  sweeps whatever survived, matching each process by creation time so a recycled PID
  is never mistaken for one of ours. It also reaches the deepest Turbopack worker,
  which holds no port and was therefore invisible to any port scan.
- **`up` refuses to kill a process it did not start.** A port it wants may be held
  by your own dev server; it now says so and stops, instead of freeing the port by
  destroying someone else's work.
- **`down` stopped crying wolf about Postgres.** `pg_ctl stop` returns when the
  signal is delivered, not when the postmaster is gone, so a stuck-database warning
  was firing on a database that was merely still on its way out.
- **Upgrades are tested against the real published package.** A new smoke test
  installs `nodal-agents@0.8.1` from npm, configures it, then installs this build
  over the top and checks it boots, serves a real page, keeps `pg-data`, and leaves
  the master key byte-identical — a changed key would make every stored credential
  permanently unreadable, silently. Fresh installs were already covered; the upgrade
  path, which is the one most people take, was not.
- **Windows is now in CI**, alongside the Linux suite, the Playwright smoke and
  approvals specs, and the packaging smoke. Every finding from the 0.8.1 audit is
  closed.

## v0.8.1 — Jul 31, 2026

Fixes a broken 0.8.0 package: on a fresh machine the dashboard could not render at
all. **If you installed 0.8.0, upgrade.**

- **Every dashboard page returned HTTP 500 on a fresh install.** The published
  0.8.0 tarball was missing 7 of the 40 server chunks its own pages require — the
  Next.js standalone output dropped them while copying the build, and nothing in
  the release pipeline compared what the build asks for against what ships. The
  home, agents, jobs, memories, settings, logs, MCP, automations, approvals,
  connectors, skills and onboarding pages were all affected. `/api/health` kept
  answering 200 throughout, so the CLI reported the runner as healthy.
- **The pack now ships the real build, and proves it.** `build-pack` copies the
  build's own `.next/server` over the standalone copy, then fails loudly if any
  page still requires a chunk that isn't there. `verify-install` runs the same
  check against an installed copy, and both are covered by tests that now run in CI.

## v0.8.0 — The Office Release · Jul 22, 2026

Your agents step into the workplace: they can now read your Outlook mail and author
real Office documents, choose how hard they think, and the platform got a deep
reliability pass — a remote tool server that hangs can no longer freeze an agent, and
a stuttering agent can no longer flood your workspace with duplicates.

**Highlights**

- **Microsoft 365, connected.** A native Microsoft OAuth connector plus an Outlook mail toolset — your agents authenticate to M365 and work your mailbox, alongside the existing Google/Notion/Airtable connectors.
- **Agents that author documents.** A local office-authoring toolset builds real `.docx`, `.pptx`, and `.xlsx` files — multi-section documents, slides, spreadsheets with charts and pivots — with loud, honest failures when something can't be produced (no silent half-files).
- **Choose how hard your agent thinks.** Each agent gets a reasoning-effort setting (Auto / Off / low → max). The dashboard only offers the levels a model actually supports, and the choice applies per link of the fallback chain.
- **Community skills, kept in sync — on your terms.** Installed skills track upstream updates with a badge and a notification bell. Updates are a true three-way merge: if you've edited a skill's scripts locally and upstream also changed, you get a **"Keep your version"** option instead of a silent overwrite — and script authorization is revoked before any new file is written, so an update can never run un-vetted code. Skills also show where they came from (provenance) and a redesigned Tools view makes capabilities ON/OFF the primary control.
- **Rate limits handled gracefully.** LLM 429/529 responses are retried with a capped `Retry-After` backoff, and fast-failover to a fallback model when one is configured — no more a single provider hiccup killing a job.

**Reliability & fixes**

- **A hung MCP server can't freeze your agent.** Each remote tool-server connection gets its own network dispatcher, so one server whose event stream hangs no longer starves every tool call behind it (previously froze the whole agent for a minute per call).
- **No more duplicate connectors.** Creating a connector is now idempotent — an agent that stutters can't register the same connector eight times; a same-name duplicate fails loudly, while genuinely different instances (two accounts, same provider) still work.
- **Delegated workers stay in their lane.** A sub-agent no longer speaks on your channels or self-publishes status cards — delivery is the orchestrator's job — and it can no longer overwrite shared workflow templates in place.
- **Routines get a safety net.** Creating a scheduled routine that references a tool the agent doesn't have (or an ambiguous non-capability like "your state") now surfaces a warning at creation time.
- **Honest delivery.** A Telegram send that times out is no longer blindly retried (the message was likely delivered) — it's reported as ambiguous instead of duplicated.
- **Leaner and faster.** A pre-0.8 audit dropped dead tables and columns, added a missing index, batched N+1 queries, tightened fetch timeouts, and hardened process-level error handling. Typography moved fully onto the design-system token scale, and a new Table primitive standardizes data tables across the dashboard.

## v0.7.95 — The Living Design System Release · Jul 16, 2026

The design system stopped being a snapshot and became a loop: the Figma library and
the code are now mechanically tied together, checked by machine in both directions,
and the last stock-browser UI (the select dropdown) was brought under the system.

**Highlights**

- **Figma ↔ code, closed loop.** All 73 shared UI components are mapped to the Figma library via Code Connect. A drift detector (`figma:drift`) fails when a component, variant, or mapping diverges between the file and the repo, a DS lockfile (`figma:ds-lock`/`ds-diff`) captures the library state, and a lint guard blocks any arbitrary text size from sneaking past the type ramp.
- **The select menu finally speaks DS.** Dropdowns use the new customizable-select standard (`appearance: base-select`, Chrome/Edge): the open menu renders the design-system panel — paper surface, popover shadow, hover/selected states, the DS caret and check glyphs — with grouped options getting real section headers (styled `<optgroup>` legends). Other browsers keep their native picker, cleanly. Placeholders now grey out like every other field, and the field is pixel-checked against the Figma spec by machine (47 automated conformance checks).
- **Agents page, redesigned.** Orchestrators are cards with their workers inside; dragging a worker across cards reassigns it. Delete moved to a type-to-confirm danger zone in Settings, and channel connections live in an in-page Channels tab.
- **Pick where notifications land.** Schedules and webhooks gained a "Notify via" selector — results go to the channel you chose (Telegram, Discord, Slack), and if that channel isn't connected the run fails loudly instead of falling back silently.
- **Docs, audited page by page.** Ten pages corrected against the real code, four end-to-end channel connection guides (Discord, Slack, WhatsApp, event triggers), and the README now documents the dev command that actually boots the stack.
- **Fixes.** Multichannel transport resolves the reply channel per conversation; incoming webhooks moved to `/wh/v1`; an MCP server failing to load its tools no longer kills the whole job; sidebar labels no longer clip letter descenders; segmented controls no longer render a phantom empty segment; the dead "+ New connector" button is gone.

## v0.7.9 — The Design System Release · Jul 13, 2026

The entire dashboard was brought under one enforced design system: every interactive
element is now a shared component, consistency is guaranteed by CI rather than
vigilance, and the whole thing was verified page by page in both themes. Plus the
Google Gemini provider was rebuilt.

**Highlights**

- **One visual language, enforced.** Buttons, inputs, selects, badges, pills, menus, and modals were all migrated onto a set of shared UI primitives (245 hand-styled raw elements replaced). A lint rule now makes any raw `button`/`input`/`select`/`textarea` outside the component library fail the build, so the consistency can't silently drift back. Verified route by route, modal by modal, in light and dark.
- **Edit is always a modal.** List editing no longer expands an inline accordion that pushes the page around; every edit opens a non-dismissable dialog (backdrop and Escape inert, Save/Cancel only), with one canonical footer template used site-wide — never zero, never two action rows.
- **One row-action grammar.** Per-row actions are icon-only squares with a mandatory tooltip; one concept = one verb = one icon; Delete/Disconnect/Uninstall is always last; no kebab menus for standard actions.
- **End-to-end channel connection guides.** Connecting an agent to Discord, Slack, WhatsApp, or Telegram now has a step-by-step guide — app/token setup, the ownership DM, the invite, and a "verify it works" check — written from the real handler code and shown in a cleanly formatted modal.
- **Google Gemini, rebuilt.** Native and OpenRouter Gemini paths were reworked: thought-signature round-tripping on tool-call parts (native returns a hard 400 without it), native thinking config, and a 3.x-only native catalog — so tool-calling agents run correctly on Gemini.
- **Polish.** The Settings page body was widened to match every other page (it had been a third narrower). Learned Skills now reuses the Skills page's per-agent assign/unassign toggle list, so you can finally unassign a learned skill. Slack logs a clear line on connection, and the file-sending tools resolve relative paths against the workspace.

## v0.7.8 — The Everywhere Release · Jul 12, 2026

Your agents now live everywhere you already talk: **Discord, Slack, and WhatsApp
join Telegram**. Plus event-triggered automations, agents that can no longer
misstate what they did, and a new LLM provider. (Versions 0.7.6 and 0.7.7 were
never published; their work ships here.)

**Highlights**

- **Four messaging channels.** Connect any agent to **Discord** (server mentions — including the role mentions Discord's autocomplete really inserts — DMs, and tappable approval buttons), **Slack** (Socket Mode, with a ready-to-paste app manifest right in the dashboard), and **WhatsApp** (QR pairing; unofficial-API caveat shown up front), alongside Telegram. Same security model everywhere: the first private conversation claims ownership, every other conversation needs your explicit approval, one owner per agent per channel — guaranteed by the database.
- **Channels your agents actually know.** Each agent sees which platforms it's connected to and can list the real servers, channels, and conversations it has access to (and which are approved) instead of denying a connection it has.
- **Event triggers.** Scheduled watchers know exactly "what's new since last run", carry a daily budget, and never overlap themselves; **inbound webhooks** let an external service start a job directly — timing-safe token check, payload isolation against prompt injection, rate-limited, managed from the dashboard.
- **Agents can't deny their own actions anymore.** Every exchange carries a structural record of the actions it performed; a delegating agent's thread shows what its sub-tasks actually did (tools called, result); and an agent that tries to assert platform state without checking gets stopped by the runtime and made to verify first.
- **No more silent replies.** The delivery guard that kept Telegram jobs honest now covers Discord and Slack too: a job physically cannot complete without its reply reaching your channel.
- **Moonshot/Kimi, native.** Kimi K2.6 and K2.7 Code as a first-class provider (thinking handled correctly, temperature managed server-side, and a strict tool-schema sanitizer that also protects Kimi models routed through OpenRouter). Model pickers now show which models can use tools, and a model that can't is blocked from the orchestrator role.
- **Onboarding, revamped.** The get-acquainted interview no longer shows up in your Chats afterwards, and setup ends with a real choice of messaging channels (brand icons, not emojis).

**Approval authority (from the unpublished 0.7.6)**

- **Approval cards always go to the bot owner.** When someone you've authorized to talk to your bot (a guest chat) triggers an action that needs approval, the ✅/❌ card now lands in **your** private chat with the bot — never in the guest's. Previously a guest authorized via a private DM could tap ✅ on their own gated action and self-approve; that hole is closed, and guest-triggered approvals in groups no longer leak the card into the group either. Your own actions are unaffected. (Per-guest capability profiles — restricting *which* actions a guest can even request — are designed and coming next.)
- **Scheduled reports and Telegram deliveries reach you, not a group.** A cron's success summary (and the dashboard's "send result via Telegram") used to target *the last chat the agent was spoken to in* — which a group message silently overwrote, so a report could leak into a group the moment someone @-mentioned the agent there. These now always deliver to the **owner's** private chat. A schedule can still be given an explicit target chat when you deliberately want it to post somewhere specific.
- **Redesigned chat page.** The conversation view is rebuilt from the ground up: messages in a centered column, agent replies with a lime avatar and a clean name/text layout, dark bubbles for your messages, a floating rounded input, and a distinct Conversations panel. Same speed, same features — just far nicer to look at, in both light and dark themes.

**Communication security (full audit — 11 findings, all fixed)**

- **Agents can only message chats you've approved.** Every Telegram send tool (messages, images, files, media) now verifies an explicit target chat against your approved-chats list — an agent can never message an arbitrary chat id it learned or guessed, and a delegated worker using the entity's bot token is held to the same list. Sends are also hard-capped per job, so a runaway loop can't spam you.
- **Files an agent sends are confined to its own space.** `send_file`/`send_image` used to read *any* path on the machine — a prompt-injected agent could exfiltrate config or credential files. Sources are now confined to the agent's workspaces, the skill store, and the temp dir; remote fetches are size-capped while streaming and blocked from link-local/metadata addresses, including via redirects. (Localhost stays available — your ComfyUI flow is untouched.)
- **`/ask` respects each agent's own guest list.** Relaying a message to a sibling agent (`/ask finance-bot …`) now requires the chat to be approved for the *target* agent — otherwise the owner gets a confirmation card naming that agent. A relay can never claim bot ownership.
- **One owner per bot, guaranteed.** A database constraint makes duplicate owner claims impossible (a race between two first contacts could previously mint two co-owners); requester names on approval cards are sanitized against impersonation tricks; group mentions only trigger on exact @username matches and on replies to *this* bot.

**Scheduled runs got smarter**

- **Cron jobs know "since when".** Every scheduled run now carries its schedule's previous fire time in context ("Previous run of this schedule: …"), so a watcher-style agent can reliably act only on what's *new* — no more re-announcing old items or depending on fragile memory. The groundwork for event-triggered automations.
- **Silent schedules can still speak up.** A schedule with success-notifications off now lets its agent message *you* (the owner) when it decides something is worth saying — check a feed every 15 minutes, stay silent when nothing changed, ping you the moment something new appears.
- **Freshly attached MCP servers work on their first job.** Tool caches are stored complete at install time, and a server that fails to spawn is logged loudly instead of silently contributing zero tools.

## v0.7.5 — The Trustworthy Orchestrator · Jul 8, 2026

A deep security-hardening wave, and a rebuilt approval & delegation experience —
born from a forensic audit of real jobs that were slow, noisy, and occasionally
wrong.

**Approvals you can actually read — and that don't stall your job**

- **Approval cards now lead with the WHY.** Three levels: the agent's stated purpose, then a plain-language impact line computed by the platform from the same classifiers the security gate uses (``Runs `rm` — destructive or heavy…`` / ``Runs `curl` → `head` — no destructive pattern detected``), then the full technical detail. Identical on Telegram and the dashboard.
- **Approving is instant now.** When you approve within ~2 minutes, the job continues **in-process** — no more full restart per approval (which cost 80-105 s each, MCP reconnections included). Approvals that take longer still suspend safely and resume as before.
- **MCP servers connect lazily.** A job no longer spawns every attached MCP server at startup — the toolset builds from a cache and a server is only spawned the first time one of its tools is actually called.

**Delegation that delivers**

- **Delegated workers can deliver to you directly.** A worker generating your image now inherits the entity's Telegram delivery tools and sends it itself — and the orchestrator is told `[livraison effectuée]` so it never re-delivers or mislabels a delivered job as failed.
- **Orchestrator discipline, built in.** Every orchestrator now carries intrinsic rules: pass parameters in the brief (don't do the worker's prep), never edit a shared template to smuggle in run parameters, never prescribe a tool the target agent doesn't have. Briefs naming an unavailable tool get an immediate warning.
- **Shared files are protected.** Overwriting an existing file in the shared workspace now requires approval (in both gated autonomy modes) — your saved templates can't be silently corrupted anymore. Your own attached workspaces (e.g. an Obsidian vault) are never gated, and creating new files never asks.
- **Memory that corrects itself.** Every agent must now mark a memory fact outdated the moment it proves false in practice (and save the verified correction); workers save durable discoveries before finishing; and "lessons" that micromanage other agents or ban discovery can no longer be saved.

**Jobs page: conversations, not noise**

- A 10-message chat with your agent is now **one expandable 💬 row** (exchanges, time range, aggregated cost) instead of ten identical job rows. Real work — tools, delegations — stays as full rows. Your existing history is regrouped automatically on upgrade.

**Security hardening (full audit remediation)**

- **Secrets stay secret.** MCP stdio subprocesses no longer inherit the full process environment (a third-party server could read your keys); API keys are redacted from tool-call audit logs; a CI secret-scanner blocks hardcoded credentials from ever reaching the repo again.
- **Context windows respected per model.** The runner now knows each model's real context window (catalog, stored value, or auto-probed from LM Studio) instead of assuming 128K — small local models no longer die silently mid-conversation, and overflow fails loud instead of corrupting.
- **Plus:** credential helpers moved out of the server-action surface, `create_mcp`/`attach_mcp` gated as code execution, SSRF guards on MCP URLs, timeouts on all Google clients, security headers, signup closed once an owner exists, bounded results across a dozen adapters, and memory injection that finally counts as usage (your useful facts stop being archived by the curator).

## v0.7.2 — Platform Audit Fixes · Jul 7, 2026

Twelve security and reliability fixes from an external-grade platform audit.

**Highlights**

- **Delegation can't run away.** Depth/fan-out caps enforced at the delegation point, cost-cap checkpoints mid-job, and cancellation is respected everywhere — a cancelled job stays cancelled.
- **Authorization tightened.** Approval endpoints check entity ownership (no cross-tenant IDOR), bearer tokens are entity-scoped, and the code-execution master switch is owner-only on LAN installs.
- **Runtime hygiene.** Child processes run with a scrubbed environment; per-model context limits and cost accounting checkpoints keep long jobs honest.

## v0.7.0 — Scalable Memory · Jul 2, 2026

Memory that stays fast and relevant as it grows.

**Highlights**

- **Full-text search inside agent memory.** Facts are indexed (Postgres FTS + GIN) and ranked by real relevance to the task at hand, not just recency — the agent surfaces the right fact even with hundreds stored.
- **A memory curator.** A bounded background pass distills oversized facts, merges near-duplicates, archives what's provably unused, and re-scores importance from actual usage. On by default, per-entity switch.
- **Pin what matters.** Star a fact in the dashboard to lock its importance — the curator can never archive or down-rank what you pinned.

## v0.6.8 — First-Run Experience · Jul 1, 2026

A fresh install lands on a capable agent that can search the web and matches the
autonomy you asked for.

**Highlights**

- **Web search out of the box.** `web_search` is now a real, always-on tool: it uses your **Tavily** or **Firecrawl** connector if you have one, and otherwise falls back to a **free, best-effort DuckDuckGo** search — so a brand-new install can look things up immediately. If the free path is rate-limited or blocked, it says so and guides you to add a Tavily key for reliable results (and switches to it automatically once you do).
- **Onboarding sets your autonomy for real.** The get-acquainted interview's "should I take initiative or stick to exactly what you ask?" answer now drives the agent's **actual autonomy level** — three modes (Take initiative / Balanced / Ask first), shown on a confirmation screen you can adjust, changeable anytime in Settings → Autonomy. It used to only land in memory. And the first agent now arrives with its ROOT powers **enabled**, not locked down — capable from minute one instead of asking to confirm everything (a local/personal install; the autonomy level is the guard-rail).
- **Built-in tools, documented.** A new auto-generated reference lists all **51 built-in tools** (`web_search`, file ops, memory, `dashboard_publish`, the ROOT meta-tools…) with each one's risk level and how it's unlocked — generated from the tool registry so it can't drift.

## v0.6.7 — Boot Regression Fix · Jul 1, 2026

Undoes a 0.6.5 packaging change that broke `nodal-agents up` on fresh installs.

**Highlights**

- **Fixed: the runner failed to start on a fresh install.** 0.6.5 bundled the `node-fetch` chain into the tarball to silence one last benign deprecation notice — but `node-fetch@3` is ESM-only, and frozen into the package it displaced the CommonJS `node-fetch@2` that the Notion SDK loads via `require()`, crashing the runner at import (`Cannot find module 'node-fetch'`) so it never became healthy. Now **only `exceljs` is bundled** (CommonJS, self-contained): the scary warnings (`glob` "security", `inflight` "memory leak") stay gone, and the one benign `node-domexception` notice returns — a fine trade for a runner that actually boots. The generous 5-minute first-run health budget from 0.6.6 stays.

## v0.6.6 — Fresh-Machine Boot Fix · Jul 1, 2026

A fresh install on a clean machine could time out on its first launch — fixed.

**Highlights**

- **First run no longer times out on a clean machine.** The runner's health-check budget was 60s, but the very first `nodal-agents up` on a fresh machine is heavy — embedded-postgres fetches its ~70MB binary at runtime (more so when npm script-approval blocks its postinstall), and the runner loads a large module graph off a cold disk cache — which could blow past 60s and tear the stack down (`did not become healthy within 60000ms`). The cold-start budget is now **5 minutes** and env-overridable (`NODALAI_RUNNER_HEALTH_MS` / `NODALAI_WEB_HEALTH_MS`). If it ever still times out, **a retry runs warm** (binary cached, modules loaded) and comes up fast — and the error message now says exactly that.

## v0.6.5 — The Frictionless Release · Jul 1, 2026

Install and first run, cleaned up: a silent install, a browser-first setup with
no account, and a welcome chat that never traps you.

**Highlights**

- **A silent install.** `npm install -g nodal-agents` no longer prints the scary `npm warn deprecated` lines — `glob` "widely publicized security vulnerabilities", `inflight` "leaks memory", and the rest. They were stale transitive deps of `exceljs` (not reachable vulns, just upstream cruft); since npm `overrides` don't reach a global install, the fix bundles `exceljs` and the tiny fetch chain inside the published tarball. Same bytes a user downloads, **zero warnings**.
- **Browser-first first run.** A fresh `nodal-agents up` asks **nothing** in the terminal. It boots with a sensible default and opens the dashboard straight to a guided setup — connect a model, create your first agent, meet it. `nodal-agents init` still exists for LAN / auth / terminal setup and Docker.
- **No account by default.** Local installs run in `local-trust` on loopback — **no sign-up wall**. Auth is opt-in, for LAN / multi-user.
- **A welcome chat that never traps you.** At the end of the get-acquainted interview, the **Continue** button now appears as soon as you've answered the questions (it no longer waits on a done-marker that smaller/local models forget to emit), and a **Skip for now** button is always visible so a slow model can't strand you.

## v0.6.4 — Onboarding Restored · Jul 1, 2026

A fresh install no longer locks you out — the real first-run flow is back.

**Highlights**

- **Fixed: every fresh install was locked out.** A workspace with no agents yet (the default state right after install — no agent is seeded by design) was redirected to an unfinished onboarding placeholder ("Migration WIP") and trapped there, with no way to reach the dashboard or create an agent. The real guided first-run flow is restored and wired back in: connect a model → create your first agent → a short welcome interview where the orchestrator introduces itself, gets to know you (your name, where you're based, what you want help with), and saves that to memory. It had been built and tested but parked on a side branch and excluded from a past release for lint errors; those are fixed and it's merged.
- **Documentation, greatly expanded.** A full reference pass: auto-generated catalog references (every connector and its tools grouped by read/write/destructive, MCP servers, models with vision/reasoning flags, ROOT grants — generated from the catalogs so they can't drift), plus new pages for connecting tools (per-connector OAuth/API-key setup), troubleshooting/FAQ, the CLI, the dashboard, operating & observability, the HTTP API, and workspaces. Several inaccuracies vs the code corrected.

## v0.6.3 — The Design Pass · Jun 30, 2026

Every screen now wears the same skin — one header, one toolbar, one set of rules.

**Highlights**

- **One header, one toolbar, everywhere.** Every page renders a single shared shell: a full-width navbar (page title + lede on the left; global search, notifications, theme on the right; a bottom rule), and beneath it a consistent toolbar — filter tabs + search + a single create button. Create buttons follow one colour convention (agents = lime, skills = coral, connectors = blue, everything else = white), always top-right, always labelled "New …". No more per-page drift.
- **Runs, as a delegation tree.** The Runs page is now a delegation-aware table: each orchestrator sits directly above the runs it delegated, role colour-coded by a left accent, with trigger icons (cron / Telegram / dashboard), abbreviated token counts, and the real provider-reported cost.
- **Skills, rebuilt.** Two views — _Assigned_ (a management table) and _Library_ (the whole catalog as uniform tiles), filtered by content category (Development, Finance, Office, Media, Design…) instead of the old source split. Category pills on every tile; one-click install from any community source.
- **Long lists collapse.** OAuth scope URLs, required built-ins, and "used by" connectors now show as a compact "N items" pill you hover to expand — no more columns blown off the table. Credentials moved from cards to a matching table.
- **Know when to update.** The sidebar shows your running version and, when npm has a newer one, an "Update available" badge with the one-line `nodal-agents update` command.
- **All-English UI.** The community-skill catalog and connector descriptions are fully translated.
- **Also:** Poyo image connector + VidIQ added to the catalogs · the full Telegram media surface (`send_file` / `send_video` / `send_audio` / `send_voice`, not just images) · a Weekly ⇄ Daily toggle on the home activity chart · a copy button + shortened path for the shared workspace in Settings · the unused Billing menu removed · the sidebar widened to 244px.

## v0.6.2 — The Recall Release · Jun 28, 2026

Your agents remember — within a conversation, and across everything they've ever done.

**Highlights**

- **Conversations that hold the thread.** Session memory now measures a pause from when the agent's reply was *delivered*, not from when the job started — so a slow task (a render, a deep research run) no longer makes your quick follow-up look like an hour of silence that wipes the conversation. The idle reset widened (30 min → 4 h), the history budget grew, the reply's *tail* (its conclusion / next-step) is kept instead of chopped, and a job that *failed but spoke to you* stays in the thread. Measured on a real 122-message conversation: amnesia dropped from 39% to 13% (the rest are genuinely new sessions).
- **Two-tier memory.** Injected memory is now ranked by relevance to the task at hand — not just global importance — so the budget surfaces facts about *this* request. Every job's transcript is full-text searchable on demand via the new always-on `search_history` tool: durable recall of anything the team has ever done, at zero standing context cost. And a background **memory curator** distills oversized facts, merges duplicates, and prunes the stale — never touching what you entered by hand.
- **3D & creative connectors.** Blender, Unity, Unreal Engine, KeyShot, and Photoshop (cross-platform) join the MCP marketplace under a new **Creative** category — each with a real brand icon.
- A longer MCP tool timeout (heavy tools like renders no longer time out at 60 s), and a fix for an order-dependent CI flake.

## v0.6.1 — The Vision Release · Jun 27, 2026

Send a picture on Telegram and your agents can actually look at it.

**Highlights**

- **Inbound images.** A photo sent on Telegram now starts a job — it was silently dropped before (the handler only read text, never the caption). The image is saved to your shared workspace (`telegram/<chat>/<job>.<ext>`), reachable by the agent's file tools, and handed to the model — so "describe this image" works.
- **Vision routing, by real capability.** Each model's image support is read from the providers themselves (OpenRouter's `/api/v1/models` + models.dev) and surfaced in the orchestrator's team view. A text-only orchestrator routes the picture to a vision-capable teammate — the image travels with the delegation — or tells you plainly if none can see it. No guessing, refreshable with one script.

## v0.6.0 — The Clarity Release · Jun 25, 2026

Approvals that explain themselves, chat hand-offs that stay faithful, and session
memory that knows when a conversation is over.

**Highlights**

- **Approvals in plain language.** Every gated action (shell command, skill script, bundle write) now leads with the agent's own one-line explanation of *what* it's doing and *why* — plus a ⚠️ impact line when it deletes, installs, or spends — instead of a wall of raw shell. On Telegram and in the dashboard.
- **Faithful chat hand-offs.** When the dashboard chat escalates your request to a worker, your exact words now travel with it — no more silently reworded instructions. A 30-minute idle gap starts a fresh conversation, so a thread you return to hours later doesn't drag yesterday's context into a new request.
- **Role-aware delivery.** Delegated workers hand results back to their orchestrator instead of double-delivering to you; the "how to structure and where to send" lives in a reusable skill, so a bare "research X" is enough.
- **A shared workspace link** in Settings, and a complete README rewrite.

## v0.5.5 — The Autonomy Release · Jun 23, 2026

Real autonomy levels, a curated community catalogue, and agents that stop making
things up.

**Highlights**

- **Three real autonomy levels** per workspace ROOT — `propose-confirm`, `destructive_gate` (auto-run ordinary work, still gate anything destructive), and `fully_autonomous` — enforced at execution time, not just in the UI.
- **A 40-skill Community catalogue** — install any of them with one click, every path verified.
- **Google Calendar** connector, and an entity-scoped skill store.
- **Anti-confabulation team blocks** — orchestrators describe their real team instead of inventing teammates, and delegated sub-agents suspend/resume cleanly across an approval.

## v0.5.0 — The Self-Improving Release · Jun 15, 2026

A closed learning loop, native frontier-OSS endpoints, and one orchestrator that
does both delegation styles.

**Highlights**

- **A closed learning loop (opt-in).** After a substantial job an agent reflects and writes itself a reusable skill; a weekly curator consolidates and prunes them. Review, assign, or revoke every learned skill from the dashboard.
- **Native DeepSeek & MiniMax** endpoints alongside OpenRouter — pick the route per key, with reasoning round-tripped across tool calls so reasoning models don't degrade mid-task.
- **Unified orchestrator** — every orchestrator gets both delegation styles and commits to one per request: route to a specialist and resume on its result, or fan work out to a parallel task board and compile it.
- **Install any community `SKILL.md`** from GitHub, skills.sh, or ClawHub — pure HTTPS, SSRF allow-list, zip-slip guard, scripts flagged and never run.
- **A real-dollar cost cap** per job (from the provider's actually-billed cost), plus a no-false-success guard that refuses to report "done" when an action failed.

## v0.4.4 — The Context Release · Jun 4, 2026

Long jobs stay inside the window, failures become diagnosable, and delivery only
happens when there's somewhere to deliver.

**Highlights**

- **Context compaction** — stale tool output is evicted before the window overflows, keeping the recent turns intact.
- **Real provider errors** — failures surface the actual upstream message and persist the full transcript, instead of an opaque "provider returned error."
- **Channel-aware delivery** — an agent only reaches for `telegram_send_message` when there's a resolvable recipient, killing phantom sends on dashboard/API jobs.

## v0.4.3 — The Reasoning Release · Jun 3, 2026

**Highlights**

- **Reasoning models, round-tripped.** A reasoning model's hidden chain-of-thought is now replayed across tool calls (via the official OpenRouter SDK), so MiniMax M3, DeepSeek, and friends keep reasoning on multi-turn tasks instead of stalling.
- Fixed an orchestrator that would narrate an action without performing it (poisoned history — escalations are now replayed *with* their `run_task`).

## v0.3.7 — The Root Agent Release · May 30, 2026

**Highlights**

- **A self-extending ROOT agent.** Designate your first orchestrator as the workspace ROOT and let it create skills, create agents and assign them, and stand up MCP servers + connectors on your behalf — each gated by a per-grant toggle and an autonomy level.
- Provisioning verifies before it writes (an MCP server is connected and its tools listed first); skill authoring is grounded in the workspace's real tools.

## v0.3.0 — The Workspaces Release · May 28–29, 2026

**Highlights**

- **Multiple isolated workspaces** on one install (personal vs work), switchable from the sidebar — each with its own agents, skills, connectors, jobs, and memory.
- **Office files** — edit Excel in place, create Word & PowerPoint, inside the agent's workspace.
- **One-command upgrade** (`nodal-agents update`) with a boot version notice.
- A reworked Skills library (Assigned / Custom / Built-in) and a richer connector + MCP marketplace.

## v0.1.0-beta — First public beta · May 13, 2026

The first published build: a local-first, multi-agent platform on embedded
Postgres — team orchestration, per-agent models, persistent memory, Telegram, and
connectors, in two commands.

---

*For the full commit-level history, see the [GitHub releases](https://github.com/Kwintspiracy/nodal-agents/releases).*
