# Nodal-Agents

> **Your AI agents. Your data. Your machine.**
> Self-hosted, local-first AI agent platform — install in two commands.

[![npm](https://img.shields.io/npm/v/nodal-agents?color=cb3837&label=npm&logo=npm)](https://www.npmjs.com/package/nodal-agents)
[![Node](https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

Build and orchestrate a **team of AI agents** on your own hardware —
each with its own personality, tools, memory, and model. Talk to them in
the dashboard or on Telegram; they research, write files, call your
connectors, and delegate to each other to get the job done.

**No SaaS lock-in. No per-token markup. No cloud roundtrip.** Two commands
to install, runs on any machine with Node 22+ (Mac, PC, Linux), and works
with **any LLM** — frontier or local, paid or free.

---

## Why Nodal-Agents

| | |
| --- | --- |
| 🏠 &nbsp;**Local-first** | Single binary, embedded Postgres, zero cloud dependency. Your conversations, memory, and credentials stay on your machine. |
| 🔌 &nbsp;**Any model, per agent** | Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter, or any local model (LM Studio, Ollama). Setup is just an API key per provider — **each agent picks its own model**, so you can run Claude for the orchestrator and **DeepSeek V4** for the workers. The quirks of OSS frontier models (DeepSeek's non-spec tool args, Kimi/Qwen/GLM XML tool formats, and round-tripping a reasoning model's chain-of-thought across tool calls so MiniMax M3 / DeepSeek / Gemini 3 don't degrade mid-task) are handled automatically. |
| 🛟 &nbsp;**Provider failover** | Give an agent a backup key chain — if its provider 5xx's, times out, or hits quota mid-job, the runner fails over to the next one and keeps going (and fails loud only when the whole chain is down). |
| 🧠 &nbsp;**Memory that compounds** | Persistent facts (entity-scoped, auto-injected into every job) and chat-thread continuity (your agent remembers what it said 30 seconds ago — and what it said yesterday). |
| 🤝 &nbsp;**Orchestrators that finish** | Router and planner orchestrators delegate to specialist sub-agents, then resume on completion to wrap up the answer. |
| 🛡️ &nbsp;**Agents that don't lie, loop, or die** | Generic runtime guards: a per-job token budget and a no-progress detector kill runaway loops; a no-false-success guard refuses to report "done" when an action actually failed (fail loud, never fake it); turn/chain/delegation caps bound everything. |
| 🔧 &nbsp;**Multi-instance connectors** | Gmail perso *and* Gmail boulot on the same install. OAuth *and* API-key supported. Active list + Marketplace UI in the dashboard. |
| 🗂️ &nbsp;**Workspaces** | Multiple isolated workspaces on one install (personal vs work) — each with its own agents, skills, connectors, jobs and memory. Switch from the sidebar. |
| 🤖 &nbsp;**Self-extending (ROOT agent)** | Designate an orchestrator as ROOT and let it create skills/agents and assign them on your behalf — gated by per-grant toggles and an autonomy level (propose-confirm → fully-autonomous). |
| 📄 &nbsp;**Office files** | Read + edit Excel in place, create Word & PowerPoint, inside the agent's workspace — gated behind the office-editing skill. |
| 📡 &nbsp;**MCP support** | Connect MCP servers over Streamable HTTP *and* stdio (local subprocess) — a growing catalogue (Stripe, n8n, Supabase, Airtable, Notion…) plus add *and edit* your own custom servers from the UI. Per-job tool discovery, tool whitelisting, multi-instance. |
| 💬 &nbsp;**Telegram out of the box** | Long-polling, multi-agent routing (`/ask <slug>`), group-chat filters, conversation continuity, delegation gracefulness on Telegram. |
| ⚙️ &nbsp;**Real engineering** | TypeScript strict, dependency-cruiser-enforced architecture, full unit + integration suite, Playwright e2e, idempotent migrations, encryption at rest for keys. |

---

## Screenshots

| Home dashboard — light theme | Agent detail — dark theme |
| :---: | :---: |
| ![Home dashboard, light theme](docs/screenshots/home_lightheme.png) | ![Agent detail page, dark theme](docs/screenshots/agent_darktheme.png) |

---

## Install

```bash
npm install -g nodal-agents
nodal-agents up
```

Open <http://localhost:3000>. The CLI spawns an embedded Postgres on a
free port, applies migrations, seeds the system skills, and starts the
runner (`:3001`) and dashboard (`:3000`). Connect an LLM provider from
**LLM Providers** in the dashboard — paste an API key and you're running.

> Requires Node 22+. No external Postgres, no Redis, no cloud config.
> Data lives at `~/.nodalai/` — wipe with `rm -rf ~/.nodalai`.

To stop the stack: `nodal-agents down`.

## Update

```bash
nodal-agents update
```

Checks the npm registry for the latest version, stops the running stack,
installs `nodal-agents@latest` globally, and restarts services automatically.
No data is touched — the embedded Postgres data directory is preserved.

```bash
nodal-agents update --no-restart
```

Installs the update but skips the automatic restart. Run `nodal-agents up`
manually when ready.

When a newer version is available, `nodal-agents up` also prints a one-line
notice:

```
ℹ v0.4.3 available — run `nodal-agents update`
```

### Build from source

```bash
git clone https://github.com/Kwintspiracy/nodal-agents.git
cd nodal-agents
pnpm install
pnpm --filter nodal-agents exec tsx src/index.ts --dev
```

Dev mode runs `next dev` so the dashboard hot-reloads on file changes.

---

## How it works

```
   ┌─────────────┐    Telegram /     ┌────────────────────────────────┐
   │   Channel   │   Dashboard  ───▶ │         Runner (Hono)          │
   │  (telegram, │    POST /api  ◀── │  • Job queue + executor        │
   │   web …)    │                   │  • Anti-runaway guards          │
   └─────────────┘                   │  • Per-agent tool whitelist     │
                                     │  • Memory auto-injection        │
                                     │  • Session-thread continuity    │
                                     └─────────┬──────────┬────────────┘
                                               │          │
                                       ┌───────▼───┐  ┌───▼─────────────┐
                                       │    LLM    │  │  Connectors /   │
                                       │  client   │  │  MCP servers    │
                                       │ (multi-   │  │  (Gmail, Drive, │
                                       │ provider) │  │   Notion, Cogni │
                                       └───────────┘  │   Cortex …)     │
                                                      └─────────────────┘
```

Every agent is a row in Postgres — personality, skills, connectors,
memory budget, team assignments live in the database. The runtime is
generic: **zero hardcoded agent metadata.** Adding capabilities means
inserting rows, not editing code.

A user message via Telegram becomes an `agent_jobs` row. The runner
loads the agent's prior chat-thread history, injects relevant
persistent memories, dispatches to the LLM, executes any tool calls
emitted, and finalizes via `telegram_send_message` + `return_result`.
Delegations create child jobs that resume the parent on completion.

---

## Dashboard

| Route | Purpose |
| --- | --- |
| `/agents` | Create, edit, assign skills + connectors + MCP servers to agents — and pick each agent's provider + model (with an optional failover chain). |
| `/llm-providers` | Connect each LLM provider with a single API key — enable/disable inline. Models are chosen per-agent, not here. |
| `/jobs` | Live job stream — task, agent, status, full transcript, tool I/O. |
| `/connectors` | Active connector instances + Marketplace (multi-instance, OAuth or API-key). |
| `/mcp` | Active MCP servers + Marketplace — HTTP & stdio, a growing catalogue, plus add/edit your own custom servers. |
| `/memories` | Persistent facts per entity — search, edit, archive. |
| `/skills` | Assigned / Custom / Built-in Library tabs — reusable instructions appended to an agent's prompt; create your own or customise built-ins. |
| `/logs` | Tool-call audit — input/output JSON per call, filterable by tool name. |
| `/approvals` | Human-in-the-loop gates for risky tools (and the ROOT agent's meta-tools under propose-confirm). |
| `/automations` | Cron-scheduled agent triggers. |
| `/settings` | Auth mode, network (loopback / LAN), bot tokens, workspace management, ROOT-agent grants + autonomy. |

---

## Stack

| Layer | Tech |
| --- | --- |
| Runtime | Node 22+, TypeScript strict (no `any`, no `@ts-ignore` without comment) |
| Monorepo | pnpm workspaces + Turborepo |
| Database | embedded-postgres (Win / Mac / Linux), Drizzle ORM, idempotent migrations |
| Validation | Zod everywhere |
| HTTP server | Hono (runner), Next.js 16 (dashboard) |
| LLM | Vercel AI SDK — multi-provider with retry + timeout + tolerant parsing |
| Auth | local-trust (single-user loopback) / better-auth (multi-user LAN) / bearer-token |
| Encryption | AES-256-GCM at rest for API keys, master key in `~/.nodalai/secrets.key` |
| Tests | Vitest (unit + integration), Playwright (e2e), dependency-cruiser (architecture) |

---

## Monorepo

```
apps/
├── cli              nodal-agents CLI: install, up, down, ops
├── runner           Hono server: job execution, cron, channel pollers
└── web              Next.js dashboard

packages/
├── db               Drizzle schema + migrations + client (only postgres importer)
├── shared           Zod types + constants shared across web + runner
├── llm              Vercel AI SDK wrapper, retry, timeout, native tool-call parsers
├── tools            Tool registration + execution + approval gates
├── memory           Persistent memory CRUD + sanitation + dedup + auto-injection
├── orchestration    Router / Planner patterns, delegation, chain counters
├── adapters         Connector packages (gmail, drive, sheets, docs, notion,
│                    airtable, apify, firecrawl, tavily, MCP)
├── runner-adapters  Adapter registry, agent ↔ tool wiring
├── delivery         Telegram, email
├── auth             Pluggable auth provider
├── catalog          Shipped system skills (office-editing, telegram-responder,
│                    obsidian, task-planning, markdown-output, language-mirror …)
└── secrets          AES-256-GCM key vault
```

---

## Architecture rules (enforced by `dependency-cruiser`)

- `apps/*` may import `packages/*` — never the reverse.
- `apps/web` and `apps/runner` cannot import each other (DB or HTTP only).
- Only `packages/db` may import `postgres` / `drizzle-orm` / `pg`.
- `packages/runner-adapters/*` may only import from `packages/tools` and
  `packages/shared`.
- No circular dependencies.

```bash
pnpm deps:check   # runs locally and in CI before every release
```

---

## Status

**Current release:** `0.4.3` on npm `latest`. Used daily by the
maintainer, stable enough for personal production. Pre-1.0 — breaking
changes are still possible between minors.

### Shipped and working

- Multi-LLM, **per-agent model selection** — provider setup is just an API key
  (one per provider); each agent chooses its own model on top. Frontier and
  local providers, including **DeepSeek V4** (non-spec tool-call args normalized
  automatically) and **reasoning models like MiniMax M3** (their hidden
  chain-of-thought is round-tripped across tool calls so they keep reasoning on
  multi-turn tasks), plus native tool-call parsing for Kimi K2 / Qwen3-Coder / GLM
- **Provider failover** — an opt-in ordered key chain per agent; on a 5xx /
  timeout / quota mid-job the runner fails over to the next key, and fails loud
  (`all_providers_failed`) only when the whole chain is exhausted
- **Reliability guards (generic, model-agnostic)** — per-job token budget +
  no-progress detector (kill runaway loops), and a no-false-success guard that
  refuses to complete a job as "success" when a tool action failed and was never
  resolved (fail loud, never fake it)
- Persistent memory (sanitation, dedup, importance ranking, auto-injection,
  feedback loop)
- Session-thread continuity on chat channels (Telegram today)
- Orchestrator (router + planner) with delegation chains that resume the
  parent on completion
- Multi-instance connectors with OAuth (Gmail, Drive, Sheets, Docs, Notion,
  Airtable) and API-key (Notion, Airtable, Apify, Firecrawl, Tavily)
- MCP catalog — Streamable HTTP *and* stdio (local subprocess) servers, API-key auth; a growing catalogue (Stripe, n8n, Supabase, Airtable, Notion…) with a "test pending" badge on entries not yet verified live, plus add *and edit* your own custom HTTP/stdio servers from the dashboard
- Top-level workspaces — multiple isolated entities (agents/skills/connectors/jobs/memory per workspace), switch in the sidebar
- In-app ROOT chat — talk to your workspace ROOT right in the dashboard: conversation-first (pure chat never creates a job — recall is free, the agent's memory is auto-loaded), multiple conversations with searchable history, and inline "dispatched to N agents" cards when it escalates a real action into a tracked job
- ROOT agent — your first orchestrator automatically becomes the workspace ROOT (the single top-level agent; later orchestrators slot under it). It can create *and update* skills, create agents and assign them, and create MCP servers + API connectors — each gated by per-grant toggles + an autonomy/approval level (powers start off, opt in per grant). Provisioning verifies before it writes (an MCP server is connected and its tools listed first); skill authoring is grounded in the workspace's real tools (a linter rejects skills referencing tools the agent doesn't have)
- Office file editing — Excel in-place edit, Word/PowerPoint create, in the agent workspace (office-editing skill)
- Multiple filesystem folders per agent (sandboxed `file_*` tools)
- Telegram delivery (long-poll, group filters, multi-agent routing,
  delegation gracefulness) — exactly-once delivery contract: anti-spam guard
  against runaway message loops + a guard that re-prompts (then fails loud)
  rather than completing a job without ever replying
- Approval gates for risky tools (execute-the-approved-action on resume) — on a chat channel, the agent sends a heads-up before the job pauses so the user knows an approval is waiting
- Cron scheduling — trigger any automation out-of-band ("Run now") + opt-in Telegram confirmation when a scheduled job succeeds
- `nodal-agents update` — one-command upgrade + boot version notice
- Encryption at rest for LLM keys + MCP keys
- Embedded Postgres distribution via npm (no external DB to install)

### On the roadmap (genuine, not vaporware)

- **MCP OAuth flow** → unlocks Linear, Notion remote, GitHub remote,
  Atlassian, Sentry, and the rest of the SaaS-as-MCP ecosystem.
- **Dry-run mode + a test-workflow meta-tool** → preview what the ROOT would
  do before it runs, and let it validate an automation end-to-end.
- **pgvector binaries bundled in the npm pack** → semantic memory search
  active out-of-the-box. Today, installs without pgvector fall back to
  keyword search (which works, just less smart for cross-vocabulary
  recall).
- Data migration tools from the legacy Python stack.

---

## License

TBD.
