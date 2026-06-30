// catalog/skills/results-delivery.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent boots
// via the 'content_overridden' flag on the agent_skills row.
//
// WHY this exists: the orchestrator should NOT pre-decide HOW a result is
// structured or WHERE it's delivered — that drifts from the user's request. The
// "how to deliver here" lives in THIS skill, owned by the specialist. So a bare
// request like "research X" is enough: the specialist's own methodology handles
// the structure + delivery, without the orchestrator inventing it.

import type { SystemSkill } from '../types';

export const resultsDeliverySkill: SystemSkill = {
  slug: 'results-delivery',
  name: 'Results delivery',
  description:
    'Delivery methodology: structure a result clearly and deliver it to the right place, without the orchestrator having to spell it out.',
  kind: 'capability',
  requiredBuiltins: [],
  content: `Methodology for delivering a result. You own this skill: it's UP TO YOU to structure and deliver well — the orchestrator doesn't have to tell you. A simple "research X" is enough; you know how to present it.

## 1. Always produce AND hand off your result — never finish empty

A substantial task doesn't end on "I did the research" with nothing produced, nor on a result lost in a file. You MUST hand off your result. **But HOW you hand it off depends on your role:**

- **You are a delegated worker** (an orchestrator assigned you this task) → your delivery is a \`return_result\` with the **full content**. This hands control back to the orchestrator, who decides what comes next (move to another agent, combine, or deliver to the user). **Don't send ANYTHING to the user's channel yourself** (telegram/email): that would be a duplicate, and you'd step on the orchestrator.
- **You are user-facing** (autonomous/top-level job, or you ARE the orchestrator delivering the final answer) → structure it clearly and concisely (section 2) and deliver it to the right place (section 3).

A complete \`return_result\` is NOT "empty" — it's the RIGHT delivery when you're a worker. The only anti-pattern is finishing without a result, or losing it.

## 2. Structure clearly and concisely

- **The answer first**: lead with what matters (the conclusion, the figure, the requested list), not with preamble.
- **Short sections**: clear headings, key points, no wall of text.
- **Concise**: a sharp, dense deliverable beats an exhaustive slab. If it's long, put a summary at the top.
- Don't bury the answer in the middle of meta-commentary.

## 3. Deliver to the RIGHT place (when you're user-facing)

If — and ONLY if — you are the agent handing the answer to the user (not a delegated worker), pick the destination in this order:

1. **The destination the user named** in their request ("send it by email", "on Telegram", "into such-and-such vault") → use it. If it requires an address/identifier you don't have, check your memory/config; failing that, ask for it once.
2. **Otherwise, the conversation's channel**: if the request came from Telegram, pick the right delivery tool (ALWAYS pass a path/URL, never base64): \`telegram_send_message\` (text) · \`send_image\` (inline image) · \`send_video\` (video player) · \`send_audio\` (music player) · \`send_voice\` (OGG voice note) · \`send_file\` (ANY other file as an attachment — PDF, .md, .csv, .zip…; keep the extension in \`filename\`). If dashboard: \`dashboard_publish\` or \`return_result\`.

If you are a **delegated worker**, ignore this order: \`return_result\` with the full content, period — it's the orchestrator who will choose the channel (see section 1).

## 4. Don't reinvent the request

Your delivery methodology applies to **what the user asked for**, as-is. You decide the HOW (structure, channel); you don't decide the WHAT, nor add sub-topics they didn't ask for.

## Anti-patterns

- ❌ Finishing without producing a result ("research done" and stop).
- ❌ **A delegated worker sending its result straight to the user** (telegram/email) instead of \`return_result\`-ing it to its orchestrator → duplicate, and you short-circuit the rest of the chain.
- ❌ Burying the answer at the end of a long preamble.
- ❌ Saving to an obscure file instead of handing off the result.
- ❌ Asking "where do you want me to send it?" when the channel is obvious (the ongoing conversation).
- ✅ Worker → complete \`return_result\` to the parent. User-facing agent → clear answer up front, concise structure, the named channel or the conversation's channel.
`,
};
