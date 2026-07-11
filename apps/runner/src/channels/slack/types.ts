// channels/slack/types.ts — neutral shapes slack/handler.ts and
// slack/interactions.ts operate on. socket.ts adapts LIVE @slack/bolt
// event/action payloads into these before calling into the handler logic
// below — mirrors channels/discord/types.ts (see its file header for why):
// keeps the state-machine logic testable against plain objects without ever
// needing to construct a live Bolt App/event inside a unit test.

export interface SlackInboundMessage {
  /** The Slack conversation (DM `D...`, public channel `C...`, or private
   *  channel/MPIM `G...`) this message was sent in — the conversation id. */
  conversationId: string;
  /**
   * 'im' = a direct message; 'channel' = a public/private channel or MPIM.
   * Unlike Discord, Slack's OWN event routing already IS the mention gate for
   * channel-kind messages — socket.ts only ever constructs a 'channel'
   * SlackInboundMessage from an `app_mention` event (a plain channel message
   * with no mention never reaches the handler at all), so handler.ts never
   * needs to compute "was this a mention" itself the way Discord's does.
   */
  channelType: 'im' | 'channel';
  /** Raw text. For channelType 'channel' this still contains the literal
   *  `<@BOTID>` mention token — handler.ts strips it. */
  text: string;
  user: { id: string; bot: boolean; displayName: string };
}

export interface SlackInteractionAck {
  /**
   * Ephemeral reply visible only to the tapper — does NOT touch the original
   * card message. Used for security-gate denials and "already resolved" info,
   * mirroring DiscordInteractionAck.ephemeralReply.
   */
  ephemeralReply(text: string): Promise<void>;
  /**
   * Rewrite the card message to the resolved state (buttons stripped) —
   * mirrors DiscordInteractionAck.resolveCard. Slack's own `ack()` (required
   * within 3s of a block_actions payload) is handled separately by socket.ts
   * BEFORE this is ever called — it is not part of this neutral ack surface.
   */
  resolveCard(text: string): Promise<void>;
}
