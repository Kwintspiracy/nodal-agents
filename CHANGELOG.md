# Changelog

Notable releases of **Nodal-Agents**, newest first. Pre-1.0: minor versions can
carry breaking changes. Every release is published to npm as `nodal-agents` and
tagged on GitHub.

```bash
nodal-agents update   # upgrade in place — your data is preserved
```

---

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
