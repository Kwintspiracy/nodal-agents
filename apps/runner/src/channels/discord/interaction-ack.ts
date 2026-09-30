// channels/discord/interaction-ack.ts — the DiscordInteractionAck of a live
// button interaction. Out of gateway.ts so the one rule it carries is tested
// without a discord.js client: an interaction has ONE initial response.

import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { DiscordInteractionAck } from './types.ts';

/** What the ack uses of a discord.js ButtonInteraction. */
export type AckableInteraction = Pick<
  ButtonInteraction,
  'deferred' | 'replied' | 'reply' | 'followUp' | 'update' | 'deferUpdate'
>;

export function makeDiscordInteractionAck(interaction: AckableInteraction): DiscordInteractionAck {
  return {
    async ephemeralReply(text: string): Promise<void> {
      // Déjà acquittée (deferUpdate, #637) : une interaction n'a qu'UNE
      // réponse initiale, la suite passe par un message de suivi.
      const payload = { content: text, flags: MessageFlags.Ephemeral } as const;
      await (
        interaction.deferred || interaction.replied
          ? interaction.followUp(payload)
          : interaction.reply(payload)
      ).catch(() => {});
    },
    async resolveCard(text: string): Promise<void> {
      await interaction.update({ content: text, components: [] }).catch(() => {});
    },
    async acknowledge(): Promise<void> {
      await interaction.deferUpdate().catch(() => {});
    },
  };
}
