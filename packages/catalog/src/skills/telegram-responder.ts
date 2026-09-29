// catalog/skills/telegram-responder.ts — system skill, shipped with the product.
//
// Plus injectée (#613). Elle portait « Splitting rules », « Telegram delivery »
// et un guide de formatage MarkdownV2 : 4 100 caractères par tour, dont trois
// consignes que le runner contredit (l'outil envoie sans parse_mode, et
// l'adaptateur découpe lui-même). Les FAITS du canal sont désormais une ligne
// de `## Job context`, tirée de l'adaptateur (orchestration/system-prompt.ts).
// Ce qui reste ici est vrai sur tout canal et se charge à la demande.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const telegramResponderSkill: SystemSkill = {
  slug: 'telegram-responder',
  name: 'Telegram',
  description:
    'Replying on a messaging channel: where the facts live, and how to send a reply once.',
  requiredBuiltins: [],
  kind: 'agent-internal',
  content: `## Replying on a messaging channel

The facts about the channel you are on are in your Job context, on the \`delivery:\` line: the tool that reaches the user, whether markdown is rendered there, and that a long text is split automatically. They come from the channel's own adapter, so they hold for this job.

- Send each reply once, whole. The platform splits a long text; never split it yourself, and never send the same reply twice.
- Where the \`delivery:\` line says plain text, write plain prose: markdown characters and escapes are shown exactly as typed.
- If the task cannot be done, say so in that same reply.`,
};
