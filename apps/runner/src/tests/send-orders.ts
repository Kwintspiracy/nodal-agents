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
// "delivery tool" / "send tool") AND what the job produces (answer, reply,
// output, result, content, response, deliverable), unless it defers to the
// `delivery:` line or refuses the send through the tool. Nothing else
// whitelists a sentence: a word like "delegated" or "separate message" can sit
// in an order as well as in a condition (review of #657, pass 2).

const SEND_TOOL =
  /telegram_send_message|send_image|send_file|send_video|send_audio|send_voice|delivery tool|send tool/i;
const PRODUCT = /\b(answers?|repl(y|ies)|outputs?|results?|content|responses?|deliverables?)\b/i;
const DEFERS_TO_DELIVERY_LINE = /`delivery:`|\bdelivery: line\b/;
const REFUSES_THE_SEND =
  /\b(no|never|without)\s+(a\s+|any\s+)?(delivery|send) tool|\b(do not|don't|never)\s+(send|use|call)\b/i;

export function unconditionalSendOrders(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        SEND_TOOL.test(s) &&
        PRODUCT.test(s) &&
        !DEFERS_TO_DELIVERY_LINE.test(s) &&
        !REFUSES_THE_SEND.test(s),
    );
}
