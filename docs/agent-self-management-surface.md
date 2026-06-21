# Agent self-management surface — matrix

The set of things the ROOT/orchestrator agent can do to the platform's own objects,
at runtime, via meta-tools / builtins. Kept as the source of truth so we complete a
**bounded, symmetric** surface instead of patching micro-gaps reactively.

> **Update this table at the end of every session** where the surface changes.
> Last updated: 2026-06-19.

## The matrix (agent-callable)

Legend: ✅ exists · 🔴 GAP (runtime needs it, no agent writer) · 🔒 UI-only by design (security/secret/owner) · — n/a · 🟡 decision pending

| Object | create | update | attach | detach | delete |
|---|---|---|---|---|---|
| **agent** | ✅ create_agent | ✅ update_agent | ✅ attach_agent | ✅ detach_agent | 🔒 UI |
| **skill** | ✅ create_skill | ✅ update_skill | ✅ attach_skill | ✅ detach_skill | 🔒 UI |
| **mcp-server** | ✅ create_mcp | 🟡 (UI for now) | ✅ attach_mcp *(+ attachToAgentSlug)* | ✅ detach_mcp | 🔒 UI |
| **connector** | ✅ create_connector | 🟡 (UI for now) | ✅ attach_connector *(+ attachToAgentSlug)* | ✅ detach_connector | 🔒 UI |
| **memory** | ✅ save_memory | ✅ mark_helpful / mark_outdated | — | ✅ archive (mark_outdated) | 🔒 UI |
| **schedule / cron** | ✅ create_schedule | ✅ update_schedule | — | — | 🔒 UI *(agent pauses via toggle_schedule)* |
| ↳ *also* | ✅ list_schedules *(read)* | ✅ run_schedule *(fire now)* | | | |
| **workspace** | 🔒 UI (fs path) | — | 🔒 UI | 🔒 UI | 🔒 UI |
| **llm-key** | 🔒 UI (secret) | 🔒 UI | — | — | 🔒 UI |
| **approval-rule / root-grants / LAN-yolo** | 🔒 UI (security) | 🔒 | — | — | 🔒 |
| **model selection (read)** | ✅ list_models (read) | — | — | — | — |

Other always-on builtins: `skill_view` (read a skill on demand), `return_result`, `save/query_memory`, `file_*`, `dashboard_publish`.

Grant mapping note: a grant may enable a SET of tools. The **attach** grants
(`attachAgent`/`assignSkill`/`attachMcp`/`attachConnector`) each also enable their
`detach_*` mirror; `manageSchedules` enables the full cron CRUD. Keeps the grant
surface bounded (one toggle per logical capability, not per tool).

## Read-but-no-writer (config only via UI today — likely intentional)
- `agent_skill_assignments.scripts_authorized` — owner security gate for `run_skill_script`.
- `agents.fallback_chain`, `agents.memory_token_budget` — advanced per-agent config.
- `agent_workspaces` — filesystem root (path = user decision).

## The invariant that prevents this class of bug
**Every `create_X` whose capability the runner exposes via a link table MUST write the link
(or be paired with an `attach_X`).** create_mcp/create_connector violated this (registered but
unusable) → fixed via attach_mcp/attach_connector + `attachToAgentSlug`. *(TODO: encode as an
arch test so it can't regress.)*

## Decided
- **Delete is always a USER action (UI-only).** No agent `delete_*` for any object, including
  schedules. The agent pauses a schedule with `toggle_schedule`; the user deletes in the dashboard.
  (Decision: Quentin, 2026-06-19.)

## Pending decisions (agent-tool vs UI-only — Quentin to decide)
1. **update_mcp / update_connector** — agent self-repair (rename / rotate key / reconfigure) vs UI-only.

## Cron correctness — fully function-backed (2026-06-20)
Two layers, the second is the real fix:
1. Schedules carry an explicit IANA `timezone` (migration 0047; default = server's resolved zone =
   the user's). Tool + runner ticker evaluate the cron in that zone (cron-parser `tz`).
2. **`atTimes: ["09:00","13:00","21:00"]`** (+ optional `days`) on create/update_schedule — the agent
   passes wall-clock times and the TOOL builds the cron, so the agent never writes cron fields or
   converts timezones. `cronExpr` remains an advanced escape hatch (every-15-min, monthly). This was
   built after the prompt-layer ("don't convert to UTC") repeatedly failed — the LLM kept converting
   out of habit and even narrated a fake conversion. atTimes removes the failure mode entirely.

## Change log
- **2026-06-20 (8)** — **System timezone setting (the real fix).** `entities.timezone` (migration 0048), captured from the browser at onboarding + editable in Settings → Timezone. It is AUTHORITATIVE: the agent's Runtime block now states the current local time + zone, and schedule tools read the workspace zone — the agent can no longer set or convert timezones. Removed `cronExpr`/`timezone` from create/update_schedule's agent input; timing is now `atTimes` (clock times) or `everyMinutes` (interval) + `days`, the tool builds the cron in the workspace zone. Works for any user, including cloud-hosted (server zone ≠ user zone).
- **2026-06-20 (7)** — **`atTimes` deterministic scheduling.** create/update_schedule take `atTimes: ["HH:MM",…]` + `days` ("daily"/"weekdays"/"weekends"/[0-6]); the tool builds the cron in the user's tz. Agent never writes cron hours/tz → kills the recurring UTC-conversion bug at the source. cronExpr kept as advanced escape hatch. Skill rewritten around atTimes.
- **2026-06-20 (6)** — **`list_schedules`** (always-on read — the agent can now answer "what are my automations?", which it previously admitted it couldn't) + **`run_schedule`** (fire a schedule's task now, on demand — inserts a pending cron job picked up by the recovery reaper, gated under `manageSchedules`).
- **2026-06-20 (5)** — **Timezone-aware schedules (function fix).** `agent_schedules.timezone` column (migration 0047); `create_schedule`/`update_schedule` accept an optional `timezone` (default = server's resolved zone) and compute nextRun in it; runner ticker evaluates the cron in the schedule's zone. Removes the agent's UTC-conversion ambiguity + makes schedules portable across host timezones.
- **2026-06-19 (4)** — Cron skill hardening (no surface change): `create_schedule`/`update_schedule` point to `skill_view('tool-schedules')`; skill teaches **local-time, no UTC conversion** and **multiple times in ONE cron** (`0 9,13,21 * * *`) — minimise schedules (one per agent, fold its times into one expression), don't create one per time.
- **2026-06-19 (3)** — **Teardown + crons.** `detach_agent` / `detach_skill` / `detach_mcp` / `detach_connector` (folded under the attach grants). Cron tools: `create_schedule` / `update_schedule` / `toggle_schedule` (new grant `manageSchedules`, opt-in; cron validated via cron-parser). Skill `tool-schedules`. **No `delete_schedule`** — delete is a user/UI action (Quentin's rule).
- **2026-06-19 (2)** — Closed the two link gaps: **`attach_mcp` + `attach_connector`** (+ `attachToAgentSlug` on create_mcp/create_connector), grants `attachMcp`/`attachConnector` (inherit createMcp/createConnector). create_agent now assigns the entity's active llm key (no more `llmKeyId: null`).
- **2026-06-19 (1)** — Added `list_models` + model validation (create/update_agent); `update_agent`; `skill_view`; per-tool skills (tool-create-mcp/agent, tool-update-agent).
