// devices — the external modules of a workspace (#945, migration 0163).
//
// A device (a desktop companion, a speaker, a small robot, a piece of
// software) is a channel of Nodal: a request made on it is a turn of ITS
// conversation (`conversations.channel = 'device'`, `chat_id` = its id), and
// what that request asks back — a question, an approval, a preview — returns
// to it, on its own event stream.
//
// It belongs to a WORKSPACE, never to an agent: there is no per-agent binding
// (`channel_bindings`) and no per-conversation allowlist
// (`channel_allowed_conversations`) for it. This row IS its authorization: a
// chat id on channel `device` that names no row of the job's workspace reaches
// nobody (queries/devices.ts).
//
// The device tokens of #946 are added to this table; nothing here assumes
// them, so that issue only adds columns.

import { pgTable, text, uuid, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { DeviceCapability } from '@nodal-agents/shared';
import { entities } from './entities.ts';

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    /** The name the owner gives it. */
    name: text('name').notNull(),
    /** What the device DECLARES it can do: what is worth sending it
     *  (`DEVICE_CAPABILITIES`, @nodal-agents/shared — the CHECK below lists the same). */
    capabilities: text('capabilities')
      .array()
      .$type<DeviceCapability[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The last request that went through the device guard. NULL: never seen. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_devices_entity').on(table.entityId, table.createdAt),
    check('devices_name_check', sql`length(btrim(${table.name})) BETWEEN 1 AND 80`),
    check(
      'devices_capabilities_check',
      sql`${table.capabilities} <@ ARRAY['microphone','speaker','screen','buttons']::text[]`,
    ),
  ],
);

export type DeviceRow = typeof devices.$inferSelect;
