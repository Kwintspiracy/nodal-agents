// interview.ts — the welcome interview of onboarding (step 4): what the agent
// asks, and where each answer is saved.
//
// Pure data, out of OnboardingFlow.tsx so the question list and the
// answer-to-memory mapping are tested together: the two must stay in step,
// question N's answer landing in INTERVIEW_MEMORY[N - 1].

export const DONE_MARKER = '[[INTERVIEW_DONE]]';

// The four things to capture, in order. The WEB saves the user's answers to
// memory: the chat surface only exposes run_task to the agent, so it can't call
// save_memory itself there. Index = number of answers the user has given.
//
// #986 — no "preferred language" any more (Quentin's decision, 2026-11-04): the
// agent replies in the language it is spoken to, and nothing else. The memory
// the interview used to write here, "Operator — preferred language: …", was
// measured as the trigger of French replies to English requests; migration
// 0162 archives the rows it left.
export const INTERVIEW_MEMORY: ReadonlyArray<{
  prefix: string;
  category: 'context' | 'preference';
}> = [
  { prefix: 'Operator — what to call them:', category: 'context' },
  { prefix: 'Operator — where they are based:', category: 'context' },
  { prefix: 'Operator — goal with Nodal-Agents / where they want help:', category: 'context' },
  { prefix: 'How the operator wants to work together:', category: 'preference' },
];

/** The answer that also drives the ROOT's autonomy: the last one. */
export const AUTONOMY_ANSWER_INDEX = INTERVIEW_MEMORY.length - 1;

// Hidden first message that drives the interview. The agent generates ALL of the
// wording; the web only sends this instruction and strips the DONE marker — so
// the runner stays silent (invariant 2). SHORT, plain text, one concrete
// question at a time, strictly NO task execution.
export const INTERVIEW_KICKOFF = `[Onboarding — your first meeting with your operator. Run a warm, BRIEF get-acquainted chat. Hard rules:
- Plain text ONLY. No markdown, no **bold**, no bullet points, no headings.
- Every message is 1-2 SHORT sentences. Warm but concise.
- Ask ONE short, concrete question per message. Never vague, never multi-part.
- This is NOT a work session: do NOT start, plan, or build anything. If they mention a task, warmly say you'll be ready once they're set up, then move on.

Ask these FOUR things, in order, one per message, no extras:
1. What to call them.
2. Where they're based.
3. Their goal with Nodal-Agents and where you can help most — just the gist, not specifics (you're not doing it now).
4. While carrying out their requests, whether you should run tools and commands on your own, or check with them for approval before acting.

Start now: one short friendly line (you just want to get to know them, no work yet) + question 1 ONLY. After each answer, a 3-5 word acknowledgement at most, then the next question. After the FOURTH answer, one short warm wrap-up line and end that final message with ${DONE_MARKER} on its own line.]`;

/** Where the answer given after `answerCount` earlier answers is saved; null past the last. */
export function interviewMemoryFor(
  answerCount: number,
  answer: string,
): { fact: string; category: 'context' | 'preference' } | null {
  const slot = INTERVIEW_MEMORY[answerCount];
  return slot ? { fact: `${slot.prefix} ${answer}`, category: slot.category } : null;
}
