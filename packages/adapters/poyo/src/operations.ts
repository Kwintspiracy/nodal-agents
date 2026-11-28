// @nodal-agents/adapter-poyo — operation descriptors.
// Each slug MUST match the tool name produced by createPoyoTools() exactly.
// Risk classification:
//   write — generation consumes Poyo credits / produces an artifact.

import type { OperationDescriptor } from '@nodal-agents/shared';

export const POYO_OPERATIONS: OperationDescriptor[] = [
  // ─── Write (1) ─────────────────────────────────────────────────────────────
  {
    slug: 'poyo_generate_image',
    name: 'Generate image',
    risk: 'write',
    requiresApproval: false,
    // The task is polled up to 45 times, 4 s apart, each request bounded at 30 s.
    timeBoundMs: 240_000,
    description:
      'Generate an image from a text prompt using Poyo. Submits the job, waits for it to finish, and returns the resulting image URL(s).',
  },
];
