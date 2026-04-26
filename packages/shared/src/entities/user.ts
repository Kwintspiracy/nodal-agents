// User profile — per-auth-user metadata (display name, avatar, timezone, locale)
// Matches user_profiles table. The auth user itself lives in auth.users (Supabase-managed).

import { z } from 'zod';

export const UserProfileSchema = z
  .object({
    user_id: z.string().uuid(),
    display_name: z.string().max(120).nullable(),
    avatar_url: z.string().max(500).nullable(),
    timezone: z.string().max(80),
    locale: z.string().max(10),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const UserProfileInsertSchema = UserProfileSchema.omit({
  created_at: true,
  updated_at: true,
}).extend({
  display_name: z.string().max(120).nullable().optional(),
  avatar_url: z.string().max(500).nullable().optional(),
  timezone: z.string().max(80).default('UTC'),
  locale: z.string().max(10).default('en'),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;
export type UserProfileInsert = z.infer<typeof UserProfileInsertSchema>;
