# Audit Total : NodalAI vs Hermes Agent

> **Date** : 2026-05-13
> **Périmètre** : analyse exhaustive et brique-par-brique de Hermes Agent (`D:\APPS\hermes-agent-main`, v0.13.0) vs NodalAI (`D:\APPS\NodalAI`, v0.0.0).
> **Auteur** : audit automatisé Claude — lecture du code source des deux plateformes, des README, AGENTS.md, CLAUDE.md, release notes (Hermes v0.2 → v0.13) et ADRs (NodalAI ADR-0001).

---

## 0. Synthèse exécutive (TL;DR)

| Dimension | Hermes Agent | NodalAI |
|---|---|---|
| **Maturité** | v0.13 — 864 commits / 588 PRs entre v0.12 et v0.13, **1 058 fichiers de tests**, 295 contributeurs, `run_agent.py` ~15 700 LOC, `cli.py` ~13 564 LOC | v0.0.0 — migration en cours depuis legacy KwintAgents, **166 fichiers de tests** (sur ~460 fichiers TS), `npx nodalai` "**Not yet shipped**" mais binaire fonctionne (cf `nodalai-up.log`) — ratio test:test ~6.4:1 en faveur Hermes |
| **Stack** | Python 3.11+, asyncio/sync, monolithe extensible | Node 20+ TypeScript strict, pnpm monorepo, Turborepo |
| **Surface UX** | TUI (Ink/React) + CLI (Rich/prompt_toolkit) + Dashboard (FastAPI + xterm.js) + ACP (Zed/VS Code/JetBrains) | CLI (commander) + Web Dashboard (Next.js 16 + React 19) |
| **Modèles LLM** | **28 fournisseurs plugin** (ai-gateway, alibaba, alibaba-coding-plan, anthropic, arcee, azure-foundry, bedrock, copilot, copilot-acp, custom, deepseek, gemini, gmi, huggingface, kilocode, kimi-coding, minimax, nous, nvidia, ollama-cloud, openai-codex, opencode-zen, openrouter, qwen-oauth, stepfun, xai, xiaomi, zai) + aliases (or, vllm, llamacpp, lmstudio, ollama) ; auth multi : api_key/oauth_device_code/oauth_external/copilot/aws_sdk ; `agent/transports/` (chat_completions, anthropic, bedrock, codex) | 8 fournisseurs (Anthropic, OpenAI, Google, Mistral, Groq, Ollama, OpenRouter, OpenAI-compatible) — pas de Bedrock, Codex, xAI, DeepSeek, Moonshot |
| **Plateformes de messagerie** | **24 plateformes** : 20 built-in (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, Email, SMS, Home Assistant, DingTalk, WeCom, WeiXin, Feishu, QQ Bot, BlueBubbles, Yuanbao, Webhook, API server, msgraph_webhook) + 4 plugin-platforms (google_chat, irc, line, teams) ; `BasePlatformAdapter` ABC ; `_keep_typing` per-platform pour les time-windows (LINE 60s, WhatsApp 24h) | **1 fonctionnel : Telegram** (long-poll prod-grade, token redaction, structured errors). `sendEmail` est un **stub qui throw `delivery_email_not_configured`**. Slack/Discord/WhatsApp existent UNIQUEMENT comme enum values dans `JOB_CHANNELS` — zéro implémentation |
| **Backends terminal** | 7 (local, docker, ssh, modal, daytona, singularity, vercel-sandbox) | 0 (exécution in-process Node) |
| **Outils intégrés** | 74+ fichiers `tools/*.py`, 30+ toolsets (browser, code_execution, file, image_gen, kanban, memory, search, terminal, todo, tts, video, vision, web, mcp…) | 5 always-on (return_result, save_memory, query_memory, **web_search = stub `WebSearchNotConfiguredError`**, dashboard_publish) + 9 adapters externes — pas de file I/O, pas d'HTTP fetch, pas de code-exec, pas de calendar |
| **Connecteurs SaaS** | Via skills/plugins + MCP — illimité, ~111 skills + 163 optional-skills | 9 adapters first-class (Notion **17 outils**, Airtable, Gmail, Drive 39 fichiers source, Sheets, Docs, Firecrawl, Apify, Tavily) — OAuth + PAT supportés |
| **Memory providers** | 8 plugins (honcho, mem0, supermemory, byterover, hindsight, holographic, openviking, retaindb) | 1 built-in (Postgres + pgvector) |
| **Skills** | Système procédural : auto-création, auto-amélioration, curator, archivage, marketplace agentskills.io | DB-driven (table `agent_skills` + versioning) — métadonnées + contenu, pas d'auto-curation |
| **Cron / Routines** | Croniter + scripts pré-run, no_agent mode, catchup, 3-min hard interrupt | setInterval 120s tick + schedules table — basique |
| **Multi-agents** | Kanban durable (heartbeat, reclaim, zombie detection, retry caps, hallucination gate) + delegation tool (1 niveau, batch) | Router + Planner mode, delegation depth ≤3, anti-loop guards (5 chains, 50 tool calls/turn) |
| **MCP** | **Client + Server bidirectionnel** : (1) `tools/mcp_tool.py` connecte serveurs externes via stdio/HTTP/SSE avec reconnect exponential backoff + sampling support (les serveurs MCP peuvent demander des completions LLM via Hermes) ; (2) `mcp_serve.py` expose Hermes-as-MCP-server avec 10 tools (conversations_list, conversation_get, messages_read, attachments_fetch, events_poll/wait, messages_send, permissions_list_open/respond, channels_list) via `FastMCP` ; OAuth forwarding ; image MEDIA ; optional `[mcp]` extra | **Schema-only confirmé** : tables `mcp_servers` + `agent_mcp_servers` + `mcp_connections` avec contraintes complètes, mais **0 ligne de code runtime** outside tests — la plateforme NE PEUT PAS consommer un serveur MCP |
| **RL / Training** | Atropos, tinker, trajectory compression, batch_runner — niche mais shippé | ❌ |
| **i18n** | **16 locales** : en (baseline), af, de, es, fr, ga, hu, it, ja, ko, pt, ru, tr, uk, zh, zh-hant ; `agent/i18n.py` t() ; portée explicitement limitée aux messages user-facing statiques (pas les outputs LLM, ni tracebacks) ; **test catalog parity CI-enforced** | ❌ |
| **Profiles** | Multi-instance natif (`hermes -p name`) avec `HERMES_HOME` séparé | 1 instance / 1 entity (multi-tenant intra-DB possible) |
| **Sécurité** | Sandbox path, command approval, DM pairing, redaction par défaut, TOCTOU closures, scope allowlists, MCP OAuth | AES-256-GCM filesystem secrets + Drizzle param queries + better-auth opt-in |

**Verdict synthétique** : Hermes est une plateforme produit mature avec ~2 ans d'itération, un écosystème massif (plugins, skills, modèles, plateformes) et un focus communautaire. NodalAI est une refonte architecturale propre et opinionnée mais ~5 % du périmètre fonctionnel actuel. **NodalAI ne perd pas la course — il ne l'a pas commencée sur le même terrain.** Le bon framing : Hermes est un *swiss-army-knife agent* pour power-users ; NodalAI peut devenir un *platform-as-a-product* pour SMB/équipes, à condition de choisir ses combats.

---

## 1. Tableau comparatif détaillé — brique par brique

### Légende
- 🟢 = NodalAI meilleur ou égal
- 🟡 = NodalAI proche / divergent par design
- 🔴 = NodalAI structurellement en retard
- ⚪️ = Hors-périmètre NodalAI par choix assumé

| # | Brique | Hermes Agent | NodalAI | Verdict | Piste d'amélioration NodalAI |
|---|---|---|---|---|---|
| 1 | **Onboarding / Install** | One-liner `curl ... \| bash` (Linux/macOS/WSL/Termux) + `irm \| iex` (Windows) ; installer télécharge uv, Python 3.11, Node, ripgrep, ffmpeg, MinGit portable ; setup wizard `hermes setup` ; doctor `hermes doctor` ; migration assistée depuis OpenClaw | `npx nodalai` (non encore shippé) avec `init`/`up`/`down`/`logs`/`reset` ; Postgres embarqué ; pas de wizard interactif détaillé observé | 🔴 | Shipper `npx nodalai` immédiatement ; ajouter `nodalai doctor` (vérif Node/Postgres/pgvector/ports/secrets.key) ; wizard `nodalai init` qui détecte Ollama/LM Studio/llama.cpp en local et sauvegarde le choix dans la DB |
| 2 | **CLI** | `hermes`, `hermes model`, `hermes tools`, `hermes gateway`, `hermes setup`, `hermes claw migrate`, `hermes doctor`, `hermes cron`, `hermes kanban`, `hermes curator`, `hermes skills`, `hermes profiles`, `hermes logs`, `hermes debug share`… — ~30 sous-commandes ; chaque commande slash centralisée dans `COMMAND_REGISTRY` partagé CLI↔gateway↔Telegram↔Slack | `nodalai up/down/init/logs/reset` — 5 commandes ; pas de slash-command registry partagé | 🔴 | Étendre la CLI : `nodalai agent {list,create,run,disable}`, `nodalai memory {list,clear}`, `nodalai cron {list,add,run}`, `nodalai logs --follow --service=runner`, `nodalai db {migrate,backup,restore}`. Ne PAS reproduire 30 commandes — choisir les 10 valeur-clés |
| 3 | **TUI** | TUI full Ink/React (`ui-tui/`) avec backend Python JSON-RPC (`tui_gateway/`), embedded dans le dashboard via xterm.js+PTY ; spinner kawaii animé ; skin engine 4 thèmes (default, ares, mono, slate) + skins YAML user | ❌ — uniquement dashboard web Next.js | 🟡 | Pas de TUI prioritaire pour SMB-target ; mais petit add-on `ink`/`tui` pour CLI interactive ROI très élevé (5 jours-homme). Sinon, optionnel. |
| 4 | **Dashboard Web** | FastAPI + SPA (xterm.js, WebGL, addon-fit, addon-unicode11) ; chat embarque le vrai TUI via PTY+WebSocket ; pages plugins, profiles, analytics, kanban, dashboard publish, OAuth ; reverse-proxy `X-Forwarded-Prefix` ; thème `default-large` | Next.js 16 + React 19 + Tailwind 4 ; pages : agents, jobs, automations, billing, connectors, credentials, logs, memories, settings, skills, stats, approvals ; Toaster Sonner ; ConfirmDialog custom (pas de `window.confirm` autorisé par ESLint) | 🟢 | **Avantage NodalAI** : Next.js 16/React 19 = stack moderne, SSR, Server Actions, type-safety end-to-end via Zod, modulaire. Hermes dashboard est puissant mais lourd (SPA + PTY) et orienté power-user. Capitaliser : design system propre, mode collaboratif multi-user, embedded chat-realtime via Hono SSE |
| 5 | **LLM management** | 29 fournisseurs en plugins (`plugins/model-providers/*`) : ai-gateway, alibaba, anthropic, arcee, azure-foundry, bedrock, copilot/copilot-acp, deepseek, gemini, gmi, huggingface, kilocode, kimi-coding, minimax, nous, nvidia, ollama-cloud, openai-codex, opencode-zen, openrouter, qwen-oauth, stepfun, xai, xiaomi, zai ; `ProviderProfile` ABC ; routing intelligent ; auxiliary client pour curator/vision/embed/title/session-search avec config par tâche ; account_usage tracker ; rate_limit_tracker ; OpenRouter cache control ; OAuth flows (Google Code Assist, Qwen…) | 8 providers (`packages/llm/src/providers/*.ts`) : anthropic, openai, ollama, openai-compatible, google, mistral, groq, openrouter ; CAPABILITY_MATRIX en single source ; Vercel AI SDK wrapper unifié ; `entity_llm_keys` table avec AES-256-GCM at rest ; key per agent (`agent.llmKeyId`) ; `migrateLlmKeysToEncrypted` bootstrap | 🔴 | Ajouter : Gemini natif (déjà fonctionnel sans abstraction), DeepSeek, Moonshot/Kimi, NVIDIA NIM, xAI Grok, Bedrock, Azure Foundry. **Plus important** : ajouter un `auxiliary` (background LLM par tâche : vision, embed, summarize, title-gen) car NodalAI mélange tout dans le runner ; ajouter un `account_usage` (rate-limit aware) et un router par capacité (cost-tier, latency-tier, quality-tier) configurable par agent. Compatibilité OpenRouter cache control. Voir aussi : 'BYOK' encryption-at-rest est OK chez NodalAI mais manque rotation & audit log. |
| 6 | **Runtime / Agent loop** | `AIAgent` (~12k LOC dans `run_agent.py`) avec ~60 paramètres ; loop synchrone + `iteration_budget` + interrupt + budget grace call + checkpoints v2 + auto-resume gateway ; messages OpenAI-format; reasoning preserved ; `/goal` (Ralph loop) ; auto-lint sur write_file/patch (Python, JSON, YAML, TOML) ; pre/post LLM hooks via plugins ; trajectory recorder | `executeJob` (`apps/runner/src/job/execute.ts`) basé Vercel AI SDK `generateText` ; `ChainCounters` (max 5 chains, 50 tool calls/turn, max 3 delegation depth — INVARIANT 8) ; checkpoint via `saveCheckpoint` ; awaiting_approval / awaiting_delegation / awaiting_tasks states ; tools whitelistés per-job par `computeToolWhitelist` | 🟡 | NodalAI est plus propre architecturalement (Vercel AI SDK fait le sale boulot), mais manque : (a) `/goal` (verrouillage objectif cross-turn), (b) post-write lint auto, (c) trajectory recording pour replay/debug, (d) plugin hooks `pre_llm_call`/`post_llm_call`/`transform_llm_output`. Bonus : implémenter un `agent` runner-side hook system minimal (sync/async, 4-5 hooks suffit) |
| 7 | **Agents (définitions, registry)** | Agent = singleton process avec ~60 init params ; personality via SOUL.md ; profiles isolent les configs ; pas de DB-first registry (config YAML) ; multi-agent via Kanban / delegate_task | DB-first : `agents` table (slug, personality, model, llmKeyId, role, orchestratorMode, telegramBotToken, requiresApproval[], capabilities[], systemAgent, maxTokensPerJob, taskContextTemplate, lastSeenChatIdTelegram) + `agent_assignments` (orchestrator→sub_agent) + `agent_budgets` (tokens/jour, tokens/mois, alertThreshold, autoPause) ; `agentRow.role` ∈ {agent, orchestrator, system} | 🟢 | **Avantage NodalAI** : modèle de données plus mûr et multi-tenant (entity_id partout). Hermes a un modèle plus monolithique single-user. NodalAI peut capitaliser : dashboard CRUD complet, marketplace d'agents publics (entity-shared), avatar/branding, agent templates (clone). |
| 8 | **Skills** | Repo `skills/` (~111 dirs) + `optional-skills/` (~163 dirs) ; SKILL.md avec frontmatter (name, description, version, author, platforms[], metadata.hermes.{tags, category, related_skills, config}) ; skills auto-créés par l'agent depuis l'expérience, auto-améliorés ; curator (`hermes curator`) avec auto-archivage, pin, restore, prune, backup, rollback ; usage telemetry ; Skills Hub (agentskills.io marketplace) ; OS-gating | DB-first : `agent_skills` (name, slug, content, defaultContent, contentOverridden, requiredConfig, operations, requiredBuiltins[]) + `skill_versions` (versioned history) + `skill_connectors` (skill ↔ connector mapping) + `agent_skill_assignments` (agent ↔ skill avec approvalOverrides, enabledOperations[], useCustomInstructions) ; injection full-content dans le system prompt (`buildSystemPrompt`) | 🟡 | Forces NodalAI : versioning, override custom, lien skill↔connector explicite, gestion fine des opérations. Manques : (a) auto-création / auto-amélioration agent-driven (la killer feature Hermes), (b) marketplace public, (c) usage stats per skill, (d) archivage/curator. Plan : implémenter Phase 1 : "skill draft" tool qui permet à l'agent de proposer un nouveau skill, validation user dans dashboard, version saved. Phase 2 : auto-amélioration via patch tool. Phase 3 : Skills Hub interne entity-shared, puis public. |
| 9 | **Tools / Toolsets** | 74 fichiers Python tools/*.py ; toolsets `TOOLSETS` dict (30+) : browser, clarify, code_execution, cronjob, debugging, delegation, discord, file, homeassistant, image_gen, kanban, memory, messaging, moa (mixture-of-agents), rl, safe, search, session_search, skills, spotify, terminal, todo, tts, video, vision, web, yuanbao… ; auto-discovery via `tools/registry.py` ; `discover_builtin_tools()` ; per-platform enable/disable ; tools/environments/ pour terminal backends ; lifecycle hooks pre/post tool | 5 always-on : return_result, save_memory, query_memory, web_search, dashboard_publish ; + 9 adapters externes (Notion, Airtable, Gmail, Drive, Sheets, Docs, Firecrawl, Apify, Tavily) via `ADAPTER_REGISTRY` ; tools whitelistés per-job ; pas de "filesystem" tools, pas de browser interne, pas d'image gen, pas de code execution, pas de TTS, pas de vision | 🔴 | Trou massif. Mais aussi : opportunité de scope clair. Priorités à shipper : (1) code execution sandboxé (Node VM + subprocess + Docker exec optionnel), (2) browser (Playwright reuse), (3) file ops (read/write/patch/grep dans workspace user — vital pour automations devops), (4) image gen via adapter Replicate/Stability/Fal, (5) MCP client pour brancher écosystème, (6) clarify tool pour UX agent-user. Ne PAS faire tout en interne — chaque tool comme **adapter externe pluggable**, pattern déjà en place. |
| 10 | **Connecteurs SaaS** | Via skills + plugins + MCP — illimité mais hétérogène ; pas de modèle "connector" first-class dans le core | 9 adapters first-class avec `ADAPTER_REGISTRY` + `connectors` table (api_key encrypté OR `credentialId` → `credentials.payload.accessToken`) + `agent_connector_assignments` avec `enabledOperations[]` whitelist ; OAuth via `/api/oauth/[provider]/{start,callback}` ; opérations exposées dans la dashboard (operations grid) | 🟢 | **Avantage NodalAI** : modèle plus clean. À capitaliser : (1) ajouter Slack, Discord, Linear, GitHub, Jira, HubSpot, Stripe, Shopify, Pipedrive, Calendly, Twilio, Posthog ; (2) standardiser OperationDescriptor + tests adapter ; (3) marketplace adapters (open un OSS path "build your own NodalAI adapter") |
| 11 | **MCP** | Client + server (`mcp_serve.py`), stdio + SSE transport, OAuth forwarding (`mcp_oauth_manager.py`), image results MEDIA tagging, keepalive, retries ; toolset `mcp` ; MCP optional skill bundle | Table `mcp_servers` dans DB (schema observé) — pas de client functional vu dans le code path runner | 🔴 | Implémenter un client MCP Hono-side (TypeScript `@modelcontextprotocol/sdk` existe) ; charger les serveurs MCP au démarrage agent ; mapper tools MCP → tool whitelist ; UI dashboard pour add/test/disable MCP servers. ROI très élevé : MCP est devenu le standard de facto. |
| 12 | **Orchestration / Multi-agent** | `delegate_task` tool (single ou batch parallèle), max_concurrent_children=3 (default), max_spawn_depth=2, role=leaf|orchestrator, subagent_auto_approve, child_timeout ; Kanban durable (SQLite) : heartbeat, reclaim, zombie, retry, hallucination gate, multi-projet, multi-tenant, dispatcher dans gateway ; MoA (mixture-of-agents) toolset | Router/Planner avec `detectOrchestratorMode` ; assign_<slug> tools générés depuis DB ; `handleDelegation` crée child job en DB + suspend parent (`awaiting_delegation`) avec `pending_delegation` jsonb ; `resumeDelegated` recolle le tool-result ; `agent_tasks` table pour planner mode + dépendances ; `filterToolCallsForDelegation` (only-one-per-turn) ; `buildDeferredToolResults` ; chain_count anti-loop | 🟡 | NodalAI a un modèle DB-first élégant : suspend/resume durable, dépendances de tasks, planner explicite. Hermes a une infra plus mûre côté production (Kanban heartbeat, zombie). Plans : (a) implémenter heartbeat + reclaim sur les jobs `processing` (zombie detection après 5 min sans tick), (b) parallel delegation (multiple children spawn en 1 turn), (c) hallucination gate sur les assign_* (vérifier que le slug existe avant de créer le child) — déjà partiellement fait, (d) `awaiting_approval` fully wired |
| 13 | **Memory** | 8 providers plug : honcho (dialectic user modeling), mem0, supermemory, byterover, hindsight, holographic, openviking, retaindb ; ABC `MemoryProvider` + **11 hooks** (init, prefetch, sync_turn, on_turn_start, on_session_end, on_session_switch, on_pre_compress, on_memory_write, on_delegation, shutdown) ; **MemoryManager orchestrateur** ; **frozen snapshot** auto-injecté dans system prompt (2 200+1 375 chars budget dur) ; **sanitation anti-injection** (11 regex + invisible Unicode) ; **fencing `<memory-context>`** + scrubber streaming ; FTS5 session search SQLite ; trajectory_compressor avec extraction pre-compress | Postgres + pgvector ; `memory` table avec embeddings, importance, last_accessed, archived, skill_tags[], category ; CRUD + search (cosine ≥0.5 + ILIKE fallback) + access_tracking + filter + list + stats ; scoped per-entity et optionally per-agent ; pagination ; **MAIS** : `query_memory` n'utilise PAS searchMemories (juste list+filter JS) ; `fact_hash`/`valid_from`/`valid_to`/`memory_layer` colonnes mortes ; aucune auto-injection ; aucune sanitation ; aucun hook lifecycle | 🟡 | **Verdict corrigé après audit deep `hermes-memory.md`** : NodalAI a une fondation DB rigoureuse mais **passive** — l'agent doit appeler `query_memory` manuellement chaque tour (il oubliera). Mémoire partagée entity-wide sans sanitation = **vecteur prompt injection persistant cross-agents**. Manques critiques : (a) **auto-injection** dans `buildSystemPrompt` (frozen snapshot pattern), (b) **budget tokens dur** sur l'injection, (c) **sanitation** anti-injection sur `save_memory`, (d) **dedup `fact_hash`** (gratuit, colonne+index existent), (e) **`query_memory` doit utiliser `searchMemories`** (premium dort), (f) **extraction post-job** auto (LLM auxiliaire Haiku), (g) **prefetch async**, (h) **colonnes temporelles actives**, (i) dialectic user modeling (Honcho-style — Phase 3). Cf `memory-roadmap.md` pour les 13 items tactiques avec dépendances et estimations. |
| 14 | **Delivery / Outputs** | 20 plateformes (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, Email, SMS, Home Assistant, DingTalk, WeCom, WeiXin, Feishu, QQ Bot, BlueBubbles, Yuanbao, Webhook, API server, Google Chat) ; allowed_channels/chats/rooms allowlists ; approval keyboards natives (Telegram/Discord/QQ) ; voice memo transcription ; cross-platform conversation continuity ; chunked upload ; quoted attachments ; `[[as_document]]` skill directive | 3 channels : telegram (send, getUpdates long-poll, getMe), email, log ; per-agent Telegram bot token ; `lastSeenChatIdTelegram` pour reply default ; pas de Slack/Discord/WhatsApp encore | 🔴 | Roadmap priorisé : (1) Slack bot (slack-bolt JS), (2) Discord bot (discord.js), (3) WhatsApp via Twilio Business API, (4) Webhook generic (inbound + outbound), (5) Email reception (IMAP/SES inbound), (6) Approval keyboards natifs Telegram (déjà 80% du code dans `approvalRules` + `approveRoute`). **Le reste (Matrix, Signal, DingTalk, WeChat, Feishu, QQ Bot, BlueBubbles, Home Assistant) est niche** — laisser à un plugin path tiers via le pattern `delivery channels` |
| 15 | **Cron / Scheduling** | `cron/scheduler.py` ; croniter ; formats : duration `30m`, every-phrase `every monday 9am`, 5-field cron, ISO timestamp one-shot ; per-job `skills`, `model/provider` overrides, `script` pre-run (stdout injecté ou seul si `no_agent=True`), `context_from` (chain output), `workdir` (AGENTS.md/CLAUDE.md scoping), multi-platform delivery ; 3-min hard interrupt, catchup window (half-period clamp 120s-2h), grace window 120s, file lock anti-double-tick ; cron deliveries en session isolée | `apps/runner/src/cron/{tick,ticker,execute-ready,run-schedules,unblock-ready,reset-orphans,deliver-results}.ts` ; ticker setInterval 120s ; `schedules` table ; pas de format human ("every monday 9am") observé ; pas de `script` pre-run ; pas de `no_agent` mode | 🟡 | Add : (a) human-friendly format parser ("every 2h", "tomorrow 9am"), (b) one-shot ISO, (c) script pre-run (Node child_process), (d) `no_agent` mode (juste script + delivery), (e) catchup window + grace window comme Hermes, (f) hard interrupt timer (Node Worker thread + AbortController), (g) UI builder cron-parser (déjà importé) avec preview "next 5 fires" |
| 16 | **Webhooks / API triggers** | `gateway/platforms/webhook.py` + `api_server.py` ; HMAC auth ; templated prompts (`{pull_request.number}` etc.) ; webhook subscribe CLI | `webhooks` table dans schema — vue mais pas explorée ; `/api/agent` endpoint reçoit jobs externes | 🔴 | Implémenter inbound webhook endpoint avec template rendering (mustache ou un sous-set safe), HMAC verification, retry/dead-letter, dashboard pour add/test/disable. **Combine bien** avec brique 14 (Slack/Discord/Linear/GitHub event triggers) |
| 17 | **Sécurité** | Command approval (allowlist patterns), DM pairing, container isolation, redaction par défaut, MCP OAuth, browser cloud-metadata SSRF floor, cron prompt-injection scan, debug share redaction, allowlists per-platform, TOCTOU closures `auth.json` ; release v0.13 : 8 P0 closures | AES-256-GCM master key dans `~/.nodalai/secrets.key` (mode 0600) + `enc:v1:` blob format ; better-auth opt-in pour dashboard ; bearer token LAN ; local-trust default ; WORKER_SECRET pour cross-process runner↔web ; Drizzle ORM (param queries, pas de SQL injection) ; ConfirmDialog custom (no `window.confirm`) | 🟡 | NodalAI a un fondamental crypto solide (AES-GCM, master key user-private). Manques : (a) **command approval** (workflows de validation user-in-the-loop) — partiellement présent avec `approvalRules` mais pas câblé en UX, (b) **secret redaction** dans logs et messages (regex sur tokens connus + LLM-based pour custom), (c) **path traversal** check sur les outils file (quand ils seront ajoutés), (d) **rate limiting** sur les endpoints inbound (`/api/webhook`, `/api/telegram`), (e) **audit log** (qui a fait quoi quand), (f) **2FA optionnel** sur dashboard better-auth |
| 18 | **Profiles / Multi-instance** | Natif : `hermes -p coder` avec `HERMES_HOME=~/.hermes/profiles/coder` ; token locks (gateway/scoped_lock) pour éviter 2 profils sur même bot ; profiles list view all-profiles ; OAuth tokens partagés cross-profiles (Nous OAuth) | Pas de profiles user-side ; **multi-tenancy intra-DB** via `entity_id` partout (entities table) — un seul process sert N entities | 🟡 | Designs orthogonaux. NodalAI peut viser le SMB/team avec un meilleur multi-tenant (vs Hermes power-user multi-profile). Implémenter : (a) entity switching dans dashboard, (b) RBAC user↔entity (roles : admin, member, viewer), (c) audit log per-entity, (d) invitation flow, (e) usage/budget per-entity ; pas de multi-profile filesystem nécessaire |
| 19 | **Observability** | `hermes_logging.py` agent.log/errors.log/gateway.log per-profile ; `hermes logs --follow --level --session` ; plugin `observability` (metrics/traces/logs) ; `hermes debug share` (upload package with redaction) ; account_usage tracker ; rate_limit_tracker | `console.warn` + `console.error` to stderr ; pas de logger structuré observé ; pas d'OTel ; `runs` table dans schema (peut-être traces ?) ; `logs` route dans dashboard | 🔴 | Add : (a) Pino ou Winston logger structuré JSON, (b) OpenTelemetry spans (LLM call, tool call, job, delegation) — vital pour debug multi-agent, (c) dashboard "Logs" page avec filtres real-time SSE, (d) cost tracking per-agent / per-entity / per-job (déjà partiellement via inputTokens/outputTokens — calculer $ via usage_pricing matrix), (e) "Insights" rapport hebdo généré par LLM auxiliaire, (f) `nodalai doctor` (run health checks : DB up, runner up, pgvector installed, ports free, key valid) |
| 20 | **Tests / Quality** | ~17 000 tests pytest dans 900 fichiers ; `scripts/run_tests.sh` hermetic (TZ=UTC, LANG=C.UTF-8, 4 xdist workers) ; pytest-asyncio, pytest-xdist, pytest-split ; ruff (PLW1514) ; ty type checker ; règle "no change-detector tests" | 688 fichiers `*.test.ts` ; Vitest unit + Playwright e2e + smoke ; dependency-cruiser architecture rules ; ESLint flat config ; Prettier ; "tests assert real results" non-négo ; gates par brique : unit + arch + regression + integration/smoke | 🟢 | **Avantage NodalAI** : architecture-as-code (dep-cruiser) + invariants CI-enforced est plus propre que Hermes ; les tests sont moins nombreux mais probablement de meilleur signal/bruit. Plan : (a) ajouter coverage thresholds par package (≥80%), (b) load tests sur le runner (k6 / autocannon), (c) regression tests pour chaque bug fixé ("test added 2026-MM-DD for bug #X"), (d) `pnpm test --since=main` (turbo affected) |
| 21 | **Plugins / Extensibilité** | `PluginManager` (CLI plugins) + memory-provider plugins + model-provider plugins + context-engine + image-gen + observability + dashboard + kanban-dashboard + context_engine + spotify + google_meet + disk-cleanup + achievements + teams_pipeline + platforms (third-party messaging adapters) ; hooks `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `on_session_start`, `on_session_end`, `transform_llm_output` ; entry points pip ; user dir `~/.hermes/plugins/` ; règle "plugins MUST NOT modify core files" | Adapter packages dans `packages/adapters/*` — pattern mais 9 adapters seulement ; pas de hooks system observé runtime-side | 🔴 | Designer un système d'extensions Node-side : (a) hook system minimal (4 hooks suffisent : `pre_tool`, `post_tool`, `pre_llm`, `post_llm`), (b) package convention `nodalai-plugin-*` avec manifest, (c) loader auto au démarrage runner via `node_modules/.nodalai-plugins/`, (d) marketplace dans dashboard avec install one-click. La séparation propre apps/packages déjà en place rend ce design naturel. |
| 22 | **Packaging / Distribution** | pyproject.toml exact-pinned (post Mini Shai-Hulud incident 2026-05-12) ; extras `[anthropic, voice, messaging, cron, mcp, slack, matrix, voice, tts-premium, web, rl, termux, all]` ; lazy install via `tools/lazy_deps.py` ; setup.py + nix flake + docker-compose + termux profile ; pypi `hermes-agent`, AUR, Homebrew | pnpm workspaces, Turborepo, deps versionées avec `^` (range) ; pas encore publié sur npm ; Drizzle migrations dans `packages/db/migrations/` (10 files) ; pas de Docker Compose officiel | 🟡 | Plan : (a) **publier sur npm immédiatement** (`@nodalai/cli` au minimum, ou tout en namespace), (b) **exact-pin transitives critiques** (lecture leçon supply-chain Hermes), (c) Docker image officielle + docker-compose.yml pour Postgres + Runner + Web, (d) Homebrew formula + Scoop bucket (Windows), (e) `nodalai self-update` |
| 23 | **i18n** | 7 locales gateway+CLI : zh, ja, de, es, fr, uk, tr ; Docusaurus zh-Hans | 100% EN/FR (commentaires) — pas de framework i18n observé | 🟡 | Optionnel pour Phase 1. Si SMB-target : ajouter FR/ES/DE via `next-intl` côté web et un simple dict côté runner ; mais ne pas s'éparpiller — un produit qui marche bien en EN > un produit moyen en 7 langues |
| 24 | **RL / Training data** | `environments/` (Atropos) + `tinker-atropos/` + `rl_cli.py` + `trajectory_compressor.py` + `batch_runner.py` + `datagen-config-examples/` — pipeline complet pour tool-calling RL (Nous Research lab — usage interne) | ❌ | ⚪️ | Hors-périmètre NodalAI. Ne pas essayer de reproduire. Concentrer sur le produit. |
| 25 | **Docs** | Docusaurus complet (`website/`), 4 langues, guide quickstart, CLI ref, env var ref, architecture guide, contributing, security guide, plateforms doc, skills doc, plugins doc, MCP doc, cron doc, context-files doc ; release notes détaillées v0.2 → v0.13 | `README.md` court + `CLAUDE.md` (instructions agent IA) + `docs/ADR-0001-foundations.md` + `docs/PROMPTS.md` (inventaire des prompts LLM) | 🔴 | Add : (a) site Docusaurus / Vitepress public, (b) Quickstart 2-min, (c) Architecture diagram, (d) Connecteurs guide (add your own), (e) Release notes par version, (f) API reference auto-générée depuis Zod (`zod-openapi` ou TypeDoc), (g) examples repo (cookbook : "30 automations en 1 jour") |

---

## 2. Points forts et points faibles — vue agrégée

### Top 5 forces structurelles de Hermes
1. **Maturité de l'écosystème** : 295 contributeurs, 17k tests, 588 PRs par mineure. Pas reproductible en court terme.
2. **Couverture matérielle delivery** : 20 plateformes de messagerie. Probable plus large couverture d'un produit agent OSS au monde.
3. **Self-improving learning loop** : skills auto-créés + auto-améliorés + curator. Différenciateur produit majeur, c'est *the* killer feature.
4. **7 backends terminal** dont Modal/Daytona/Vercel sandbox serverless persistents — exécution éphémère scalable à coût ~zéro idle.
5. **Plugin system multi-couches** (general + memory + model-provider + context-engine + image-gen) + 29 providers LLM en plugin — l'écosystème peut grandir sans toucher au core.

### Top 5 faiblesses structurelles de Hermes
1. **Complexité runtime** : `run_agent.py` ~12 000 LOC, `cli.py` ~11 000 LOC. Monolithic Python avec ~60 params constructeur. Onboarding développeur très lent.
2. **Stack Python 3.11+** avec extras YAML hétérogènes (`[all]`, `[termux]`, `[messaging]`, `[matrix]`…) → install paths fragiles (cf Mini Shai-Hulud, mistralai quarantine).
3. **Pas de multi-tenant first-class** — modèle profile = filesystem isolation, ne scale pas à un SaaS hébergé pour équipes.
4. **DB stockage = SQLite fichier** (`hermes_state.py`) pour sessions ; pas de Postgres natif, donc cluster + HA difficile.
5. **Dashboard chat = PTY+xterm.js** — élégant en local, contraint en cloud multi-user (un PTY par user impossible à scaler).

### Top 5 forces structurelles de NodalAI
1. **Stack moderne all-Node TypeScript strict** : un seul runtime, type-safety end-to-end (Zod), Vercel AI SDK abstrait le LLM proprement, Drizzle abstrait Postgres.
2. **Architecture-as-code** : dependency-cruiser enforce les invariants au CI ; 10 invariants non-négo CI-enforced (no hardcoded metadata, no silent fallbacks, no agent band-aids dans le runner, tool whitelist explicit per agent, anti-loop guards bakés, etc.).
3. **Modèle de données DB-first propre** : agents/jobs/tasks/skills/connectors/credentials/llm_keys/approvals/memory/runs/mcp tables — multi-tenant via `entity_id` partout, multi-agent assignments, budgets per-agent, skill versioning, connector ops whitelisting.
4. **Secrets chiffrés at-rest AES-256-GCM** + master key user-private (chmod 0600) — bonne hygiène crypto out-of-the-box. Hermes laisse les API keys en `.env` plaintext par défaut.
5. **Stack web moderne** Next.js 16 + React 19 + Server Actions + Tailwind 4 + Sonner — DX et UX premium possible.

### Top 5 faiblesses structurelles de NodalAI
1. **Surface fonctionnelle ~5 %** de Hermes : 1 plateforme delivery vs 20, 8 LLM providers vs 29, 5 tools always-on vs 30+ toolsets, pas de MCP client, pas de code exec, pas de browser, pas de filesystem tools.
2. **Pas de self-improving skills** — la killer feature de Hermes manque totalement. Skills DB-statiques, pas d'auto-création agent-driven.
3. **Pas d'observabilité production-ready** : `console.warn` partout, pas de logger structuré, pas d'OTel, pas de cost tracking $ converti, pas de dashboard logs avec filtres.
4. **Onboarding pas encore livré** : "Not yet shipped — see migration plan" dans le README. `npx nodalai` n'existe pas encore.
5. **Documentation embryonnaire** : 1 README + 1 ADR. Pas de quickstart public, pas de site docs, pas de cookbook. Adoption impossible en l'état.

---

## 3. Plan d'amélioration global — feuille de route pour rendre NodalAI compétitif

> **Philosophie directrice** : ne **pas** essayer de copier Hermes feature-par-feature. NodalAI a déjà un avantage structurel (stack moderne, multi-tenant, modèle de données propre) que Hermes ne rattrapera jamais sans rewrite. Le bon move est de **gagner sur le terrain SaaS/team/cloud-native** pendant que Hermes domine le terrain *power-user/local-only/research*.

### Vision-cible 12 mois
> **NodalAI = la plateforme agent-as-a-service open-source pour équipes/SMB**. Hébergeable en 30 secondes (`npx nodalai`), aussi hébergée en cloud (`nodalai.com`), multi-tenant native, marketplace adapters/skills, observabilité production, et un **modèle pricing $ inutile chez Hermes** (cost-tracking + budgets) qui débloquerait un business model.

### Phase 1 — Foundation Ship (semaines 1-6, *parité minimale*)
**Objectif** : tout dev/founder/SMB peut self-host en 2 minutes et lancer un agent utile.

| # | Initiative | Effort (j-h) | Impact | Détails |
|---|---|---|---|---|
| 1.1 | Shipper `npx nodalai` réellement | 3 | 🔥🔥🔥 | publier `@nodalai/cli` sur npm ; bundle prebuilt web ; embedded-postgres ; first-run wizard `nodalai init` (détecte Ollama/LM Studio local) ; `nodalai up` ouvre browser |
| 1.2 | `nodalai doctor` | 2 | 🔥🔥 | health checks : DB, runner, web, key, ports, pgvector ; outputs actionable suggestions |
| 1.3 | LLM providers add | 5 | 🔥🔥 | + Gemini natif, + DeepSeek, + Moonshot/Kimi, + xAI Grok, + Bedrock |
| 1.4 | Code execution sandbox tool | 5 | 🔥🔥🔥 | Node VM (vm2 deprecated → `isolated-vm` ou `Bun.embedded`) ; subprocess + Docker exec optionnel ; pass to agent comme `execute_code` |
| 1.5 | File operations tool (workspace-scoped) | 3 | 🔥🔥🔥 | read/write/grep/patch dans un workspace per-agent ; path traversal check ; déjà chemin vers automations devops/data |
| 1.6 | Slack adapter delivery | 4 | 🔥🔥 | `@slack/bolt` ; signing secret ; per-agent install OAuth ; allowed_channels ; approval keyboards |
| 1.7 | Discord adapter delivery | 4 | 🔥🔥 | discord.js ; per-agent token ; allowed_guilds/channels ; approval buttons |
| 1.8 | MCP client integration | 5 | 🔥🔥🔥 | `@modelcontextprotocol/sdk` ; charge serveurs depuis `mcp_servers` table ; expose tools dans toolset ; UI add/test/disable ; OAuth forwarding |
| 1.9 | Inbound webhooks generic | 4 | 🔥🔥 | `/api/webhook/:slug` ; HMAC verify ; template rendering ; dashboard CRUD ; retry/dead-letter |
| 1.10 | Pino structured logging + dashboard Logs page | 4 | 🔥🔥 | JSON logs ; per-job trace ID ; SSE stream vers dashboard avec filtres |
| 1.11 | Quickstart docs + Docusaurus site | 5 | 🔥🔥 | 2-min quickstart ; architecture diagram ; agent creation tutorial ; first automation ; cookbook 5 examples |
| **Total Phase 1** | **44 j-h** | | |

### Phase 2 — Compete on UX (semaines 7-14, *avantage perçu*)
**Objectif** : montrer une expérience produit *meilleure* que Hermes sur le terrain équipes/SaaS.

| # | Initiative | Effort (j-h) | Impact | Détails |
|---|---|---|---|---|
| 2.1 | Self-improving skills (Phase 1 : draft + version) | 8 | 🔥🔥🔥 | tool `propose_skill` : agent rédige un draft, save dans `agent_skills` avec `is_draft=true` ; UI dashboard valide/rejette ; version history déjà en place via `skill_versions` |
| 2.2 | Browser tool (Playwright) | 6 | 🔥🔥 | reuse `apps/web` Playwright config ; tool `browser_navigate`, `browser_screenshot`, `browser_extract` ; security : cloud-metadata SSRF floor (lift from Hermes) |
| 2.3 | Image generation adapter | 4 | 🔥 | Replicate / Fal / Stability ; tool `image_generate` ; URL retournée + thumbnail dans dashboard |
| 2.4 | Vision tool (multimodal LLM passthrough) | 3 | 🔥 | exploite `vision: true` du CAPABILITY_MATRIX ; tool `analyze_image` |
| 2.5 | Cron enhancements | 5 | 🔥🔥 | human format ("every 2h", "tomorrow 9am") ; script pre-run ; `no_agent` mode ; catchup + grace window ; hard interrupt ; UI builder amélioré |
| 2.6 | Cost tracking $ + budgets enforcement | 5 | 🔥🔥🔥 | `usage_pricing` matrix ; calcule $ depuis tokens ; alerte dashboard à 80% du daily/monthly limit ; autoPause déjà en place — câbler la triggers |
| 2.7 | OpenTelemetry spans | 4 | 🔥🔥 | trace LLM call, tool call, job, delegation ; exporter Jaeger/Honeycomb optionnel |
| 2.8 | RBAC multi-user multi-entity | 8 | 🔥🔥🔥 | tables `users`/`entities`/`memberships` (déjà partiellement présentes) ; rôles admin/member/viewer ; invitation flow ; audit log ; **vraie killer feature SaaS** |
| 2.9 | Dashboard chat (real-time agent conversation) | 8 | 🔥🔥 | Hono SSE stream depuis runner ; React chat UI ; ne nécessite PAS de PTY ; markdown render ; tool call display |
| 2.10 | Marketplace adapters/skills public catalog | 6 | 🔥🔥 | publier `@nodalai/adapter-*` ; dashboard "Browse marketplace" ; one-click install |
| **Total Phase 2** | **57 j-h** | | |

### Phase 3 — Leadership Bets (semaines 15-24, *différenciation*)
**Objectif** : devenir le choix par défaut pour les équipes / créer des moats produit.

| # | Initiative | Effort (j-h) | Impact | Détails |
|---|---|---|---|---|
| 3.1 | Self-improving skills (Phase 2 : auto-amélioration) | 10 | 🔥🔥🔥 | agent peut `patch_skill` (diff sur un skill existant) avec auto-validation par tests sur memories d'usage ; bench A/B silent avant rollout ; rollback auto sur régression |
| 3.2 | Auto-curator de memories + skills | 6 | 🔥🔥 | scheduled job hebdo qui run un LLM auxiliaire pour archiver les memories obsolètes, deduplicate, fusionner ; dashboard `Insights` weekly digest |
| 3.3 | Heartbeat + reclaim + zombie sur jobs | 6 | 🔥🔥 | jobs `processing` doivent ping toutes les 30s ; zombie après 5 min sans heartbeat → reclaim ; déjà 80% de l'infra (chain_count, cron tick) |
| 3.4 | Honcho-style dialectic user modeling | 5 | 🔥🔥 | LLM auxiliaire qui consolide "qui est l'utilisateur" à partir des conversations ; injecté dans system prompt ; killer feature 1-1 personalization |
| 3.5 | Hybrid search BM25 + cosine | 4 | 🔥 | déjà pgvector + Postgres tsvector ; reranking ; ROI memory recall ++ |
| 3.6 | OAuth marketplace 10+ providers | 10 | 🔥🔥 | + Linear, GitHub, Jira, HubSpot, Stripe, Shopify, Pipedrive, Calendly, Slack, Twilio |
| 3.7 | Workflow visual editor (no-code) | 12 | 🔥🔥🔥 | dashboard drag-and-drop chains : trigger → agent → delivery ; persist comme `agent_assignments` + `schedules` ; saver feature pour SMB |
| 3.8 | Hosted SaaS @ nodalai.com | 15 | 🔥🔥🔥 | déploiement Render/Fly de la même codebase ; auth Google/GitHub via better-auth ; pricing free + paid tiers ; cost-cap natif ; **business model** |
| 3.9 | Mobile companion (PWA + push) | 8 | 🔥 | dashboard responsive existant ; ajouter Web Push API ; "agent finished" notifications mobile ; ROI hors-PC |
| 3.10 | Long-tail messaging adapters (WhatsApp, Email inbound) | 8 | 🔥 | + Twilio WhatsApp Business, + IMAP/SES inbound, + Webhook generic outbound ; couvre 80% du long-tail Hermes sans rebuilder 20 plateformes |
| **Total Phase 3** | **84 j-h** | | |

### Total programme
- **Phase 1** : 44 j-h ≈ 6 semaines @ 1 dev solo (parité minimale)
- **Phase 2** : 57 j-h ≈ 8 semaines (avantage perçu)
- **Phase 3** : 84 j-h ≈ 12 semaines (leadership / monétisation)
- **Total** : 185 j-h ≈ 26 semaines (6 mois solo full-time, ou 3 mois à 2 devs en parallèle)

---

## 4. Décisions stratégiques recommandées

### Ce qu'il faut **garder** (déjà bien fait dans NodalAI)
- ✅ Architecture pnpm monorepo + Turborepo + dependency-cruiser invariants
- ✅ Drizzle ORM + Postgres + pgvector (vs SQLite Hermes)
- ✅ TypeScript strict + Zod end-to-end
- ✅ Vercel AI SDK comme abstraction LLM (vs adapter par provider Hermes)
- ✅ 10 invariants non-négociables CI-enforced (no hardcoded metadata, no silent fallbacks…)
- ✅ Modèle multi-tenant `entity_id` partout
- ✅ Secrets AES-256-GCM at-rest
- ✅ Approval rules + tool whitelist per-agent
- ✅ Better-auth opt-in pour SaaS path

### Ce qu'il faut **ajouter** (priorités absolues)
1. 🚨 **Shipper `npx nodalai`** — sans ça, *rien* d'autre ne compte
2. 🚨 **MCP client** — standard de facto, ROI gigantesque pour 5 j-h
3. 🚨 **Code execution + File ops tools** — sans ça, l'agent ne peut *rien* faire d'utile au-delà de répondre du texte
4. 🚨 **Slack + Discord adapters** — couvre 70 % du marché SMB messaging
5. 🚨 **Self-improving skills (Phase 1+2)** — la killer feature qui différencie Hermes, indispensable
6. 🚨 **Cost tracking $ + budgets** — fonctionnalité absente chez Hermes, vraie valeur ajoutée SaaS
7. 🚨 **RBAC multi-user** — débloque le marché équipes
8. 🚨 **Observability production-grade** (Pino + OTel + Logs page)

### Ce qu'il faut **NE PAS faire** (anti-objectifs)
- ❌ **Reproduire les 20 plateformes messaging de Hermes** — Slack + Discord + Telegram + WhatsApp + Email + Webhook generic couvre 95 % des cas. Le long tail (Matrix, Signal, DingTalk, WeCom, Feishu, QQ Bot…) = trappe à dette.
- ❌ **7 backends terminal** — local + Docker exec optional suffit. Modal/Daytona/Vercel sandbox = niche, à explorer en Phase 3 si signal demand.
- ❌ **TUI Ink replica** — Hermes a investi des centaines de PRs là-dessus. NodalAI doit gagner sur le dashboard web, pas le terminal.
- ❌ **RL / Atropos training infra** — c'est le lab de Nous Research. Hors-périmètre produit.
- ❌ **29 LLM providers** — 12 bien choisis suffisent (Anthropic, OpenAI, Gemini, Mistral, Groq, Ollama, OpenRouter, DeepSeek, Moonshot, xAI, Bedrock, OpenAI-compatible).
- ❌ **Multi-profiles filesystem** — le multi-tenant entity_id intra-DB est plus propre et SaaS-natif.
- ❌ **Réécrire Hermes en TypeScript** — refuse explicitement l'angle "compete on parity". Compete on **UX, multi-tenant, observabilité, monétisation**.

### Risques principaux à gérer
1. **Hermes ajoute le multi-tenant** — peu probable (Nous Research est un lab, pas un SaaS-builder), mais à surveiller. Mitigation : être *le* nom sur multi-tenant agent OSS dès maintenant.
2. **Anthropic/OpenAI shippent un Claude Code Routines équivalent** — déjà arrivé (cf `hermes-already-has-routines.md`). Mitigation : NodalAI doit être *better than the platform* sur multi-tenant + bring-your-own-LLM + connectors marketplace.
3. **Vercel AI SDK breaking changes** — dépendance forte ; ils ont des breaking changes fréquents (v4 → v5). Mitigation : pin de version + tests integration mensuel + fallback abstraction layer minimal interne.
4. **Crypto rotation** — `secrets.key` perdu = toutes les API keys perdues. Mitigation : backup chiffré opt-in vers iCloud/Dropbox + key rotation procedure documentée.
5. **Postgres embedded sur Windows / corporate env** — embedded-postgres a parfois des soucis. Mitigation : tester sur Windows 11 / macOS 14 / Ubuntu 22 dans le CI ; documenter fallback Docker.

---

## 5. Conclusion

NodalAI est dans une **position favorable** malgré l'écart fonctionnel apparent.

Hermes Agent est un produit **étonnant** sur le terrain du *power-user personal AI* — 20 plateformes, 29 providers, 7 backends, skills auto-créatifs, 17k tests. Sa surface est si large qu'elle est difficile à concurrencer sur la parité.

Mais Hermes a aussi des **limitations structurelles** que NodalAI peut exploiter :
- Mono-utilisateur par design (multi-profile filesystem = pas du SaaS)
- Python monolithic (~12k LOC dans `run_agent.py`) → coût marginal d'évolution élevé
- SQLite + filesystem (pas de cluster, pas d'HA)
- Dashboard PTY-based (incloudable à N users)
- Zéro pricing/billing/cost-control natif
- Stack hétérogène (Python + Node + Rust extras + bash installers)

**Le pari NodalAI doit être** : *"Hermes pour les équipes, hébergé, observable, monétisable"*. Cela suppose **6 mois de focus** sur les 8 priorités absolues listées en §4. Avec ce périmètre :
- À 6 semaines (fin Phase 1) : NodalAI est **utilisable** par un dev solo qui veut self-host un agent multi-skill avec MCP + Slack.
- À 14 semaines (fin Phase 2) : NodalAI **dépasse Hermes** sur le terrain équipes (RBAC, cost tracking, dashboard real-time).
- À 26 semaines (fin Phase 3) : NodalAI peut **lancer un SaaS payant** différencié sur multi-tenant + marketplace.

Le code que j'ai lu suggère que cette ambition est **réaliste** : la fondation NodalAI est techniquement de qualité supérieure à Hermes (TypeScript strict, Drizzle, Zod, invariants CI), il manque "juste" la profondeur fonctionnelle — qui est **finie et estimable** à 6 mois solo.

---

## 6. Recommandation stratégique finale — *faire mieux que Hermes, pas comme Hermes*

### 6.1 Thèse en une phrase

> **Ne pas être Hermes en TypeScript. Être l'anti-Hermes : la plateforme agent que Hermes ne pourra JAMAIS devenir.**

Hermes a 2 ans d'avance sur la *largeur* fonctionnelle. Inutile d'essayer de combler en 6 mois. Mais Hermes a 5 limitations structurelles non-rattrapables sans rewrite, qui sont autant de moats potentiels pour NodalAI :

| Limite Hermes | Pourquoi non-rattrapable | Moat NodalAI correspondant |
|---|---|---|
| Mono-utilisateur (profiles filesystem) | Tout le code suppose `HERMES_HOME = un user` | **Multi-tenant `entity_id` natif** (déjà en place) |
| SQLite + filesystem state | Single-writer, pas de cluster | **Postgres + pgvector cloud-ready** (déjà en place) |
| `.env` plaintext, no cost tracking $ | Pas pensé pour facturer | **AES-256-GCM at-rest + budgets DB + path billing** |
| Dashboard PTY xterm.js | Un PTY/user impossible à scale | **Next.js SSR scale à N users sans souci** |
| 3 config loaders + 35+ extras pip | Refactor coûte des mois | **1 schéma Zod centralisé** (déjà en place) |

### 6.2 Mission statement proposé

> **NodalAI is the team-first AI agent platform that runs locally or in the cloud, with cost transparency and self-improving team skills.**

3 mots-clés : **team-first / cost-transparency / self-improving team-shared skills**. À reprendre dans tous les supports (README, landing page, slides).

### 6.3 Les 5 paris stratégiques

#### Pari #1 — Multi-tenant first, single-user en cadeau
- Chaque feature conçue pour `team of N`, single-user = `N=1`
- RBAC : admin / member / viewer sur agents, skills, connectors, automations
- Invitation flow (`/invite quentin@beau.com role=member`)
- Audit log per-entity
- Budgets per-entity (80 % déjà en place via `agent_budgets`)
- Marketplace privée per-entity (skills/agents/templates partagés équipe)

**Moat** : Hermes ne peut pas. NodalAI est seul sur le terrain SMB/team.

#### Pari #2 — Skills DB-first + self-improving entity-level (meilleur que Hermes)

Hermes a inventé les skills auto-créés MAIS filesystem-per-user, donc :
- Pas partagés équipe
- Pas de versioning collaboratif
- Pas d'A/B testing
- Pas de validation humaine

NodalAI a la fondation DB (`agent_skills` + `skill_versions`), il faut compléter la boucle :
1. Tool `propose_skill` (agent crée draft avec `is_draft=true`)
2. Dashboard validation humaine
3. Tool `patch_skill` (agent propose amélioration → new version)
4. A/B silent (compare v1 vs v2 sur jobs réels via `tool_calls` analytics)
5. Rollback auto sur régression
6. **Entity-shared** : skill validé dispo pour TOUS les agents de l'équipe

**Pitch** : *"Vos 5 collaborateurs ont chacun appris une best practice à leur agent. Avec NodalAI, l'agent de toute l'équipe les connaît toutes."*

#### Pari #3 — Observabilité production-grade dès le jour 1 (vraie killer SaaS)

Hermes a `console.warn` + Langfuse opt-in. **Insuffisant pour SaaS.** À shipper en Phase 1 (~15 j-h) :

| Composant | Stack | Pourquoi |
|---|---|---|
| Logger structuré | Pino multi-transport (JSON file + stdout) | Grepable, agrégeable |
| AsyncLocalStorage | `{ jobId, agentId, entityId, userId }` partout | Trace cross-async sans param drilling |
| Secret redaction | Middleware Pino + regex `apiKey\|token\|password\|secret` | Compliance + GDPR |
| OpenTelemetry spans | LLM call, tool call, job, delegation | Debug multi-agent + export Jaeger/Honeycomb |
| **Cost tracking $** | Table `pricing_matrix` × usage tokens | **Sans ça, pas de SaaS.** |
| Dashboard Logs | Hono SSE → React stream avec filtres | Real-time = wow effect demo |
| Cost dashboard | Per-entity/agent/user/day | Hermes n'a pas ça en idée |
| `nodalai doctor` | Health DB/runner/web/key/ports/pgvector | Onboarding sans friction |

**ROI infini** car aucun autre agent OSS ne ship ça à ce niveau.

#### Pari #4 — Plugin system propre dès le départ (apprendre de Hermes sans copier)

Hermes a 4 surfaces plugin divergées organiquement → 4 mécanismes discovery, comments "timing pitfall"...

NodalAI fait **mieux en faisant moins** :
- ONE convention : npm package `nodalai-plugin-*`
- ONE manifest : `package.json` field `nodalai: { kind, version, hooks, tools }`
- ONE loader : runner scan `node_modules` au boot
- 10 hooks essentiels : pre/post_tool, pre/post_llm, on_session_start/end, transform_output, pre_delivery, pre/post_approval
- ONE ABC : `register(ctx)` avec `ctx.registerTool`, `ctx.registerHook`

Marketplace dashboard. One-click install (`npm i nodalai-plugin-slack` → reload → dispo). Migrer chaque adapter actuel vers ce système = exemple canonique.

#### Pari #5 — Cloud-native by design (le business model)

Hermes = "self-host or run nowhere". OSS pur, pas de path commercial.

NodalAI = **3 modes depuis le même codebase** :

```
1. Local       : npx nodalai          (Postgres embedded, no auth)
2. Self-hosted : docker compose up    (Postgres cluster, better-auth)
3. Hosted SaaS : nodalai.com          (Render/Fly, Stripe, multi-tenant)
```

Mode #3 = **le seul des 5 paris qui transforme le projet en business**. Composants :
- Auth Google/GitHub via better-auth (80 % en place)
- Stripe billing metered (basé sur cost tracking Pari #3)
- Free tier (1M tokens/mois)
- Paid tiers (Pro $20, Team $99, Enterprise sur devis)
- Cost-cap natif (autoPause à 110 % du quota — 80 % en place via `agent_budgets`)
- Postgres Neon/Render branching pour previews
- CDN-cache du dashboard Next.js

### 6.4 Roadmap d'exécution — 6 mois solo / 3 mois à 2 devs

```
┌──────────────────────────────────────────────────────────────────┐
│ MOIS 1-2 │ FOUNDATION                                            │
│          │ • Shipper `npx nodalai` sur npm (semaine 1)           │
│          │ • Pino + OTel + AsyncLocalStorage (semaine 2)         │
│          │ • Cost tracking $ + dashboard Cost (semaine 3-4)      │
│          │ • web_search réel (Tavily) + sendEmail (Resend)       │
│          │ • MCP client (tables existent déjà !)                 │
│          │ • Code exec (isolated-vm) + file ops (workspace)      │
│          │ • `nodalai doctor` + Docker Compose officiel          │
│          │ • 🧠 MÉMOIRE — Quick wins (cf memory-roadmap.md)      │
│          │     - Sanitation anti-injection sur save_memory       │
│          │     - Dedup via fact_hash (colonne déjà en DB)        │
│          │     - query_memory utilise searchMemories             │
│          │ RÉSULTAT : NodalAI utilisable + observable + safe     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ MOIS 3-4 │ DIFFÉRENCIATION                                       │
│          │ • 🧠 MÉMOIRE — Cœur du système                        │
│          │     - Auto-injection mémoire dans buildSystemPrompt   │
│          │     - Budget tokens dur sur l'injection (~1500 tok)   │
│          │     - Feedback loop (mark_helpful / mark_outdated)    │
│          │ • RBAC multi-user + invitations + audit log           │
│          │ • Slack + Discord adapters                            │
│          │ • Plugin system v1 (1 convention, 10 hooks, registry) │
│          │ • Self-improving skills v1 (propose + validate)       │
│          │ • Dashboard real-time chat (SSE, pas PTY)             │
│          │ • Cron amélioré (formats humains, no_agent, [SILENT]) │
│          │ • Browser tool (Playwright)                           │
│          │ RÉSULTAT : NodalAI > Hermes pour les équipes          │
│          │             Mémoire active (transforme l'UX agent)    │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ MOIS 5-6 │ MONÉTISATION                                          │
│          │ • 🧠 MÉMOIRE — Intelligence émergente                 │
│          │     - Extraction post-job auto (LLM aux Haiku)        │
│          │     - Prefetch async (élimine round-trip DB)          │
│          │     - Colonnes temporelles actives (valid_to + TTL)   │
│          │ • Self-improving skills v2 (patch + A/B + rollback)   │
│          │ • Honcho-style dialectic user modeling                │
│          │ • Marketplace adapters/skills public                  │
│          │ • Stripe billing + cost-cap + free tier               │
│          │ • Deploy nodalai.com (hosted SaaS)                    │
│          │ • Workflow visual editor (no-code chains)             │
│          │ • Mobile PWA + Web Push notifications                 │
│          │ RÉSULTAT : SaaS revenue + OSS community               │
│          │             Mémoire qui se densifie toute seule       │
└──────────────────────────────────────────────────────────────────┘
```

**Effort total ajusté avec items mémoire** : Phase 1 = 65 j-h · Phase 2 = 77 j-h · Phase 3 = 99 j-h · **Total ≈ 241 j-h ≈ 7,5 mois solo** (ou 3,75 mois à 2 devs).

> 📘 Détail tactique mémoire : voir **`memory-roadmap.md`** — 13 items priorisés P1-P4 avec effort en story-points, dépendances et sprint plan.

### 6.5 Anti-objectifs absolus — NE PAS faire

| ❌ Tentation | Pourquoi mauvais |
|---|---|
| Reproduire les 24 plateformes Hermes | Slack + Discord + Telegram + Email + Webhook = 95 % du marché. Le reste = trappe à dette. |
| Reproduire les 28 LLM providers | 12 bien choisis suffisent. Vercel AI SDK ajoute les nouveaux gratuitement. |
| Reproduire les 7 terminal backends | Local + Docker exec optional = OK. Modal/Daytona = Phase 4 si demand signal. |
| Implémenter Atropos RL | Hors-périmètre produit. C'est le lab Nous Research. |
| Migrer vers Python pour "parité Hermes" | **Tu détruis ton avantage architectural. Le piège ultime.** |
| Sortir une TUI Ink replica | Le terrain web/mobile a 100× le marché. |
| Multi-profile filesystem | Le multi-tenant `entity_id` est strictement supérieur pour SaaS. |
| Kanban durable v1 day one | Trop d'effort vs ROI. Attendre la demande utilisateur. |

### 6.6 KPI de succès

**Pas** "N features que Hermes a aussi". **Pas** "stars GitHub".

**Le vrai KPI** :
> *"Combien d'équipes (≥2 users) utilisent NodalAI en production avec ≥1 agent productif chaque semaine ?"*

À 6 mois : **30 équipes actives = victoire.** Hermes ne peut pas en avoir parce que son design ne le permet pas. Tu joues seul sur ce terrain.

### 6.7 Plan tactique immédiat

**Cette semaine :**
1. Fermer l'audit. Écrire la **mission statement** (3 lignes au-dessus).
2. **Réécrire le README** avec ce nouveau positioning (déjà fait — cf `README.md`).
3. **Shipper `npx nodalai` cette semaine** — même imparfait. **Le packaging compte plus que la perfection.**

**Ce mois-ci :**
4. Ajouter MCP + code exec + cost tracking $.
5. Ouvrir un Discord/Slack public, push update toutes les 2 semaines.
6. Chercher **3 design partners** (équipes de 3-10 personnes qui se plaignent de l'agent OSS actuel).

**Ces 3 mois :**
7. RBAC multi-user + self-improving skills + observability = la thèse produit. Tout le reste est secondaire.

**À 6 mois :**
8. Si 30 équipes actives → **gagné**. Sinon → pivot ou tue.

---

## Annexe A — Inventaire détaillé des chiffres

| Métrique | Hermes Agent v0.13.0 | NodalAI |
|---|---|---|
| Lignes core agent loop | **~15 700** (`run_agent.py` — 237 defs / 16 classes) | ~900 (`apps/runner/src/job/execute.ts` ~938 lignes) |
| Lignes CLI orchestrator | **~13 564** (`cli.py`) | ~140 (`apps/cli/src/index.ts`) |
| Fichiers `.py` ou `.ts` total | ~1 500 | ~340 packages + ~50 apps |
| Tests | **~1 058 fichiers** pytest dans `tests/{acp, agent, cli, cron, e2e, environments, fakes, gateway (246), hermes_cli, hermes_state, honcho_plugin, integration, openviking_plugin, plugins, providers, run_agent, skills, stress, tools (210), tui_gateway, website}` | **~166** (*.test.ts, vitest) — `tests/architecture` et `tests/smoke` sont des dossiers VIDES, e2e Playwright dans `apps/web/tests/e2e/` |
| Files messaging platforms | **24 total** : 20 built-in + 4 plugin-platforms (google_chat, irc, line, teams) | 1 implémenté (Telegram), 1 stub (Email always-throws), 0 (Slack/Discord/WhatsApp existent comme enum values seulement) |
| Files LLM providers | **28** (plugin dirs : ai-gateway, alibaba, alibaba-coding-plan, anthropic, arcee, azure-foundry, bedrock, copilot, copilot-acp, custom, deepseek, gemini, gmi, huggingface, kilocode, kimi-coding, minimax, nous, nvidia, ollama-cloud, openai-codex, opencode-zen, openrouter, qwen-oauth, stepfun, xai, xiaomi, zai) + aliases | 8 |
| Files tools | 74 | 5 always-on (dont `web_search` = stub) + 9 adapters externes (Notion 17 outils, Drive 39 source files, Gmail 24, Sheets 10, Docs 10, Firecrawl 5, Apify 5, Tavily 4, Airtable 4) |
| Terminal backends | 7 | 0 |
| Memory providers | 8 plugins | 1 built-in pgvector |
| DB migrations | N/A (SQLite live) | 10 Drizzle migrations |
| DB schema files | N/A | 21 |
| Skills bundled | **87 SKILL.md** dans `skills/` + **79** dans `optional-skills/` = 166 total ; agentskills.io compatible | DB-driven (count = entries en DB) |
| Locales | **16** : en, af, de, es, fr, ga, hu, it, ja, ko, pt, ru, tr, uk, zh, zh-hant + zh-Hans docs ; **catalog parity test CI-enforced** | 1 (EN+FR mix) |
| Release versions | 13 majeures (v0.2 → v0.13 depuis 2024) | v0.0.0 |
| Commits entre v0.12 et v0.13 | 864 (~3 mois) | N/A |
| Contributors | 295 (v0.12→v0.13 seul) | <5 |
| Dependencies pyproject/package.json | ~30 core exact-pinned + ~25 optional | ~15 root + ~150 transitives |

---

## Annexe C — Nuances révélées par l'audit Hermes deep

Les 10 nuances suivantes ne ressortaient pas du simple parcours fichiers et changent la compréhension stratégique :

1. **Hermes est MCP server AND client** (`mcp_serve.py` expose 10 outils MCP qui permettent à un *autre* agent IA de piloter Hermes). Cela ouvre un pattern produit unique : Hermes peut être appelé *par* d'autres agents IA (Claude Code, Cursor, etc.). NodalAI gagnerait à shipper aussi un endpoint MCP-server pour devenir composable avec l'écosystème agent.

2. **Architecture plugin = 4 surfaces orthogonales** (general + memory + model-provider + platform), pas 1. Chacune a son discovery, son ABC, son `register(ctx)`. Plus la règle "plugins MUST NOT modify core files" est culturellement enforced (PR #5295 retire 95 lignes hardcodées honcho de main.py). **À copier intégralement chez NodalAI**.

3. **17 lifecycle hooks plugin** (pas 4-5 comme j'imaginais) : `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `pre_api_request`, `post_api_request`, `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`, `subagent_stop`, `transform_terminal_output`, `transform_tool_result`, `transform_llm_output`, `pre_gateway_dispatch`, `pre_approval_request`, `post_approval_response`. Pour NodalAI, viser 8-10 hooks suffit pour 80% de la valeur.

4. **SQLite WAL avec fallback NFS/SMB/FUSE detection** dans `hermes_state.py` — détecte les erreurs "locking protocol" / "not authorized" / "disk i/o error" et bascule vers journal DELETE. NodalAI sur Postgres n'a pas ce problème *mais* peut s'inspirer pour les caches/sessions locales optionnelles.

5. **SECURITY.md exemplaire** : "**The only security boundary against an adversarial LLM is the operating system.**" Pas de pretense que les approval gates sont une vraie sécurité. NodalAI devrait écrire un SECURITY.md aussi honnête et nommer ses vrais défenses : crypto-at-rest, Postgres scope par entity_id, tool whitelist per agent. **Faiblesse Hermes notée** : pas de bug bounty program.

6. **Cron `[SILENT]` outputs** + `no_agent` mode = pattern watchdog parfait (script qui ne notifie que si quelque chose va mal). À copier en Phase 1.

7. **`OPTIONAL_ENV_VARS` declarative metadata** dans `hermes_cli/config.py` : chaque entrée a `description`, `prompt`, `url`, `password: bool`, `category`. Le setup wizard l'utilise pour auto-générer son UI. Plugin `requires_env` blocks alimentent automatiquement cette liste. **NodalAI peut copier ce pattern** : un fichier `EnvVarsRegistry.ts` qui pilote à la fois le wizard CLI ET le formulaire dashboard.

8. **Trajectory recording natif** (Hermes-format : pairs `from/value` avec `<tool_call>`/`<tool_response>` XML markers) compatible avec batch_runner + trajectory_compressor + Atropos RL. Même si NodalAI ne fait pas de RL, **enregistrer les trajectories au format JSONL est trivial et débloque** : replay debug, regression tests, opt-in user analytics, future fine-tuning.

9. **Trois config loaders chez Hermes = bug magnet** (AGENTS.md le confirme : "If you add a new key and the CLI sees it but the gateway doesn't (or vice versa), you're on the wrong loader"). **NodalAI a déjà éliminé ce problème** avec son schéma Zod centralisé dans `apps/cli/src/lib/config.ts` — un vrai avantage architectural.

10. **Triple-log split (agent/errors/gateway) + RedactingFormatter + session_id thread-local + crash log fallback pour TUI subprocess**. NodalAI doit shipper l'équivalent en Phase 1 (Pino multi-transport : `nodalai-runner.log`, `nodalai-errors.log`, `nodalai-web.log`, redactor middleware sur `apiKey|token|password|secret`, AsyncLocalStorage pour jobId/agentId).

### Mise à jour du plan d'amélioration

**Ajouter en Phase 1** :
- **1.12 — `web_search` réel via Tavily** (déjà adapter) : 2 j-h. Le stub doit disparaître.
- **1.13 — `sendEmail` réel via Resend** : 3 j-h.
- **1.14 — `[SILENT]` cron pattern + `no_agent` watchdog mode** : 1 j-h pour l'opt-in.
- **1.15 — `EnvVarsRegistry` déclaratif** (single source pour wizard CLI + dashboard form) : 2 j-h.
- **1.16 — Trajectory recording JSONL** opt-in via env `NODALAI_RECORD_TRAJECTORIES=1` : 2 j-h.
- **1.17 — Triple-log split + redactor + AsyncLocalStorage** : 3 j-h.

**Ajouter en Phase 2** :
- **2.11 — MCP server endpoint** (NodalAI-as-MCP-server, expose `agents_list`, `agent_run`, `memory_query` à des agents externes) : 4 j-h. **Tournant produit** : NodalAI devient composable avec Claude Code/Cursor.
- **2.12 — 4 plugin surfaces** (general + memory-provider + llm-provider + delivery-channel) avec ABC + register(ctx) + plugin.yaml + 10 hooks essentiels : 8 j-h. Débloque l'écosystème.
- **2.13 — SECURITY.md honnête** + threat model NodalAI : 1 j-h.

**Total ajusté** :
- Phase 1 : 44 + 13 = **57 j-h** (~8 semaines solo)
- Phase 2 : 57 + 13 = **70 j-h** (~10 semaines solo)
- Phase 3 : 84 j-h (~12 semaines solo)
- **Grand total : 211 j-h ≈ 30 semaines solo** (≈ 7 mois en solo, ou 3,5 mois à 2 devs)

### Conclusion enrichie

Hermes est **plus mature** que je l'estimais initialement : 15 700 LOC dans le seul `run_agent.py`, 1 058 fichiers tests, 16 locales, 28 LLM providers, 24 plateformes messagerie, 4 surfaces plugin + 17 hooks, MCP bidirectionnel, RL training infra complète. C'est probablement **le produit agent OSS le plus complet au monde** sur le terrain power-user/personal.

Mais ses faiblesses sont structurelles et non-rattrapables sans rewrite : monolithes (`run_agent.py` 15.7k LOC, `cli.py` 13.5k LOC), Python async/sync hybride patchwork, SQLite single-writer, 35+ extras pip explosion, Windows "early beta", `cli-config.yaml.example` à 55 KB, pas de multi-tenant, pas de pricing/billing.

**Le bon framing pour NodalAI reste intact** : ne pas chercher la parité fonctionnelle (perdu d'avance), mais gagner sur le terrain *équipes hébergeable observable monétisable*. Le plan en 3 phases sur 7 mois reste valable, enrichi de 6 items Phase 1 + 3 items Phase 2 issus de l'audit deep.

---

## Annexe B-bis — Findings additionnels (audit deep)

Suite à l'audit approfondi du sous-agent NodalAI, voici 10 findings complémentaires qui n'apparaissent pas en surface :

1. **`web_search` est un placeholder** — `packages/tools/src/builtin/web-search.ts` throw `WebSearchNotConfiguredError` car le code branche sur `NODALAI_WEB_SEARCH_URL` mais cette branche est commentée comme "currently unreachable". Tool exposé mais inutilisable.

2. **`sendEmail` est un stub** — `packages/delivery/src/channels/email.ts` toujours `throw new DeliveryError('delivery_email_not_configured', ...)`. Le channel est dans `JOB_CHANNELS` mais l'implémentation est absente.

3. **MCP = schema-only, 0 code runtime** — grep cross-codebase confirme : `mcp_servers`, `agent_mcp_servers`, `mcp_connections` sont déclarés dans `packages/db/src/schema/mcp.ts` avec contraintes complètes, mais zéro référence runtime outside test files. Le code path runner ne charge aucun serveur MCP.

4. **Bootstrap CLI est Windows-grade mais Windows-specific en places** — `netstat` hard-codé comme orphan probe (`apps/cli/src/lib/postgres.ts`), `process.platform === 'win32'` branches partout. Pas de `lsof` equivalent shipped pour Linux/Mac orphans.

5. **Runner single-process, no isolation** — un poisoned dependency dans n'importe quel adapter peut crash tout le runtime. Pas de worker pool, pas de queue, pas de horizontal scaling. La "cloud cron alternative" (CRON_TICKER_ENABLED=false + POST /api/cron) call back into the same process.

6. **Delegation recursion is synchronous** — `executeJob(parent)` recurse dans `executeJob(child)` sur la stack, puis re-entre dans le parent. Implique : pas de parallel sub-agent execution dans un seul orchestrateur turn. Limite raisonnable avec maxDelegationDepth=3 mais bloquante pour parallel patterns.

7. **Drizzle migrations ont des noms auto-generated nonsense** : `0000_flashy_clea.sql`, `0003_stormy_thaddeus_ross.sql`, `0004_married_deadpool.sql`, `0008_curious_thor_girl.sql`. Seul `0006_credentials_table.sql` est nommé proprement. **Difficile de spotter les changements de domain dans git history.**

8. **`docs/PROMPTS.md` est un artefact unique et précieux** — inventaire ligne-par-ligne de tout ce qui est hardcodé sent au LLM (system prompt, team-block, tool descriptions). À conserver et étendre.

9. **Self-heal entity_member** — toute session récupère un entity_member automatiquement si user existe sans rattachement. Bonne UX pour onboarding mais à audit pour les implications sécurité multi-tenant.

10. **Server-actions encryption key auto-mint** — `apps/cli/src/lib/config.ts` régénère et persist un `serverActionsKey` (44-char base64) si absent au boot. Évite le bug Next.js "Server action was not found" après dev-restart. Élégant.

### Conséquences sur le plan d'amélioration

- **Phase 1, item 1.4** (Code execution) doit utiliser **`isolated-vm`** (pas vm2 deprecated, pas Bun car cross-runtime). Cible : sandboxing + memory limit + timeout.
- **Phase 1, item 1.8** (MCP client) — c'est **plus simple que prévu** : les tables sont déjà là, schema correct. Il "suffit" d'implémenter le client `@modelcontextprotocol/sdk` et de mapper. Estimable à 5 j-h (peut-être 4 avec un dev expérimenté MCP).
- **Phase 1, manque** : **un vrai `web_search` tool** — le stub doit être implémenté avec Tavily (déjà adapter !) en fallback par défaut + permettre override via Brave/Serper/SerpAPI. Ajouter en Phase 1 item 1.12, 2 j-h.
- **Phase 1, manque** : **`sendEmail` réel** — Resend / SES / SMTP. Ajouter en Phase 1 item 1.13, 3 j-h.
- **Phase 2, nouveau item** : **migrations nommer** — script Drizzle pour forcer les noms : `pnpm db:generate -- --name="add_mcp_oauth_state"` au lieu d'auto-random. 0.5 j-h, ROI maintenability énorme.
- **Phase 2, nouveau item** : **isolation runtime** — passer le runner en cluster mode Node (worker_threads pour chaque job, ou processus séparés). Ouvre le scaling horizontal pour SaaS. 6 j-h.
- **Phase 3, nouveau item** : **parallel delegation** — `Promise.all(children)` au lieu de recursion synchrone. Nécessite repenser `awaiting_delegation`. 5 j-h.

---

## Annexe B — Références de fichiers cités

### Hermes Agent (`D:\APPS\hermes-agent-main\`)
- `AGENTS.md` : guide développeur complet (~1000 lignes — meilleur point d'entrée code)
- `pyproject.toml` : dépendances exact-pinned + extras profile
- `run_agent.py` : `AIAgent` class — boucle conversation
- `cli.py` : `HermesCLI` orchestrator
- `gateway/run.py` + `gateway/platforms/*.py` : 20 plateformes messagerie
- `tools/registry.py` + `tools/*.py` : 74 tools auto-discoverable
- `tools/environments/{local,docker,ssh,modal,daytona,singularity,vercel_sandbox}.py` : terminal backends
- `plugins/model-providers/<29 providers>` : LLM providers
- `plugins/memory/<8 providers>` : memory backends
- `cron/scheduler.py` + `cron/jobs.py` : cron scheduler
- `hermes_state.py` : SQLite + FTS5 session store
- `agent/curator.py` : skill curator auto-archival
- `ui-tui/` + `tui_gateway/` : TUI Ink/React + Python JSON-RPC backend
- `hermes_cli/web_server.py` : dashboard FastAPI + PTY WebSocket
- `RELEASE_v0.13.0.md` : ~150 highlights (Kanban durable, /goal, video_analyze, sessions auto-resume, security wave…)
- `hermes-already-has-routines.md` : positioning vs Claude Code Routines

### NodalAI (`D:\APPS\NodalAI\`)
- `README.md` + `CLAUDE.md` : architecture + invariants non-négo
- `package.json` (root + 15 sub-packages) : pnpm + Turborepo
- `apps/cli/src/index.ts` : commander CLI (5 commandes : up, down, init, logs, reset)
- `apps/runner/src/server.ts` : Hono HTTP server + cron ticker + telegram manager
- `apps/runner/src/job/execute.ts` : `executeJob` — main LLM loop
- `apps/web/src/app/(dashboard)/*` : Next.js dashboard pages (agents, jobs, automations, billing, connectors, credentials, logs, memories, settings, skills, stats, approvals)
- `packages/llm/src/{client,providers/*,types,errors,retry}.ts` : Vercel AI SDK wrapper + 8 providers
- `packages/orchestration/src/{system-prompt,team-block,chain-counters,router/*,planner/*}.ts` : router/planner + anti-loop guards
- `packages/tools/src/{registry,whitelist,execute,builtin/*,communication/*}.ts` : tool registry + 5 always-on
- `packages/delivery/src/channels/{telegram,email,log}.ts` : 3 delivery channels
- `packages/memory/src/{crud,search,list,stats,filter,access-tracking}.ts` : memory CRUD + pgvector search
- `packages/secrets/src/index.ts` : AES-256-GCM crypto + master key filesystem
- `packages/db/src/schema/{agents,jobs,tasks,skills,connectors,credentials,llm_keys,memory,approvals,runs,mcp,webhooks,users,entities,auth}.ts` : 21 schema files
- `packages/runner-adapters/src/registry.ts` : `ADAPTER_REGISTRY` — 9 connecteurs SaaS
- `packages/auth/src/providers/{local-trust,local-auth,bearer-token}.ts` : 3 auth providers
- `docs/PROMPTS.md` : inventaire exhaustif des prompts LLM
- `docs/adr/ADR-0001-foundations.md` : décisions d'architecture initiales

---

*Fin de l'audit.*
