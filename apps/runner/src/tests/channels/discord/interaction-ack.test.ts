// interaction-ack.test.ts — une interaction Discord n'a qu'UNE réponse
// initiale (#637). Une carte d'approbation est acquittée (deferUpdate) AVANT la
// décision ; un refus qui suit (« Could not apply ») doit alors partir en
// message de suivi, sinon Discord le rejette et le propriétaire ne voit rien.

import { describe, it, expect } from 'vitest';
import { MessageFlags } from 'discord.js';
import {
  makeDiscordInteractionAck,
  type AckableInteraction,
} from '../../../channels/discord/interaction-ack.ts';

/** Un faux qui suit l'état qu'a une vraie interaction : deferUpdate la marque acquittée. */
function fakeInteraction() {
  const sent: Array<{ via: 'reply' | 'followUp'; content: string; ephemeral: boolean }> = [];
  const interaction = {
    deferred: false,
    replied: false,
    async reply(p: { content: string; flags: number }) {
      if (interaction.deferred || interaction.replied) throw new Error('InteractionAlreadyReplied');
      interaction.replied = true;
      sent.push({
        via: 'reply',
        content: p.content,
        ephemeral: p.flags === MessageFlags.Ephemeral,
      });
    },
    async followUp(p: { content: string; flags: number }) {
      sent.push({
        via: 'followUp',
        content: p.content,
        ephemeral: p.flags === MessageFlags.Ephemeral,
      });
    },
    async update() {},
    async deferUpdate() {
      interaction.deferred = true;
    },
  };
  return { interaction: interaction as unknown as AckableInteraction, sent };
}

describe('makeDiscordInteractionAck @cap:approuver-une-action/moteur', () => {
  it('before any acknowledgement, an ephemeral reply is the initial response', async () => {
    const { interaction, sent } = fakeInteraction();

    await makeDiscordInteractionAck(interaction).ephemeralReply('Not authorized.');

    expect(sent).toEqual([{ via: 'reply', content: 'Not authorized.', ephemeral: true }]);
  });

  it('after acknowledge (deferUpdate), an ephemeral reply goes out as a follow-up and still reaches the tapper', async () => {
    const { interaction, sent } = fakeInteraction();
    const ack = makeDiscordInteractionAck(interaction);

    await ack.acknowledge();
    await ack.ephemeralReply('Could not apply — try the dashboard.');

    expect(sent).toEqual([
      { via: 'followUp', content: 'Could not apply — try the dashboard.', ephemeral: true },
    ]);
  });
});
