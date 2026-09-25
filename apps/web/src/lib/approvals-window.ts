// approvals-window.ts — how many approval requests one read returns.
//
// `listApprovalsAction` reads at most this many rows, newest first, and the
// rail's pending list (ApprovalsProvider) is one such read. A screen that
// infers "nothing changed" from that list must know it can be cut: past this
// many pending requests, an older one can be answered without the list
// changing (review of PR #482, Reviewer A). Kept out of actions.ts, a
// 'use server' file that may only export async functions.

export const APPROVALS_READ_LIMIT = 100;
