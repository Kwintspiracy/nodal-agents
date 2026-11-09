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
// Its KEY (#946, migration 0164): a device token, of which only the sha256 is
// kept (`token_hash`), handed over once at the end of a pairing
// (`device_pairings`). `revoked_at` refuses it from the next request on; a
// removed device stays here, so that its past conversation keeps its name.

import {
  pgTable,
  text,
  uuid,
  timestamp,
  index,
  check,
  integer,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
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
    /** sha256 (hex) of its device token. NULL: no key (not handed over yet, or removed). */
    tokenHash: text('token_hash'),
    /** Removed by the owner: its key is refused, its streams were closed. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** The address it paired from. NULL: it did not pair. */
    pairedFrom: text('paired_from'),
  },
  (table) => [
    index('idx_devices_entity').on(table.entityId, table.createdAt),
    uniqueIndex('devices_token_hash_unique')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} IS NOT NULL`),
    check('devices_name_check', sql`length(btrim(${table.name})) BETWEEN 1 AND 80`),
    check(
      'devices_capabilities_check',
      sql`${table.capabilities} <@ ARRAY['microphone','speaker','screen','buttons']::text[]`,
    ),
  ],
);

export type DeviceRow = typeof devices.$inferSelect;

/**
 * A pairing request (#946, migration 0164): a device that has no key yet asks
 * for one. It belongs to NO workspace until the owner confirms it from a
 * workspace's Devices page; confirming binds it there and creates the device.
 *   pending → confirmed → delivered (the token was handed over, once)
 *   pending → refused
 * A pending request past `expires_at` is expired, and purged later.
 */
export const devicePairings = pgTable(
  'device_pairings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** sha256 (hex) of the device code the device polls with. */
    deviceCodeHash: text('device_code_hash').notNull().unique(),
    /** Six digits the device shows or says. */
    userCode: text('user_code').notNull(),
    /** The name the device gives itself: TEXT, displayed as text. */
    name: text('name').notNull(),
    capabilities: text('capabilities')
      .array()
      .$type<DeviceCapability[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    protocolVersion: integer('protocol_version').notNull(),
    /** The address the request came from. */
    requestedFrom: text('requested_from').notNull(),
    status: text('status').$type<DevicePairingStatus>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
  },
  (table) => [
    index('idx_device_pairings_status').on(table.status, table.expiresAt),
    index('idx_device_pairings_from').on(table.requestedFrom, table.createdAt),
    check('device_pairings_user_code_check', sql`${table.userCode} ~ '^[0-9]{6}$'`),
    check('device_pairings_name_check', sql`length(btrim(${table.name})) BETWEEN 1 AND 60`),
    check(
      'device_pairings_capabilities_check',
      sql`${table.capabilities} <@ ARRAY['microphone','speaker','screen','buttons']::text[]`,
    ),
    check('device_pairings_protocol_version_check', sql`${table.protocolVersion} >= 1`),
    check(
      'device_pairings_status_check',
      sql`${table.status} IN ('pending','confirmed','refused','delivered')`,
    ),
    check(
      'device_pairings_confirmed_check',
      sql`(${table.status} IN ('confirmed','delivered')) = (${table.entityId} IS NOT NULL AND ${table.deviceId} IS NOT NULL AND ${table.conversationId} IS NOT NULL)`,
    ),
  ],
);

export type DevicePairingStatus = 'pending' | 'confirmed' | 'refused' | 'delivered';
export type DevicePairingRow = typeof devicePairings.$inferSelect;
