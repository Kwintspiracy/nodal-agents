# Harness audit, 2026-11-27

A read-only audit of the Nodal-Agents harness, asked by the owner on 2026-11-27: is anything
leaking, is memory sound, is every request cheap and cached, are skills, connectors and tools
used well, does the sandbox hold, does "completed" mean done, and what was left out of that list.

- **Code read:** `main` at `b0ab6d535` (0.9.10 plus the `render_pdf` tool).
- **Reference:** a local clone of `NousResearch/hermes-agent`, read for every architecture-level
  recommendation.
- **Nothing was run.** No test, no model call, no database, no log. Every finding comes from
  reading code, migrations, earlier audits (`audit/`, `docs/audit/`, `docs/audits/`) and the
  tracker.
- **The plan that came out of it:** issue #1185, one ticket per mechanism at fault, ordered by lot.

## Reports

| File | Area | Grade | Findings |
|---|---|---|---|
| [`memory.md`](./memory.md) | Agent memory: write path, injection, lifecycle, conversation history | B | 13 |
| [`cost-and-caching.md`](./cost-and-caching.md) | Token cost and prompt caching of every request | B | 11 |
| [`skills-and-connectors.md`](./skills-and-connectors.md) | Skills, native connectors, MCP client | C | 18 |
| [`tools-and-agent-loop.md`](./tools-and-agent-loop.md) | Tool design, the job loop, delegation, the system prompt | B | 16 |
| [`task-verification.md`](./task-verification.md) | What "completed" proves | C | 14 |
| held back | Where a key or password lives, travels and comes out | C | 11 |
| held back | OS confinement, shell gate, approvals, checkpoints | C | 8 |
| held back | Who may do what, untrusted text, what happens when things break | B | 13 |

Grades: A solid and at the state of the art, B good with named gaps, C works but fragile or
costly, D does not do what it promises.

Three reports are held back: they describe weaknesses that are still open, with their scenarios.
They will be added here once the fixes have shipped. Their findings are tracked now, the sensitive
ones in draft security advisories.

104 findings: 9 rated P1, 59 P2, 36 P3. About 85 were tracked by no issue before this audit. Six
were found twice, by two auditors that did not share notes.

A report is left as its auditor wrote it. Where the counter-audit or the owner corrected one, the
correction is in the ticket, not in the report: the tickets are the current state.

## Method

Eight auditors (Claude Opus), one per area, each given the same brief: map the mechanism first,
follow a call path to its end before calling something reachable, give every finding a file, a
line, the quoted code and a concrete scenario, mark it CONFIRMED or PLAUSIBLE, check whether an
issue already tracks it, compare every architecture-level recommendation with Hermes by reading
its code, and say what is solid as plainly as what is not. The orchestrator then re-read 48
findings at the cited lines, the P1 among them.

## Counter-audit by a second model

Before any ticket was opened, every finding was re-read by a reviewer agent of the owner's own
Nodal running on another model (GLM 5.3), read-only, on a copy of the same commit, with the
instruction to try to refute it. The 68 findings rated P1 or P2 got a second, in-depth pass: one
finding per request, the chain of facts rebuilt line by line without relying on the audit's
quotes, then the callers, the guards and the tests.

- 484 steps re-traced in the in-depth pass; 458 hold, 22 do not hold or could not be found in the
  copy (most of those are measurements or upstream files that are not in the repository).
- Final verdicts: 80 confirmed, 22 partly (the mechanism holds, the finding overstated something),
  2 that a copy of the code cannot settle, none refuted.
- Its corrections are quoted in each ticket, under "Counter-audit by a second model".

## Limits

- This first pass followed the paths that mattered in each area; it was not a line-by-line read.
  A second, exhaustive audit (every source file read line by line, in 74 blocks) started the same
  day; its reports will be added next to these.
- Frequencies are unknown: how often a job ends `completed` over a failed tool, how many failures
  stay silent on a messaging channel, how often the cache misses. Those need an install's data.
- Figures marked "computed, not measured" are arithmetic on earlier measurements. No gain is
  measured.
- PLAUSIBLE findings lack one link that needs a live run; each report says which.
- Auditors and orchestrator are models of one family; the counter-audit by another model is the
  answer to that, and it starts from the findings, so it cannot find what the audit missed.
