// delivery/outbox.ts — la livraison canal comme action SORTANTE.
//
// Plan « Vérifier & Corriger », sections « La livraison est une action
// sortante — outbox », « Claim atomique » et « Drain immédiat, tick en
// reprise ».
//
// Le bug que ce module ferme est EXISTANT, pas hypothétique : aujourd'hui la
// finalisation d'un job écrit `status` + `completed_at` puis envoie au canal
// APRÈS le commit, sans qu'aucune colonne ne trace l'envoi. Un crash entre les
// deux laisse un job terminal qui ne sera JAMAIS relivré, puisque la garde de
// reprise (`completed_at IS NULL`) l'exclut désormais à jamais.
//
// Le remède est le modèle atomique : l'INTENTION de livrer est commise dans la
// même transaction que la décision terminale (`prepareDelivery` ⇒ ligne
// `prepared`), et l'ENVOI est une étape séparée, réclamable, bornée et
// reprenable (`drainDeliveries`). Un crash ne peut plus perdre la livraison :
// au pire, elle est reprise au tick suivant.
//
// Trois propriétés portent tout le reste :
//
//   1. **Claim atomique.** Une ligne n'est envoyée que par le runner qui a
//      gagné son `UPDATE … RETURNING`. Le prédicat du claim porte AUSSI la
//      borne de 3 tentatives (`attempts < 3`) et le lease, donc sous
//      concurrence `attempts` ne dépasse jamais 3 et deux drains simultanés ne
//      produisent jamais deux envois. Zéro ligne rendue ⇒ on passe, sans rien
//      supposer.
//
//   2. **Le timeout d'envoi est imposé ICI, et le lease en est DÉRIVÉ.** Les
//      adaptateurs n'ont pas de discipline commune (Telegram borne à 60 s un
//      document, WhatsApp attend `handle.send` sans borne, Discord laisse le
//      SDK dormir ses `retry_after`), donc l'outbox n'en dépend pas : chaque
//      envoi passe dans un `Promise.race` avec `DELIVERY_SEND_TIMEOUT_MS`, et
//      `LEASE_MS = 2 × ce timeout`. L'invariant « le lease est plus long que
//      l'envoi » est ainsi vrai PAR CONSTRUCTION et non par vigilance ; c'est
//      la raison pour laquelle le timeout est le SEUL paramètre injectable —
//      un second paramètre pour le lease les laisserait diverger.
//      240 s couvre le pire cas Telegram réel (30 s + 3 × 60 s de `retry_after`).
//
//   3. **Un `rejected` ne passe jamais en silence.** TOUTE transition vers
//      `rejected` — pas seulement l'épuisement des trois essais — alerte le
//      propriétaire. Le cas le plus silencieux est justement le refus
//      définitif au PREMIER essai : le job est `completed`, l'utilisateur n'a
//      rien reçu, et sans alerte personne ne l'apprend jamais (inv. #4).
//      L'alerte est un CODE et des données, jamais une phrase écrite par le
//      runner (inv. #2).
//
// Ce module ne tient AUCUNE transaction pendant un envoi : `idle_in_transaction
// _session_timeout` est à 60 s et un envoi peut légitimement durer 240 s.

import {
  and,
  eq,
  gte,
  lt,
  or,
  sql,
  agentJobs,
  jobDeliveries,
  getBindingCredentials,
  isConversationAllowed,
  resolveOwnerConversation,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  DeliveryError,
  getAdapter,
  listActiveChannelsForAgent,
  resolveTransportChannel,
} from '@nodal-agents/delivery';
import type { ChannelAdapter, ChannelKind } from '@nodal-agents/delivery';
import { runnerInstanceId } from '../runner-identity.ts';

// ─── Budgets ──────────────────────────────────────────────────────────────────

/**
 * Borne dure d'UN envoi, imposée par l'outbox et non par l'adaptateur.
 *
 * 240 s = le pire cas Telegram réellement atteignable : la requête elle-même
 * plus MAX_RATE_LIMIT_RETRIES (3) attentes de MAX_RETRY_AFTER_MS (60 s)
 * chacune. À 90 s, un envoi encore légitime serait déclaré orphelin puis
 * relivré — donc dupliqué, exactement ce que l'outbox existe pour empêcher.
 */
export const DELIVERY_SEND_TIMEOUT_MS = 240_000;

/**
 * Durée du bail de réclamation, TOUJOURS calculée à partir du timeout d'envoi
 * effectif de l'appel. Jamais une constante indépendante, jamais une seconde
 * option : c'est ce qui rend « le bail survit à l'envoi le plus long » vrai
 * par construction.
 */
function leaseMsFor(sendTimeoutMs: number): number {
  return 2 * sendTimeoutMs;
}

/** Plafond de tentatives, aussi porté par la contrainte CHECK de la table. */
const MAX_DELIVERY_ATTEMPTS = 3;

// ─── Codes journalisés ────────────────────────────────────────────────────────
//
// Des CODES et des données : rien ici n'est destiné à être lu tel quel par un
// utilisateur final (inv. #2).

const CODE_ORPHANED = 'DELIVERY_SEND_ORPHANED';
const CODE_TRANSIENT = 'DELIVERY_SEND_TRANSIENT';
const CODE_REJECTED = 'DELIVERY_REJECTED';
const CODE_NO_OWNER_CHAT = 'DELIVERY_ALERT_NO_OWNER_CHAT';
const CODE_ALERT_FAILED = 'DELIVERY_ALERT_SEND_FAILED';

/**
 * Erreurs de canal qu'il est inutile de retenter : le message ne partira
 * jamais tant que la configuration n'a pas changé. Tout le RESTE est traité
 * comme transitoire et repasse par le lease — un `rejected` prématuré perd un
 * message, une reprise inutile coûte trois essais et finit de toute façon en
 * `rejected` + alerte via le sweep.
 */
const DEFINITIVE_DELIVERY_ERROR_CODES: ReadonlySet<string> = new Set([
  'telegram_unauthorized',
  'telegram_chat_not_found',
  'channel_adapter_not_found',
]);

// ─── Types publics ────────────────────────────────────────────────────────────

/** Le seul geste que l'outbox demande à un canal. */
export type DeliverySender = Pick<ChannelAdapter, 'sendText'>;

/** Résolution d'adaptateur, injectable pour que les tests n'ouvrent aucune
 *  socket. Par défaut : le registre réel, qui lève `channel_adapter_not_found`
 *  plutôt que de rendre un adaptateur par défaut. */
export type AdapterResolver = (channel: ChannelKind) => DeliverySender;

export interface OutboxOptions {
  /** Identité du processus qui réclame. Par défaut celle du boot. */
  runnerInstanceId?: string;
  /** Horloge de référence — l'injecter rend les tests de bail déterministes. */
  now?: Date;
  /** Borne dure d'un envoi ; le bail en est dérivé (2 ×). */
  sendTimeoutMs?: number;
  adapters?: AdapterResolver;
}

export interface DrainDeliveriesOptions extends OutboxOptions {
  /** Restreint le drain aux livraisons d'UN job : c'est le drain immédiat que
   *  chaque chemin terminal déclenche après son commit. Absent = le drain de
   *  reprise du tick, sur toutes les livraisons ouvertes. */
  jobId?: string;
}

export interface DrainResult {
  /** Livraisons passées à `confirmed` pendant ce drain. */
  sent: number;
  /** Livraisons passées à `rejected` pendant ce drain. */
  rejected: number;
  /** Candidates vues mais non réclamées (un autre runner, ou borne atteinte),
   *  plus celles laissées en `attempted` pour reprise. */
  skipped: number;
}

export interface PrepareDeliveryInput {
  jobId: string;
  channel: ChannelKind;
  chatId: string;
  /** Le texte FIGÉ. Jamais relu depuis `agent_jobs.result` au drain : entre la
   *  décision et l'envoi, le résultat peut avoir changé. */
  payload: string;
  /** Par défaut `deliveryIdempotencyKey(jobId, channel, chatId)`. */
  idempotencyKey?: string;
}

/** Ce que la table garde d'un envoi. `messageId: null` + `reason` quand le
 *  canal a bien accusé réception sans rendre d'identifiant. */
export interface DeliveryReceipt {
  messageId: string | null;
  reason?: string;
}

// ─── prepareDelivery ──────────────────────────────────────────────────────────

/**
 * Clé d'idempotence d'une livraison logique. Le suffixe `:1` est le numéro de
 * PRÉPARATION, pas de tentative : les reprises réutilisent la MÊME clé, ce qui
 * est précisément ce qui permet à un canal qui la comprend de ne pas doubler.
 */
export function deliveryIdempotencyKey(
  jobId: string,
  channel: ChannelKind,
  chatId: string,
  preparation = 1,
): string {
  return `${jobId}:${channel}:${chatId}:${preparation}`;
}

/**
 * Écrit l'INTENTION de livrer, dans la transaction fournie par l'appelant —
 * celle qui commet le statut terminal. C'est tout l'intérêt : la décision et
 * l'intention de la dire tombent ensemble, ou pas du tout.
 *
 * La contrainte UNIQUE sur `idempotency_key` est la garde contre la double
 * préparation. Une clé déjà présente fait échouer l'INSERT ; l'erreur remonte
 * à l'appelant et roule sa transaction — elle n'est jamais avalée ici, parce
 * qu'une double préparation signifie que deux chemins croient tous les deux
 * finaliser le même job, ce qui est un bug à voir, pas à absorber (inv. #4).
 *
 * Le payload n'est PAS validé : un appelant qui n'a rien à livrer ne prépare
 * rien. Lever ici sur un texte vide roulerait la finalisation du job entière,
 * ce qui punirait le job pour un défaut de livraison.
 */
export async function prepareDelivery(
  tx: AnyDrizzleDb,
  input: PrepareDeliveryInput,
): Promise<{ id: string }> {
  const rows = await tx
    .insert(jobDeliveries)
    .values({
      jobId: input.jobId,
      channel: input.channel,
      chatId: input.chatId,
      payload: input.payload,
      outcome: 'prepared',
      idempotencyKey:
        input.idempotencyKey ?? deliveryIdempotencyKey(input.jobId, input.channel, input.chatId),
      attempts: 0,
    })
    .returning({ id: jobDeliveries.id });

  const row = rows[0];
  if (!row) throw new Error('DELIVERY_PREPARE_NO_ROW');
  return row;
}

// ─── drainDeliveries ──────────────────────────────────────────────────────────

interface ClaimedDelivery {
  id: string;
  jobId: string;
  channel: string;
  chatId: string;
  payload: string;
  attempts: number;
}

/**
 * Réclame et envoie les livraisons ouvertes.
 *
 * Appelé DEUX fois pour la même ligne, dans deux rôles différents :
 *   - juste après le commit terminal, avec `jobId` — c'est lui qui donne au
 *     chemin interactif la latence d'aujourd'hui (un envoi dans la seconde,
 *     pas au prochain tick de 120 s) ;
 *   - depuis le tick, sans `jobId` — reprise seule : ce que le drain immédiat
 *     n'a pas confirmé parce que le processus est mort ou que l'envoi a
 *     dépassé son bail.
 *
 * Aucune transaction n'est tenue pendant un envoi.
 */
export async function drainDeliveries(
  db: AnyDrizzleDb,
  opts: DrainDeliveriesOptions = {},
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const sendTimeoutMs = opts.sendTimeoutMs ?? DELIVERY_SEND_TIMEOUT_MS;
  const cutoff = new Date(now.getTime() - leaseMsFor(sendTimeoutMs));
  const claimedBy = opts.runnerInstanceId ?? runnerInstanceId;
  const resolveAdapter = opts.adapters ?? getAdapter;

  // Le prédicat d'ouverture, écrit UNE fois et réutilisé tel quel par le
  // claim : le SELECT ne fait que borner le balayage, c'est le claim qui
  // décide. Les deux DOIVENT porter la même condition — un claim plus laxiste
  // que le SELECT rendrait `attempts < 3` et le bail décoratifs.
  const openForClaim = and(
    lt(jobDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
    or(
      eq(jobDeliveries.outcome, 'prepared'),
      and(eq(jobDeliveries.outcome, 'attempted'), lt(jobDeliveries.claimedAt, cutoff)),
    ),
  );

  const candidates = await db
    .select({ id: jobDeliveries.id })
    .from(jobDeliveries)
    .where(opts.jobId ? and(eq(jobDeliveries.jobId, opts.jobId), openForClaim) : openForClaim);

  const result: DrainResult = { sent: 0, rejected: 0, skipped: 0 };

  for (const candidate of candidates) {
    const claimed = await db
      .update(jobDeliveries)
      .set({
        outcome: 'attempted',
        claimedBy,
        claimedAt: now,
        attempts: sql`${jobDeliveries.attempts} + 1`,
        updatedAt: now,
      })
      .where(and(eq(jobDeliveries.id, candidate.id), openForClaim))
      .returning({
        id: jobDeliveries.id,
        jobId: jobDeliveries.jobId,
        channel: jobDeliveries.channel,
        chatId: jobDeliveries.chatId,
        payload: jobDeliveries.payload,
        attempts: jobDeliveries.attempts,
      });

    const row: ClaimedDelivery | undefined = claimed[0];
    if (!row) {
      // Un autre runner l'a réclamée entre le SELECT et l'UPDATE, ou la borne
      // de 3 est atteinte. Les deux se traitent pareil : on passe.
      result.skipped += 1;
      continue;
    }

    const outcome = await attemptOneDelivery(db, row, {
      now,
      sendTimeoutMs,
      resolveAdapter,
    });

    if (outcome.kind === 'confirmed') result.sent += 1;
    else if (outcome.kind === 'rejected') result.rejected += 1;
    else result.skipped += 1;
  }

  return result;
}

type AttemptOutcome = { kind: 'confirmed' } | { kind: 'rejected' } | { kind: 'retryable' };

async function attemptOneDelivery(
  db: AnyDrizzleDb,
  row: ClaimedDelivery,
  ctx: { now: Date; sendTimeoutMs: number; resolveAdapter: AdapterResolver },
): Promise<AttemptOutcome> {
  // L'agent porte à la fois l'allowlist et les credentials — sans lui, rien
  // n'est vérifiable ni envoyable.
  const jobRows = await db
    .select({ agentId: agentJobs.agentId, entityId: agentJobs.entityId })
    .from(agentJobs)
    .where(eq(agentJobs.id, row.jobId))
    .limit(1);
  const job = jobRows[0];

  if (!job?.agentId) {
    await rejectDelivery(db, row, 'job_unresolved', ctx.now, ctx.resolveAdapter);
    return { kind: 'rejected' };
  }
  const agentId = job.agentId;

  // L'allowlist se revérifie ICI, juste avant l'envoi — jamais à la
  // préparation : un chat peut avoir été révoqué entre-temps, et c'est ce
  // point-ci qui est le site d'envoi.
  const allowed =
    job.entityId !== null &&
    (await isConversationAllowed(db, {
      entityId: job.entityId,
      agentId,
      channel: row.channel,
      conversationId: row.chatId,
    }));
  if (!allowed) {
    await rejectDelivery(db, row, 'allowlist_refused', ctx.now, ctx.resolveAdapter);
    return { kind: 'rejected' };
  }

  // Relues à chaque tentative et jamais écrites en base : aucune credential ne
  // traverse `job_deliveries`.
  const creds = await getBindingCredentials(db, agentId, row.channel);
  if (!creds) {
    // Permanent tant que l'agent n'est pas reconnecté à ce canal : retenter
    // trois fois n'y changerait rien et retarderait l'alerte.
    await rejectDelivery(db, row, 'no_credentials', ctx.now, ctx.resolveAdapter);
    return { kind: 'rejected' };
  }

  const sent = await sendWithTimeout(
    () => ctx.resolveAdapter(row.channel as ChannelKind).sendText(creds, row.chatId, row.payload),
    ctx.sendTimeoutMs,
  );

  if (sent.kind === 'timeout') {
    // L'envoi peut encore aboutir dans le dos du processus — on ne peut ni le
    // confirmer ni l'annuler. La ligne reste `attempted` : elle sera reprise
    // après le bail, avec la MÊME clé d'idempotence.
    console.error(
      `[outbox] ${CODE_ORPHANED} delivery=${row.id} job=${row.jobId} channel=${row.channel} ` +
        `attempts=${row.attempts} timeout_ms=${ctx.sendTimeoutMs}`,
    );
    return { kind: 'retryable' };
  }

  if (sent.kind === 'error') {
    const code = sent.error instanceof DeliveryError ? sent.error.code : 'unknown_error';
    if (DEFINITIVE_DELIVERY_ERROR_CODES.has(code)) {
      await rejectDelivery(db, row, code, ctx.now, ctx.resolveAdapter);
      return { kind: 'rejected' };
    }
    console.warn(
      `[outbox] ${CODE_TRANSIENT} delivery=${row.id} job=${row.jobId} channel=${row.channel} ` +
        `attempts=${row.attempts} code=${code}`,
    );
    return { kind: 'retryable' };
  }

  // L'appel a résolu sans erreur : c'est l'accusé de réception, même quand le
  // canal ne rend pas d'identifiant (Telegram rend '0' quand `message_id` est
  // absent, WhatsApp la chaîne vide). Laisser la ligne en `attempted` pour un
  // identifiant manquant la ferait reprendre après le bail et livrerait le
  // message une seconde fois — un doublon garanti pour un champ décoratif.
  const messageId = sent.result.messageId;
  const receipt: DeliveryReceipt =
    messageId === '' || messageId === '0'
      ? { messageId: null, reason: 'no_id_returned' }
      : { messageId };

  await db
    .update(jobDeliveries)
    .set({ outcome: 'confirmed', receipt, updatedAt: ctx.now })
    .where(eq(jobDeliveries.id, row.id));

  return { kind: 'confirmed' };
}

// ─── sweepExhaustedDeliveries ─────────────────────────────────────────────────

export interface SweepResult {
  rejected: number;
}

/**
 * Ferme les livraisons qui ont brûlé leurs trois tentatives et dont le bail a
 * expiré : plus personne ne les enverra (le claim exige `attempts < 3`), donc
 * les laisser en `attempted` serait un mensonge tranquille.
 *
 * Le bail est exigé en plus de la borne : une ligne à `attempts = 3` dont le
 * bail court est peut-être en cours d'envoi à cet instant même.
 */
export async function sweepExhaustedDeliveries(
  db: AnyDrizzleDb,
  opts: OutboxOptions = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const sendTimeoutMs = opts.sendTimeoutMs ?? DELIVERY_SEND_TIMEOUT_MS;
  const cutoff = new Date(now.getTime() - leaseMsFor(sendTimeoutMs));

  const rows = await db
    .update(jobDeliveries)
    .set({
      outcome: 'rejected',
      receipt: { messageId: null, reason: 'attempts_exhausted' } satisfies DeliveryReceipt,
      updatedAt: now,
    })
    .where(
      and(
        eq(jobDeliveries.outcome, 'attempted'),
        gte(jobDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
        lt(jobDeliveries.claimedAt, cutoff),
      ),
    )
    .returning({
      id: jobDeliveries.id,
      jobId: jobDeliveries.jobId,
      channel: jobDeliveries.channel,
      attempts: jobDeliveries.attempts,
    });

  for (const row of rows) {
    await alertOwnerOfRejection(db, {
      deliveryId: row.id,
      jobId: row.jobId,
      channel: row.channel,
      attempts: row.attempts,
      reason: 'attempts_exhausted',
      adapters: opts.adapters,
    });
  }

  return { rejected: rows.length };
}

// ─── Rejet + alerte ───────────────────────────────────────────────────────────

/**
 * Pose `rejected` ET alerte, toujours ensemble. Les deux gestes ne sont pas
 * séparables : un `rejected` sans alerte est le cas le plus silencieux du
 * système (le job est `completed`, l'utilisateur n'a rien reçu, rien ne le
 * dit).
 */
async function rejectDelivery(
  db: AnyDrizzleDb,
  row: ClaimedDelivery,
  reason: string,
  now: Date,
  adapters?: AdapterResolver,
): Promise<void> {
  await db
    .update(jobDeliveries)
    .set({
      outcome: 'rejected',
      receipt: { messageId: null, reason } satisfies DeliveryReceipt,
      updatedAt: now,
    })
    .where(eq(jobDeliveries.id, row.id));

  await alertOwnerOfRejection(db, {
    deliveryId: row.id,
    jobId: row.jobId,
    channel: row.channel,
    attempts: row.attempts,
    reason,
    adapters,
  });
}

interface RejectionAlert {
  deliveryId: string;
  jobId: string;
  channel: string;
  attempts: number;
  reason: string;
  adapters?: AdapterResolver;
}

/**
 * Prévient le propriétaire de l'agent qu'un résultat n'atteindra pas son
 * destinataire. Le message est un CODE et des données (inv. #2) — le runner ne
 * met aucune phrase dans la bouche de l'agent.
 *
 * Une alerte qui n'aboutit pas est journalisée puis abandonnée : elle ne doit
 * jamais faire échouer le drain, sinon la ligne resterait réclamable et le
 * message d'origine repartirait en boucle.
 */
async function alertOwnerOfRejection(db: AnyDrizzleDb, alert: RejectionAlert): Promise<void> {
  const body =
    `${CODE_REJECTED} job=${alert.jobId} delivery=${alert.deliveryId} ` +
    `channel=${alert.channel} attempts=${alert.attempts} reason=${alert.reason}`;

  try {
    const jobRows = await db
      .select({ agentId: agentJobs.agentId })
      .from(agentJobs)
      .where(eq(agentJobs.id, alert.jobId))
      .limit(1);
    const agentId = jobRows[0]?.agentId;
    if (!agentId) {
      console.error(`[outbox] ${CODE_NO_OWNER_CHAT} ${body} cause=no_agent`);
      return;
    }

    // Même règle que les autres notifications adressées au propriétaire : un
    // déclencheur n'est pas un transport, le canal se résout depuis les canaux
    // réellement actifs de l'agent. Le CANAL D'ABORD, puis la conversation du
    // propriétaire SUR CE CANAL — jamais `resolveOwnerChatId`, épinglé
    // Telegram : un agent dont le token Telegram a été effacé et dont seul
    // Discord est actif enverrait sinon un chat id Telegram vers Discord
    // (trou relevé en revue de T08 ; run-schedules.ts le porte encore).
    const activeChannels = await listActiveChannelsForAgent(db, agentId);
    const alertChannel = resolveTransportChannel('cron', activeChannels);
    const ownerChatId = await resolveOwnerConversation(db, agentId, alertChannel);
    if (!ownerChatId) {
      console.error(
        `[outbox] ${CODE_NO_OWNER_CHAT} ${body} cause=no_owner channel=${alertChannel}`,
      );
      return;
    }
    const creds = await getBindingCredentials(db, agentId, alertChannel);
    if (!creds) {
      console.error(`[outbox] ${CODE_NO_OWNER_CHAT} ${body} cause=no_credentials`);
      return;
    }

    const adapter = (alert.adapters ?? getAdapter)(alertChannel);
    await adapter.sendText(creds, ownerChatId, body);
  } catch (err) {
    console.error(
      `[outbox] ${CODE_ALERT_FAILED} ${body} cause=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Envoi borné ──────────────────────────────────────────────────────────────

type SendOutcome =
  | { kind: 'sent'; result: { messageId: string } }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

/**
 * Enveloppe un envoi dans une borne dure.
 *
 * `Promise.race` et non `AbortController` : aucun adaptateur n'accepte de
 * signal (`sendText(creds, conversationId, text, opts?)` où `opts` ne porte
 * qu'un format). L'envoi dépassé continue donc sa vie dans le vide — c'est
 * assumé et journalisé par l'appelant sous `DELIVERY_SEND_ORPHANED`, jamais
 * silencieux.
 *
 * La promesse d'envoi est convertie en valeur AVANT la course : ainsi un rejet
 * tardif, après que la course a été gagnée par le timeout, ne remonte pas en
 * `unhandledRejection` et ne tue pas le processus.
 */
async function sendWithTimeout(
  send: () => Promise<{ messageId: string }>,
  timeoutMs: number,
): Promise<SendOutcome> {
  const attempt: Promise<SendOutcome> = (async () => {
    try {
      return { kind: 'sent', result: await send() };
    } catch (error) {
      return { kind: 'error', error };
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<SendOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });

  try {
    return await Promise.race([attempt, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
