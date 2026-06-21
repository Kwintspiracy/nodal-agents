// catalog/skills/telegram-responder.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const telegramResponderSkill: SystemSkill = {
  slug: 'telegram-responder',
  name: 'Telegram',
  description: 'How the agent must use and respond to Telegram',
  requiredBuiltins: [],
  kind: 'channel',
  content: `## 📨 Splitting rules — read this first

 ### When content fits in one Telegram message (≤4096 chars)

 Single call, same turn as return_result:

   [
     telegram_send_message({ chatId, text }),
     return_result({ status: "success" })
   ]

 ### When content exceeds 4096 chars — SAME-TURN MULTI-CALL REQUIRED

 You MUST split into multiple telegram_send_message calls IN THE SAME TURN.
 This is ENCOURAGED, not forbidden:

   [
     telegram_send_message({ chatId, text: part1_under_4096_chars }),
     telegram_send_message({ chatId, text: part2_under_4096_chars }),
     telegram_send_message({ chatId, text: part3_under_4096_chars }),
     return_result({ status: "success" })
   ]

 NEVER truncate or drop content to fit one message. If a sub-agent
 returned 6 chapters and only 1 fits in 4096 chars, you emit 6
 telegram_send_message calls in the same turn (one per chapter, or
 chunked logically). Drop nothing.

 ### What is FORBIDDEN — splitting across consecutive turns

 Calling telegram_send_message in turn N then again in turn N+1 (with no
 return_result in between) wastes input tokens (the runner re-prompts you
 to continue) and is fragile. The correct alternative is same-turn
 multi-call as shown above.

   Turn N:   telegram_send_message(...)
   Turn N+1: telegram_send_message(...)   ← WRONG: should have been in turn N
   Turn N+2: return_result(...)           ← WRONG: should have been in turn N


## Telegram delivery — mandatory rules

  If \`telegram_chat_id\` is present in Job context, **every word the user
  should see goes through \`telegram_send_message\`**. This is the ONLY
  channel that reaches them — your assistant text and \`return_result.text\`
  are silently discarded by the runner.

  No exceptions. This applies to:
  - Greetings, smalltalk, acknowledgments ("Salut !", "Pas de souci.")
  - Substantive answers (research, calculations, summaries)
  - Error messages and refusals ("Je ne peux pas faire ça parce que…")
  - Blocked / partial replies ("Je n'ai pas trouvé, peux-tu préciser ?")

  ### Same-turn pattern

  Always emit \`telegram_send_message\` and \`return_result\` **in parallel
  in the same assistant turn**:

  [
    telegram_send_message({ chatId, text }),
    return_result({ status: "success" })
  ]

  The runner deals with delivery failures automatically — if
  \`telegram_send_message\` errors, finalization is deferred and you get
  another turn to retry. Splitting into two sequential turns just doubles
  input token cost.

  ### Long answers

  Telegram caps messages at 4096 chars. If your reply exceeds that, split
  it into multiple \`telegram_send_message\` calls — still all in the same
  turn as the final \`return_result\`.

  ### Formatting

  - Markdown: Telegram supports MarkdownV2 sparingly. **bold** for emphasis,
    *italics* for nuance. Avoid heavy markdown.
  - Code blocks: triple backticks with a language tag (\`\`\`python, \`\`\`sql).
  - Emojis: 1–2 max per message, only when they add clarity (🔭 for
    cosmology, ⚙️ for settings). Never decorative.
  - Links: plain URLs are auto-linked. \`[text](url)\` for inline links.
  - Lists: prefer \`•\` or \`1.\` short items over verbose paragraphs.
  - Escape: in MarkdownV2 these need a backslash : \`*\` \`_\` \`[\` \`]\`
    \`(\` \`)\` \`~\` \`\` \` \`\` \`>\` \`#\` \`+\` \`-\` \`=\` \`|\` \`{\` \`}\` \`.\` \`!\`

 ### Brevity

 Default to scannable, structured replies — bullets + bold headers.
 Aim for <500 words ONLY when:
   - The user asks a yes/no or factual question
   - The user explicitly requests brevity ("courte", "résume", "TL;DR")
   - The content genuinely fits in one paragraph

 When the user asks for depth ("détaillé", "exhaustif", "récap complet",
 "5+ bullets", or any open-ended research question), prefer fidelity over
 brevity. Relay the sub-agent's full output, splitting via multiple
 telegram_send_message calls if needed (see Splitting rules above).

  ### Blocked case

  If the task can't be completed (missing info, tool error after retry,
  hard refusal), still emit \`telegram_send_message\` with a clear
  explanation, then \`return_result({ status: "blocked" })\` — never leave
  the user hanging on Telegram.`,
};
