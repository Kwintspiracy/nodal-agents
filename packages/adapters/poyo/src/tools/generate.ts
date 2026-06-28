// @nodal-agents/adapter-poyo — image generation tool.
//
// One tool, `poyo_generate_image`, designed for "generate an image easily":
// it SUBMITS the job and POLLS the status endpoint internally until the task
// finishes, then returns the image URL(s). The agent calls one tool and gets a
// picture — it doesn't have to orchestrate the async submit/poll itself.
//
// Bounded poll: if the task hasn't finished after maxAttempts checks, the tool
// returns the task id with status 'running' instead of blocking forever — the
// agent can tell the user it's still processing. (Video, which takes minutes,
// is better served by a future suspend/resume flow; this tool targets images.)

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '@nodal-agents/tools';
import type { PoyoClient } from '../client.ts';
import { PoyoApiError, wrapPoyoError } from '../errors.ts';

const DEFAULT_MODEL = 'gpt-4o-image';
const DEFAULT_SIZE = '1:1';

/** Polling cadence for the submit→finish wait. */
export type PoyoPollConfig = {
  intervalMs: number;
  maxAttempts: number;
};

// ~3 min ceiling (45 × 4s) — generous for images, never unbounded.
const DEFAULT_POLL: PoyoPollConfig = { intervalMs: 4000, maxAttempts: 45 };

const GenerateImageInput = z.object({
  prompt: z.string().min(1).describe('Text description of the image to generate.'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Poyo image model id. Default "gpt-4o-image". Pass another Poyo image model id (see poyo.ai) to switch model.',
    ),
  size: z
    .string()
    .min(1)
    .optional()
    .describe('Aspect ratio of the image, e.g. "1:1", "16:9", "9:16", "4:3". Default "1:1".'),
});

export type GenerateImageOutput = {
  taskId: string;
  /** 'finished' when the image is ready; 'running' when the bounded poll timed out. */
  status: string;
  /** Image URL(s) — populated when status is 'finished'. */
  images: string[];
  model: string;
  /** Set only when the poll timed out, to explain the non-finished status. */
  note?: string;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function makePoyoGenerateImageTool(
  client: PoyoClient,
  poll: PoyoPollConfig = DEFAULT_POLL,
): ToolDefinition<typeof GenerateImageInput, GenerateImageOutput> {
  return {
    name: 'poyo_generate_image',
    description:
      'Generate an image from a text prompt using Poyo. Submits the job, waits for it to finish, and returns the resulting image URL(s). Use `model` to pick a Poyo image model (default gpt-4o-image) and `size` for the aspect ratio.',
    inputSchema: GenerateImageInput,
    riskLevel: 'write',
    async execute(input, _ctx: ToolContext) {
      const model = input.model ?? DEFAULT_MODEL;
      try {
        const taskId = await client.submit(model, {
          prompt: input.prompt,
          size: input.size ?? DEFAULT_SIZE,
        });

        for (let attempt = 0; attempt < poll.maxAttempts; attempt++) {
          const status = await client.status(taskId);
          if (status.status === 'finished') {
            return {
              taskId,
              status: 'finished',
              images: status.files.map((f) => f.url),
              model,
            };
          }
          if (status.status === 'failed') {
            throw new PoyoApiError(
              'poyo_generation_failed',
              `Poyo generation failed for task ${taskId}.`,
            );
          }
          await sleep(poll.intervalMs);
        }

        // Bounded poll exhausted — hand back the task id rather than hang.
        return {
          taskId,
          status: 'running',
          images: [],
          model,
          note: `Still processing after ${poll.maxAttempts} checks; the task can be polled again later with this task id.`,
        };
      } catch (err) {
        throw wrapPoyoError(err);
      }
    },
  };
}
