// job_deliveries — l'outbox de la livraison (plan « Vérifier & Corriger »,
// « La livraison est une action sortante »).
//
// Envoyer un message à un canal (Telegram, Discord, Slack, WhatsApp) est une
// action SORTANTE : une fois partie, elle ne peut pas être annulée si elle a
// atteint le destinataire. Le job-loop ne l'appelle donc plus directement —
// il écrit une ligne `prepared` dans CETTE table (dans la même transaction
// que la finalisation du job, T09/finalizeJobSuccess), et un module séparé
// (`drainDeliveries`, T08) la réclame et l'envoie, hors transaction, avec ses
// propres retries et son propre budget de tentatives.
//
// `channel` est le canal de TRANSPORT réellement résolu (resolveTransportChannel
// + override notifyChannel), jamais `agent_jobs.channel` qui est une ORIGINE
// (d'où vient le job : cron, webhook, dashboard, mcp, …) — un job d'origine
// 'cron' peut très bien livrer sur 'telegram'. Seuls les quatre canaux à
// adaptateur d'envoi existent ici (pas 'api'/'internal'/'cron'/'dashboard'/…,
// qui ne savent pas recevoir de message).
//
// `payload` est le texte FIGÉ à envoyer, écrit une fois à la préparation —
// jamais relu depuis `agent_jobs.result` au moment du drain, qui pourrait
// avoir changé entre-temps.
//
// `idempotency_key` (UNIQUE) est la garde v6-A contre la double préparation :
// un composant qui tente de préparer deux fois la même livraison logique
// (même job, même canal, même chat, même tentative) se heurte à la
// contrainte — l'erreur remonte, jamais avalée.
//
// `claimed_by` / `claimed_at` sont écrits par le runner en JS au moment du
// claim (jamais DEFAULT now() : l'horodatage doit être celui de la tentative
// réelle, pas de l'insertion). `attempts <= 3` borne le nombre d'essais avant
// que le sweep (T08) bascule la ligne en 'rejected' et alerte le owner.
//
// L'index partiel `idx_job_deliveries_open` sert exactement la requête du
// drain (candidates encore ouvertes) sans balayer les lignes déjà `confirmed`
// ou `rejected`, qui dominent numériquement une fois le système en régime.
//
// Rétention (retention.ts) : supprimer un job de plus de RETENTION_DAYS
// supprime par CASCADE une ligne `prepared`/`attempted` jamais confirmée —
// comportement accepté, pas un bug (la livraison manquée ne peut de toute
// façon plus être retentée une fois le job lui-même purgé).

import { pgTable, text, uuid, integer, jsonb, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agentJobs } from './jobs.ts';

export const jobDeliveries = pgTable(
  'job_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    chatId: text('chat_id').notNull(),
    payload: text('payload').notNull(),
    outcome: text('outcome').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    receipt: jsonb('receipt'),
    attempts: integer('attempts').notNull().default(0),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_job_deliveries_open')
      .on(table.outcome, table.claimedAt)
      .where(sql`${table.outcome} IN ('prepared','attempted')`),
    check(
      'job_deliveries_channel_check',
      sql`${table.channel} IN ('telegram','discord','slack','whatsapp')`,
    ),
    check(
      'job_deliveries_outcome_check',
      sql`${table.outcome} IN ('prepared','attempted','confirmed','rejected')`,
    ),
    check('job_deliveries_attempts_check', sql`${table.attempts} <= 3`),
  ],
);

export type JobDeliveryRow = typeof jobDeliveries.$inferSelect;
export type JobDeliveryInsert = typeof jobDeliveries.$inferInsert;
