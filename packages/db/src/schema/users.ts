// users + user_profiles tables
// NOTE: In Nodal-Agents we own our own users table (no Supabase auth.users).
// Foreign keys that legacy schema pointed at auth.users now point at users.id.
//
// name / emailVerified / image columns are added here for better-auth
// compatibility (local-auth provider). better-auth maps these via its
// schema.user.fields option. They default to safe values so existing rows
// are unaffected.

import { pgTable, text, uuid, timestamp, boolean } from 'drizzle-orm/pg-core';

// ─── users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  // better-auth fields (used when local-auth provider is active)
  name: text('name').notNull().default(''),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

// ─── user_profiles ────────────────────────────────────────────────────────────

export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  timezone: text('timezone').notNull().default('UTC'),
  locale: text('locale').notNull().default('en'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserProfileRow = typeof userProfiles.$inferSelect;
export type UserProfileInsert = typeof userProfiles.$inferInsert;
