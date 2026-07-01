# Proposal: Office suite hardening + missing base tools (2026-07)

> Research + proposal only. No product code changed. Not committed.
> Author: research agent. Date: 2026-07-01.

This document has two parts:

1. **Office suite** — fix in-place editing of `.docx`/`.pptx` and replace the stale `exceljs`.
2. **Base tools** — the general-agent capabilities Nodal is missing versus Hermes, prioritized.

All file references are absolute paths into this repo, verified against the working tree.

---

## Repo facts this proposal is built on (verified)

Office libraries in use (`packages/tools/package.json`):

| Lib | Version | Role today | Verified in |
|-----|---------|------------|-------------|
| `exceljs` | `^4.4.0` | Excel read + **lossless in-place edit** | `packages/tools/src/builtin/office-ops/xlsx.ts` |
| `docx` | `^9.7.1` | Word **create-from-scratch**; "append" = read-as-text + full **rebuild** (formatting lost) | `packages/tools/src/builtin/office-ops/docx.ts` |
| `pptxgenjs` | `^4.0.1` | PowerPoint **create only** (no edit) | `packages/tools/src/builtin/office-ops/pptx.ts` |
| `mammoth` | `^1.12.0` | `.docx` → raw text (read) | `docx.ts`, `packages/adapters/google-drive/src/extractors/docx.ts` |
| `officeparser` | `^7.1.0` | `.pptx`/office → plain text (read) | `pptx.ts` |
| `pdf-parse` | external | `.pdf` → text (read), **Drive extractor only** | `packages/adapters/google-drive/src/extractors/pdf.ts` |

- The 12 office tools are gated behind the `office-editing` system skill via `requiredBuiltins` — not always-on. Registration: `packages/tools/src/builtin/index.ts` (lines 96-99). Skill: `packages/catalog/src/skills/office-editing.ts`.
- All office I/O goes through `readWorkspaceBinary`/`writeWorkspaceBinary` with a 25 MiB cap and atomic temp-rename: `packages/tools/src/builtin/office-ops/office-helpers.ts`.
- Build externals (the libs are NOT bundled into the pack, declared as runtime deps): `apps/runner/build.mjs` lines 61-67 (`pdf-parse`, `mammoth`, `exceljs`, `pptxgenjs`, `officeparser`).
- The skill's own honesty table already documents the gap (`office-editing.ts` lines 45-54): Excel = full edit; Word = append-only with formatting loss; PowerPoint = create-only.

The deprecation noise (`glob@7`, `inflight`) comes from `exceljs@4.4.0`'s dependency tree; `exceljs` has had no functional release since Oct 2023 and its maintainers declared it inactive (GitHub discussion #2987, "looking for maintainers").

---

# PART 1 — Office suite (creation + editing)

## 1.1 The two real gaps

| Gap | Severity | Today | Want |
|-----|----------|-------|------|
| **`.docx` in-place edit** | High | `docx_append_paragraphs` reads to plain text and rebuilds → **fonts, tables, images, headers/footers, styles all lost** | Edit an existing Word doc preserving everything else |
| **`.pptx` in-place edit** | High | `pptx_create` only; editing an existing deck is impossible (the skill tells the agent to "create a new presentation based on the content read") | Modify text/images in an existing deck, keep layout/theme |
| **`exceljs` staleness** | Medium | Works, but unmaintained + ships the deprecated `glob@7`/`inflight` chain (the npm warnings) | A maintained lib, ideally still lossless in-place |

Excel is actually the **best** of the three today (true lossless in-place edit via the read-mutate-write cycle in `xlsx.ts`). The headline problems are Word and PowerPoint edit fidelity. The exceljs swap is a maintenance/security concern, not a functional one — so it's lower priority and riskier (it's the one thing that currently works well).

## 1.2 Candidate libraries

### Word (`.docx`)

| Library | Edit-in-place? | License | Maintenance | Notes |
|---------|----------------|---------|-------------|-------|
| **`docx` `patchDocument()`** (already a dep, v9.7.1) | **Yes** — placeholder/region patching into the *original* file, preserves everything else | MIT | Active (9.x line, regular releases) | **We already ship this lib** and only use its create path. `patchDocument()` loads the original `.docx`, finds `{{placeholders}}` or paragraph anchors, and injects runs/images/tables/HTML while leaving the rest of the XML intact. Zero new dependency. |
| `docxtemplater` (core) | Yes (template merge: `{tags}`, loops, conditions) | **MIT core**, but **image/HTML/table/chart/xlsx modules are paid** (€500–9000/yr) | Very active, commercial backing | Powerful but the genuinely useful modules (image, HTML→docx) are behind a paywall. License-incompatible with "free OSS base tool." Avoid for base; fine if a user installs it as a community skill. |
| `docx-templates` | Yes (template merge, JS expressions, image insert free) | MIT | Moderate (last release ~7 mo ago) | Fully-free alternative to docxtemplater. Good fallback if `docx.patchDocument` proves too limited for a given shape. |
| `mammoth` (current, read) | n/a (read only) | — | — | Keep for reading. |

**Recommendation (Word): use `docx.patchDocument()` — no new dependency.** It directly closes the in-place-edit gap with the library already in the pack. Pattern: read original buffer → `patchDocument({ outputType:'nodebuffer', data: originalBuffer, patches:{…} })` → write back. Two new tools:
- `docx_patch` — replace named placeholder regions / anchored paragraphs (text, bold/italic, images, tables) in place.
- Keep `docx_create` and `docx_read`; **deprecate `docx_append_paragraphs`'s lossy rebuild** in favor of a patch-based append (anchor at end-of-body) so formatting survives.

### PowerPoint (`.pptx`)

| Library | Edit-in-place? | License | Maintenance | Notes |
|---------|----------------|---------|-------------|-------|
| **`pptx-automizer`** | **Yes** — loads existing decks as templates, modifies slides via callbacks (xmldom), merges decks; wraps `pptxgenjs` for new content | MIT | Active (v0.8.x, releases within 12 mo, ~17k wkly dl) | Best free in-place option. Caveat: it's **additive** — to "modify one element and leave the rest untouched" you include the other slides in the output set (template-copy model). Pairs naturally with our existing `pptxgenjs`. |
| `pptxgenjs` (current) | No (create only) | MIT | Active | Keep for create. `pptx-automizer` uses it under the hood, so they coexist. |
| Aspose.Slides | Yes (full fidelity) | **Commercial** | Active | Best fidelity but paid + .NET bridge. Not a base-tool fit; possible enterprise add-on. |
| `officeparser` (current, read) | n/a | — | — | Keep for text read. |

**Recommendation (PowerPoint): add `pptx-automizer` (MIT, ~0.8.x).** New tools:
- `pptx_edit_text` — replace text on named slides in an existing deck (template-copy model).
- `pptx_add_slide_from_template` / `pptx_merge` — append/merge slides from another deck.
- Keep `pptx_create` (greenfield) and `pptx_read`. Document the additive/template-copy limitation in the skill (same honesty pattern already used in `office-editing.ts`).

### Excel (`.xlsx`)

| Library | In-place edit + styles? | npm registry? | License | Maintenance | Notes |
|---------|--------------------------|---------------|---------|-------------|-------|
| `exceljs` (current) | Yes (what we use) | Yes | MIT | **Inactive** since 2023; ships `glob@7`+`inflight` (the deprecation warnings) | Functional but stale + noisy. |
| **`xlsx-kit`** | Yes (openpyxl-inspired, read/modify/write) | **Yes** | **MIT** (no paid tier) | New, active, TS-first | Most promising maintained npm replacement. **Risk: young project — needs a fidelity spike before trusting it with formulae/charts/styles round-trips.** |
| SheetJS (`xlsx`) | Yes | **NO — left npm registry** (legal dispute w/ npm; CDN-only since v0.18.6) | Apache-2.0 | Active | **Disqualified as a published-package dep**: a `pnpm`-installed npm dep that isn't on the registry is a packaging hazard for a published npm CLI like Nodal. Don't. |
| `xlsx-populate` | Yes (focus on keeping styles intact) | Yes | MIT | Original **stale** (v1.21, 6 yr); only forks (`@eyeseetea/xlsx-populate`) are semi-active | Forks are a maintenance bet on a single contributor. Lower confidence than `xlsx-kit`. |
| `xlsx-js-style` | Partial (SheetJS fork + styles) | Yes | Apache-2.0 | Moderate | Style support bolted onto a SheetJS fork; in-place edit weaker than exceljs. |

**Recommendation (Excel): keep `exceljs` for now; the swap is the *lowest* priority.** Reasons:
1. The current Excel path is the one office feature that *works losslessly* — don't destabilize it for a cosmetic npm-warning fix.
2. SheetJS (the obvious "big" replacement) is **off the npm registry** and therefore unsuitable for a published package.
3. `xlsx-kit` is the right *eventual* target (MIT, on-registry, maintained, openpyxl-style) but is young; commit only after a fidelity spike.
4. The npm deprecation warnings (`glob@7`, `inflight`) are **transitive and non-exploitable** — they're noise, not a CVE. They can also be quieted with a `pnpm.overrides` for `glob`/`inflight` as an interim (verify exceljs still loads).

## 1.3 Recommended path (Part 1)

| # | Action | Library | New dep? | Effort | Priority |
|---|--------|---------|----------|--------|----------|
| **P1-A** | `docx_patch` (in-place Word edit) + replace lossy append with patch-based append | `docx.patchDocument()` (existing) | **No** | ~0.5–1 day | **Highest** — closes the worst gap with zero dependency risk |
| **P1-B** | `pptx_edit_text` + `pptx_merge`/add-slide (in-place PPT edit) | `pptx-automizer` | Yes (MIT) | ~1.5–2 days (incl. template-copy semantics + skill doc) | **High** |
| **P1-C** | Update `office-editing` skill capability table + add 25 MiB-aware fidelity notes for the new tools | — | No | ~0.5 day | Ships with P1-A/B |
| **P1-D** | Interim: `pnpm.overrides` to silence `glob@7`/`inflight` from exceljs; verify load | — | No | ~0.5 day | Medium |
| **P1-E** | Fidelity spike: round-trip a styled/formula/chart workbook through `xlsx-kit`; decide migration | `xlsx-kit` (evaluate) | Eventually | ~2 days spike + ~2 days migrate if green | **Low / deferred** |

**Net:** the two high-value gaps (Word + PPT in-place edit) are ~3–4 days and only add **one** new MIT dependency (`pptx-automizer`); the Word fix adds **none**. The exceljs replacement is explicitly deferred behind a spike because the safe candidate (SheetJS) is unusable on-registry and the on-registry candidate (`xlsx-kit`) is unproven.

### Effort detail / integration notes
- New tools reuse `readWorkspaceBinary`/`writeWorkspaceBinary` and the discriminated-union `{ok:true|false}` contract (`office-helpers.ts`) — no new I/O surface.
- Add each new tool name to `OFFICE_TOOLS` (`office-ops/index.ts`) and to `office-editing.ts` `requiredBuiltins` so gating is automatic.
- Add `pptx-automizer` to `apps/runner/build.mjs` EXTERNALS (it's a runtime dep, mirror the existing office libs).
- Tests: assert the *resulting bytes* preserve a known style/region (open the output with `officeparser`/`mammoth` and assert the untouched content is still present) — consistent with invariant #5 (assert real results, not call counts).

---

# PART 2 — Other "base" tools Hermes ships that Nodal lacks

## 2.1 Side-by-side: base capability matrix

Hermes core tools verified in `D:\APPS\KwintAgents\competitors\hermes-agent-main\toolsets.py` (`TOOLSETS`, lines 68+) and `gateway/platforms/`. Nodal state verified against `packages/tools/src/builtin/`, `packages/tools/src/communication/`, `packages/catalog/src/index.ts`, `packages/shared/{connector,mcp}-catalog.ts`.

| Capability | Hermes (built-in) | Nodal today | Gap |
|------------|-------------------|-------------|-----|
| Web search | `web_search` (built-in) | `web_search` **builtin is a placeholder that throws** (`web-search.ts`); real search only via opt-in Tavily/Firecrawl/Apify **connectors** | **Yes — no working default** |
| Web fetch/extract/scrape | `web_extract` (built-in) | Via Tavily/Firecrawl connectors or `mcp-fetch`/`mcp-playwright` MCP; **no builtin** | **Yes — not default** |
| Shell / command exec | `terminal` (6 backends) + `process` | `run_command` (gated by `command-execution` skill, approval-gated) | Partial — exists, single backend, no `process` mgmt |
| Code execution (run scripts that call tools) | `execute_code` (Python RPC to tools) | `run_skill_script` (runs a skill's bundled script) + `run_command` | Partial — no generic "call tools from code" surface |
| File ops | read/write/patch/search | `file_read/write/edit/list/search` (`file-ops/`) | **Covered** |
| Office docs | via `terminal`/skills | xlsx/docx/pptx builtins (see Part 1) | **Nodal ahead** here |
| Vision (analyze images) | `vision_analyze` | Per-model vision (incoming images → multimodal msg); no explicit analyze tool | Covered implicitly |
| **Image generation** | `image_generate` (DALL-E/Flux) | **None built-in** (only `send_image` *delivery*; generation via ComfyUI community skill) | **Yes** |
| **Text-to-speech / audio** | `text_to_speech` (Edge/ElevenLabs/OpenAI/xAI) | `send_audio`/`send_voice` *deliver* audio; no TTS generation | **Yes** |
| **Browser automation** | 11 `browser_*` tools (built-in) | Only via `mcp-playwright` MCP (opt-in) | **Yes — not default** |
| Memory (persistent) | `memory` | `save_memory`/`query_memory` + 2-stage architecture | **Covered (Nodal strong)** |
| Session/episodic recall | `session_search` | `search_history` (FTS over past jobs) | **Covered** |
| Task planning | `todo` | `task-planning` skill + task board | Covered (skill, not tool) |
| **Clarifying questions** | `clarify` (structured multiple-choice) | None (free-text only) | Minor gap |
| Delegation/subagents | `delegate_task` | Full orchestrator + `run_task` delegation | **Covered (Nodal strong)** |
| Scheduling/cron | `cronjob` tool | Schedules/automations + `list_schedules`/`run_schedule` | **Covered** |
| Messaging (outbound) | `send_message` (Telegram/Discord/Slack/SMS/…) | `telegram_send_message` + send image/file/media — **Telegram only** | **Yes — single channel** |
| **Multi-channel chat (inbound)** | 18 gateway platforms (Discord, Slack, WhatsApp, Signal, Matrix, Email, SMS, WeChat, Feishu, …) | Telegram only (`gateway/platforms` has none of these) | **Yes — biggest platform gap** |
| Email (as a channel + tool) | IMAP/SMTP gateway + `agentmail` skill | Gmail **connector** (adapter) only | Partial |
| Calendar | (via skills) | Google Calendar **connector** | Covered (connector) |
| Smart home | `ha_*` (4 tools) + HA gateway | None (niche) | Low priority |
| Skills mgmt | `skills_list/skill_view/skill_manage` | `skill_view` + community install + meta-tools | **Covered** |

## 2.2 Prioritized list of what Nodal should add

Priority weighs: (a) how core it is to a *general* agent, (b) how often its absence blocks real tasks, (c) fit with Nodal invariants (DB-driven, no band-aids, fail-loud).

### P0 — Working default web search + fetch
- **What:** A real `web_search` builtin (today it throws — `web-search.ts` line 33) and a `web_fetch`/`web_extract` builtin (URL → clean markdown/text).
- **Why:** This is *the* table-stakes agent capability. Right now an agent with no Tavily/Firecrawl key literally cannot search the web — the placeholder throws `WebSearchNotConfiguredError`. Hermes ships it on by default. The memory note "I can't search web, add a Tavily key" discoverability layer is a workaround for a missing default.
- **How (Nodal architecture):** Make `web_search`/`web_fetch` always-on builtins that resolve a backend at runtime in priority order: (1) a configured Tavily/Firecrawl/Apify connector for the entity (reuse `packages/adapters/tavily`/`firecrawl` operations), else (2) an env-configured generic endpoint (`NODALAI_WEB_SEARCH_URL` already scaffolded), else (3) fail loud with the existing discoverability message. Builtin, not MCP — it's core and we already have the adapters. Keep `mcp-fetch`/`mcp-playwright` for power users.
- **Effort:** ~1.5–2 days (wire builtin → existing adapter operations + fallback chain). **Priority: P0.**

### P1 — Multi-channel messaging (Discord first)
- **What:** Outbound `send_message` beyond Telegram, plus inbound gateway adapters. Discord first, then Slack.
- **Why:** Single biggest platform gap vs Hermes (18 platforms vs 1). Already the agreed "next big project" in project memory (`project_skill_presentation_reliability_lot`, `project_multichannel_chat_backlog`). The communication tools (`packages/tools/src/communication/`) and `gateway`-equivalent paths are ~80% Telegram-hardcoded.
- **How:** `ChannelAdapter` abstraction + `channel_bindings` table (per the existing backlog). Outbound tools become channel-generic; inbound runner routes by binding. **Adapter pattern**, DB-driven (invariant #1/#6).
- **Effort:** Large (multi-week, phased). **Priority: P1** (already on the roadmap).

### P1 — Image generation (built-in, multi-provider)
- **What:** `image_generate` builtin: prompt → image file in workspace (then deliver via existing `send_image`).
- **Why:** Hermes ships it; Nodal only has delivery + a ComfyUI *community skill* (env-specific, brittle per the memory notes). The media-generation backlog already frames this as a product pillar.
- **How:** Multi-provider via the AI SDK (native Google/OpenAI image, plus OpenRouter/fal/replicate aggregators) — mirrors the model-catalog pattern in `packages/shared/model-catalog.ts`. **Builtin** gated behind an `image-generation` capability skill, key resolved from entity connectors. Async submit→suspend→resume for slow providers (the runner already has approval-suspend plumbing).
- **Effort:** ~3–5 days for v1 (one or two providers). **Priority: P1.**

### P2 — Browser automation as a default capability
- **What:** Promote browser control from "opt-in `mcp-playwright`" to a first-class gated capability with a clean tool surface (navigate/click/type/screenshot/extract).
- **Why:** Hermes has 11 `browser_*` tools built in; many real tasks (logged-in scraping, form filling, "agent browser") need it. Nodal can already do it via the Playwright MCP, so the gap is *defaultness/ergonomics*, not raw capability.
- **How:** Lightest path = keep Playwright MCP but ship an `agent-browser` **system skill** that documents/auto-attaches it (discoverability). Heavier path = a `browser_*` builtin set wrapping Playwright in-process. Recommend the skill-first path; revisit builtin if usage is high.
- **Effort:** ~1 day (skill + catalog wiring) for the light path. **Priority: P2.**

### P2 — Text-to-speech generation
- **What:** `text_to_speech` builtin: text → audio file (then `send_voice`/`send_audio`).
- **Why:** Hermes ships it; Nodal can only *deliver* pre-existing audio. Completes the voice loop (incoming voice transcription already exists per memory).
- **How:** Builtin gated behind a `tts` capability skill; provider via AI SDK / ElevenLabs / OpenAI / Edge-TTS (free default). Key from connector/env.
- **Effort:** ~1–2 days. **Priority: P2.**

### P3 — `clarify` structured question tool
- **What:** A `clarify` tool that asks the user a multiple-choice/open question and suspends for the answer.
- **Why:** Hermes has it; improves UX for ambiguous tasks. Nodal already has suspend/resume (approvals) plumbing to build on.
- **How:** Builtin reusing the approval-suspend mechanism; render choices in the dashboard + channel card (like the approval card).
- **Effort:** ~1–2 days. **Priority: P3.**

### P3 — `process` management for run_command
- **What:** List/kill/monitor background processes spawned by `run_command`.
- **Why:** Hermes pairs `terminal` with `process`; long-running commands (dev servers) currently can't be managed.
- **How:** Extend `run-command.ts` with a process registry + a `process` builtin under the same `command-execution` gate.
- **Effort:** ~1–2 days. **Priority: P3.**

### Explicitly NOT recommended as base
- **Smart home (`ha_*`)**, **RL training (`rl_*`)**, **blockchain / MLOps / bioinformatics skills** — Hermes ships these but they're niche/research-lab-specific (Nous is an AI-research org). They belong in the **community skill catalog** (install-from-GitHub), not the base. Nodal's `packages/shared/community-skill-catalog.ts` is exactly the right home; several (Blender, Whisper, ComfyUI, OSINT) are already listed there.

## 2.3 Priority summary

| Priority | Capability | Type | Effort | On existing roadmap? |
|----------|-----------|------|--------|----------------------|
| **P0** | Real web search + web fetch builtin | Builtin (wraps existing adapters) | ~2 days | Implied (placeholder TODO) |
| **P1** | Multi-channel messaging (Discord→Slack) | Adapter + DB | Multi-week | **Yes** (agreed next big project) |
| **P1** | Image generation builtin | Builtin (multi-provider) | ~3–5 days | **Yes** (media backlog) |
| **P2** | Browser automation as default | Skill wrapping Playwright MCP | ~1 day | Partially |
| **P2** | Text-to-speech generation | Builtin | ~1–2 days | No |
| **P3** | `clarify` structured questions | Builtin (suspend/resume) | ~1–2 days | No |
| **P3** | `process` management | Builtin (extends run_command) | ~1–2 days | No |

**The single highest-leverage fix in this whole document is P0 (web search):** it's the one place where a default Nodal agent is *strictly less capable than advertised* — the builtin exists by name but throws. Everything else is additive; that one is a hole in the floor.

---

## Appendix — files verified

- `packages/tools/package.json` — office deps + versions
- `packages/tools/src/builtin/office-ops/{xlsx,docx,pptx,office-helpers,index}.ts` — current office tool impls
- `packages/catalog/src/skills/office-editing.ts` — gating skill + honesty table
- `packages/tools/src/builtin/index.ts` — registration, `ALWAYS_ON_TOOLS`
- `packages/tools/src/builtin/web-search.ts` — placeholder that throws
- `packages/tools/src/communication/{index,send-image,send-media}.ts` — Telegram-only delivery
- `packages/tools/src/builtin/{search-history,run-command,run-skill-script}.ts` — recall + exec surface
- `packages/shared/{connector-catalog,mcp-catalog,community-skill-catalog}.ts` — connector/MCP/community catalogs
- `apps/runner/build.mjs` — externalized runtime deps
- `packages/adapters/{tavily,firecrawl,apify,gmail,google-calendar,…}/` — opt-in connectors
- Hermes: `D:\APPS\KwintAgents\competitors\hermes-agent-main\toolsets.py` (`TOOLSETS`), `gateway/platforms/*`, `optional-skills/*`, `mcp_serve.py`, `agent/image_gen_registry.py`

### External sources (library research)
- ExcelJS inactivity / maintainers wanted — github.com/exceljs/exceljs/discussions/2987
- SheetJS left npm registry (legal dispute, CDN-only) — github.com/SheetJS/sheetjs/issues/2667; bleepingcomputer.com coverage
- `xlsx-kit` (MIT, openpyxl-inspired) — github.com/baseballyama/xlsx-kit
- `docx.patchDocument()` in-place patching — github.com/dolanmiu/docx (v9.x), docx.js.org
- docxtemplater paid modules (image/HTML/xlsx) — docxtemplater.com/pricing
- `docx-templates` (MIT, free image insert) — npmjs.com/package/docx-templates
- `pptx-automizer` (MIT, edit/merge existing pptx, wraps pptxgenjs) — github.com/singerla/pptx-automizer
