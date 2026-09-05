// builtin/review-verdict.ts — the review_verdict built-in tool (étape C of
// the subscription-runtimes plan: the review loop as DATA).
//
// A REVIEWER agent (an ordinary agent whose skill gates this tool) calls it
// to emit a STRUCTURED verdict on a piece of code work. The tool is pure
// validation + normalization: it writes nothing, decides nothing, and the
// verdict travels back to the delegating coder through the ordinary
// delegation result path. Zod is the contract — a malformed verdict is
// rejected with a precise error the reviewer LLM can correct, never patched
// up silently (invariant #4).
//
// Gated via the "code-review" system skill's requiredBuiltins (invariants
// #1/#9) — only agents holding that skill can emit a verdict.

import { z } from 'zod';
import type { ToolDefinition } from '../types';

const findingSchema = z.object({
  file: z
    .string()
    .min(1)
    .max(500)
    .describe('Path of the file the finding is about, relative to the reviewed workspace.'),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based line number when the finding anchors to a specific line.'),
  issue: z
    .string()
    .min(1)
    .max(1000)
    .describe('The problem, stated concretely: what is wrong and what failure it can cause.'),
  severity: z
    .enum(['blocker', 'major', 'minor'])
    .describe(
      '"blocker": must be fixed before approval. "major": should be fixed now. ' +
        '"minor": advisory, may ship as-is.',
    ),
});

const reviewVerdictSchema = z
  .object({
    verdict: z
      .enum(['approve', 'request_changes'])
      .describe(
        '"approve": the work is correct and complete — it may be delivered. ' +
          '"request_changes": at least one finding must be addressed first.',
      ),
    summary: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "One short paragraph, in the OWNER'S language: what was reviewed, what evidence was " +
          'checked (files read, tests run), and why this verdict.',
      ),
    findings: z
      .array(findingSchema)
      .max(50)
      .default([])
      .describe(
        'Concrete findings with file (and line when possible). REQUIRED non-empty for ' +
          '"request_changes". With "approve", only "minor" advisory findings are allowed.',
      ),
  })
  .superRefine((val, ctx) => {
    if (val.verdict === 'request_changes' && val.findings.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message:
          'request_changes requires at least one finding — a rejection without a concrete, ' +
          'actionable finding is noise the coder cannot act on.',
      });
    }
    if (val.verdict === 'approve' && val.findings.some((f) => f.severity !== 'minor')) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message:
          'approve cannot carry blocker/major findings — either the finding matters (then ' +
          'request_changes) or it is advisory (then severity "minor").',
      });
    }
  });

export type ReviewVerdictInput = z.infer<typeof reviewVerdictSchema>;

export interface ReviewVerdictOutput {
  ok: true;
  verdict: 'approve' | 'request_changes';
  summary: string;
  findings: Array<{
    file: string;
    line?: number;
    issue: string;
    severity: 'blocker' | 'major' | 'minor';
  }>;
  /** Counts by severity — convenient for the coder and any UI rendering. */
  counts: { blocker: number; major: number; minor: number };
}

export const reviewVerdictTool: ToolDefinition<typeof reviewVerdictSchema, ReviewVerdictOutput> = {
  name: 'review_verdict',
  description:
    'Emit your STRUCTURED review verdict — the final act of a review task. Call it exactly once, ' +
    'after you have actually inspected the work (files read, evidence checked). ' +
    '"request_changes" requires concrete findings (file + issue + severity); "approve" means the ' +
    'work may be delivered as-is. After it succeeds, deliver the validated verdict back with ' +
    'return_result so the requesting agent receives it.',
  inputSchema: reviewVerdictSchema,
  riskLevel: 'read',
  card: 'checks',
  execute: (input) => {
    const counts = { blocker: 0, major: 0, minor: 0 };
    for (const f of input.findings) counts[f.severity] += 1;
    return Promise.resolve({
      ok: true as const,
      verdict: input.verdict,
      summary: input.summary,
      findings: input.findings,
      counts,
    });
  },
};
