// send-orders.ts — finds the sentences that tell a model to deliver its answer
// through a channel send tool WITHOUT conditioning it on the job (#649).
//
// Where a job's reply goes is decided per job (`replyDestination`,
// job/channel-delivery.ts) and stated by the `delivery:` line of its Job
// context. A text shared by every job (a tool description, a system skill)
// that orders "deliver your answer with the send tool" contradicts that line on
// every job whose reply is its result: that order is how a request that came
// through MCP got its answer sent to the owner's Telegram.
//
// A sentence is an unconditional send order when it names a send tool (or
// "delivery tool" / "send tool") AND the answer / reply, and does not defer to
// the `delivery:` line, to a delegated sub-task, or to a separate message.

const SEND_TOOL = /telegram_send_message|send_image|send_file|delivery tool|send tool/i;
const ANSWER = /\b(answer|answers|reply|replies|deliverable|content delivery)\b/i;
const CONDITIONED = /`delivery:`|delivery: line|DELEGATED|delegated|separate message/;

export function unconditionalSendOrders(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => SEND_TOOL.test(s) && ANSWER.test(s) && !CONDITIONED.test(s));
}
