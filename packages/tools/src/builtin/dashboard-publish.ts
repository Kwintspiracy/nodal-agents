// Built-in: dashboard_publish
// Publishes the agent's text to agent_jobs.result for this job.
// Side-effect tool — the execute() function updates the DB directly,
// parallel to how telegram_send_message works for the Telegram surface.

import { z } from 'zod';
import { agentJobs, eq } from '@nodalai/db';
import type { ToolDefinition } from '../types';

export const DashboardPublishInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(50_000)
    .describe(
      "The text to display as this job's result in the dashboard. Markdown supported. Stored in agent_jobs.result.",
    ),
});

export type DashboardPublishInput = z.infer<typeof DashboardPublishInputSchema>;

export const dashboardPublishTool: ToolDefinition<
  typeof DashboardPublishInputSchema,
  { ok: true }
> = {
  name: 'dashboard_publish',
  description:
    "Publish the agent's answer to the dashboard. The text appears as the result in /jobs/<this-job> and as " +
    'the row preview on /jobs. Use this when the dashboard is the (or one of the) intended destination(s) for ' +
    'the user-facing output. For other surfaces, use the corresponding tool (telegram_send_message, etc.).' +
    '\n\n**Same-response with return_result (CRITICAL for cost & latency)**: ' +
    'Always emit dashboard_publish IN THE SAME response.content array as return_result. ' +
    'Splitting them across consecutive responses re-prompts the LLM unnecessarily and adds latency. ' +
    'Correct: response.content = [{tool-call: dashboard_publish, ...}, {tool-call: return_result, ...}].',
  inputSchema: DashboardPublishInputSchema,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    await ctx.db
      .update(agentJobs)
      .set({ result: input.text, updatedAt: new Date() })
      .where(eq(agentJobs.id, ctx.jobId));
    return { ok: true as const };
  },
};
