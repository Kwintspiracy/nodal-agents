# Audits & Strategic Roadmaps

Comparative analyses + tactical plans produced during competitive research and migration sessions. Reference material — not enforced by code or CI.

| File | Scope | Date |
|---|---|---|
| [`hermes-total-audit.md`](./hermes-total-audit.md) | Brique-by-brique audit Nodal-Agents vs Hermes Agent (22 dimensions + 3-phase 6-month roadmap + 5 strategic bets) | 2026-05-13 |
| [`hermes-memory.md`](./hermes-memory.md) | Deep dive on memory architecture: Hermes' multi-layer system (built-in + 8 plugins, 11 lifecycle hooks, sanitation, fencing) vs Nodal-Agents' Postgres-only CRUD. 12 concrete improvement items | 2026-05-13 |
| [`memory-roadmap.md`](./memory-roadmap.md) | Tactical plan derived from `hermes-memory.md` — 13 items priorisés P1-P4 sur 3 sprints (6 semaines). Sprint 1 ✅ shipped 2026-05-15 (commit `a936393`) | 2026-05-13 |
| [`roadmap-8-weeks.md`](./roadmap-8-weeks.md) | Operational 8-week critical-path plan: ship npm → memory sanitation → auto-injection → MCP+tools → design partners | 2026-05-13 |
| [`2026-11-27-harness-audit/`](./2026-11-27-harness-audit/README.md) | Read-only audit of the harness at 0.9.10 in eight areas (secrets, memory, cost and caching, skills and connectors, tools and loop, sandbox, task verification, access and reliability): 104 findings, each counter-audited by a second model, plan in #1185. Five reports; three held back until their fixes ship | 2026-11-27 |
