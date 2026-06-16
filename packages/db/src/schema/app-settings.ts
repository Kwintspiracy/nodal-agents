// app_settings — machine-global key/value settings (one row per key), editable
// at runtime via the dashboard and read LIVE by the runner. Distinct from
// config.json (CLI-managed, restart-gated): these change without a restart.
//
// First use: operator-authored "install notes" injected into every agent's
// `## Runtime` block (system-prompt.ts) — machine-specifics the runtime can't
// auto-detect (e.g. "ComfyUI runs on :8188", local GPU, a local API path).

import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').default('').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AppSettingRow = typeof appSettings.$inferSelect;
