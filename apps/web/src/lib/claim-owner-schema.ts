// claim-owner-schema.ts — the input contract of the owner-claim form on the
// login page. Kept out of actions.ts (a 'use server' file can only export
// async functions) so a test can exercise the real schema, not a copy.
import { z } from 'zod';

export const ClaimOwnerSchema = z.object({
  email: z.string().trim().max(200).email(),
  password: z.string().min(8).max(200),
});
