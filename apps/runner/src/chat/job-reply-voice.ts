// chat/job-reply-voice.ts — la réponse d'un job lancé par la voix, DITE quand il finit (#967).
//
// Un tour vocal qui lance un travail dit son accusé, puis le job tourne — 68 s
// pour la recherche du propriétaire le 04/11 — et finissait en silence : la
// réponse était dans le fil, écrite, et rien ne disait qu'elle était là.
//
// LA RÈGLE. Un job qui finit (`completed`) avec une réponse, sans parent, et
// dont la réponse est DITE (`agent_jobs.reply_rendering = 'spoken'`, hérité du
// tour vocal, #958) : le runner la met en voix UNE fois, avec la voix de
// l'espace (`openReplyVoice`, la même porte que le tour et l'essai des
// réglages), phrase par phrase. Les mots sont ceux de l'agent, tels qu'en
// base, masqués de leurs secrets comme le `reply` de son `job.finished` :
// rien n'est écrit, coupé ni réécrit ici (invariants #2 et #3).
//
// La règle se lit sur les FAITS de la ligne, jamais sur le canal : un job
// tapé (chat écrit, Telegram, Slack, Discord, MCP, routine) porte `text`, un
// délégué a un parent. Aucun des deux ne passe par ici, et leur `job.finished`
// est celui d'avant, à l'octet.
//
// CE QUI N'EST PAS DIT, et pourquoi (invariant #2 : le runner n'écrit aucun mot
// pour la personne) :
//   - un job en ÉCHEC : son `job.failed` part comme toujours, l'explication
//     qu'il porte est rangée dans le fil, lue ; aucune annonce n'est inventée ;
//   - un job ARRÊTÉ (`cancelled`) : la personne a demandé l'arrêt ;
//   - un job fini SANS réponse (texte vide) : il n'y a rien à dire, rien ne
//     part.
//
// OÙ VA LA VOIX. Pas dans le flux des événements : chaque onglet ouvert sur
// l'espace recevrait des mégaoctets qu'il ne joue pas. Le flux porte un
// POINTEUR (`reply.audio`, juste après le `job.finished` du job), et la voix
// se lit sur `GET /api/voice/replies/:audioId` (routes/voice-reply.ts), par le
// même protocole que la fin d'un tour dit (`audio`, `audio_end`, `done`). Le
// tableau de bord et un module sans écran la lisent de la même façon (règle de
// #948).
//
// PERSONNE N'ÉCOUTE : rien n'est produit. Au moment où le job finit, le bus
// sait qui écoute sa conversation (`listenersOf`) ; à zéro, aucune voix n'est
// demandée au fournisseur, aucun `reply.audio` ne part, et rien n'est rejoué
// plus tard — la réponse est dans le fil, écrite. La voix produite est gardée
// `REPLY_AUDIO_KEEP_MS` après sa fin, pour un lecteur qui l'ouvre en retard
// (un onglet qui attend qu'une autre voix finisse, un module qui se
// reconnecte), puis oubliée.
//
// LA MESURE. Une ligne par réponse dite, des nombres et des identifiants
// seulement, jamais les mots : `[voice-job-reply] timing {…}`, en
// millisecondes depuis la fin du job (le COMMIT de son statut), jusqu'au
// premier octet de voix sorti et jusqu'au dernier.

import { randomUUID } from 'node:crypto';
import { splitSentences } from '@nodal-agents/speech';
import { redactSecretsInText } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import { jobEvents, type JobEventBus } from '../events/job-events.ts';
import type { FinishedJob } from '../events/publish.ts';
import { JOB_REPLY_TIMING_MARKS, createVoiceTiming, openReplyVoice } from './run-voice-turn.ts';

/** Un événement du flux de la voix, tel que `routes/voice-reply.ts` l'écrit. */
export interface ReplyAudioEvent {
  event: 'audio' | 'audio_end' | 'done';
  data: unknown;
}

interface ReplyAudio {
  entityId: string;
  /** Tout ce qui est sorti, dans l'ordre : un lecteur en retard le reçoit en entier. */
  events: ReplyAudioEvent[];
  /** `done` est sorti. */
  ended: boolean;
  readers: Set<(e: ReplyAudioEvent) => void>;
}

/** Combien de temps la voix finie reste lisible. */
export const REPLY_AUDIO_KEEP_MS = 120_000;

const replies = new Map<string, ReplyAudio>();

/**
 * Les mots à dire de ce job, ou `null` s'il ne parle pas : la règle de l'en-tête,
 * sur les faits de la ligne.
 */
export function spokenReplyOf(job: FinishedJob): string | null {
  if (job.status !== 'completed' || job.parentJobId !== null) return null;
  if (job.replyRendering !== 'spoken') return null;
  const text = redactSecretsInText(job.result ?? '').trim();
  return text === '' ? null : text;
}

function emitTo(reply: ReplyAudio, e: ReplyAudioEvent): void {
  reply.events.push(e);
  for (const read of reply.readers) {
    try {
      read(e);
    } catch {
      // Le lecteur est parti ; sa route le désinscrit elle-même.
    }
  }
}

/**
 * Le job vient de finir et son `job.finished` est parti. S'il parle et que
 * quelqu'un écoute, la voix démarre, et `reply.audio` part tout de suite
 * (avant la voix elle-même) : rend son identifiant. `null` : rien n'est dit.
 */
export function speakFinishedJob(
  db: RunnerDeps['db'],
  job: FinishedJob,
  opts: { bus?: JobEventBus; now?: () => number } = {},
): string | null {
  const bus = opts.bus ?? jobEvents;
  const now = opts.now ?? Date.now;
  const text = spokenReplyOf(job);
  if (text === null) return null;
  const endedAt = now();
  if (bus.listenersOf(job.entityId, job.conversationId) === 0) {
    console.warn(
      `[voice-job-reply] job ${job.jobId} ended with a spoken reply and no listener: not spoken`,
    );
    return null;
  }

  const audioId = randomUUID();
  const reply: ReplyAudio = {
    entityId: job.entityId,
    events: [],
    ended: false,
    readers: new Set(),
  };
  replies.set(audioId, reply);
  bus.publish(job.entityId, job.conversationId, {
    type: 'reply.audio',
    jobId: job.jobId,
    conversationId: job.conversationId,
    audioId,
  });

  const timing = createVoiceTiming(endedAt, now, 'voice-job-reply', JOB_REPLY_TIMING_MARKS);
  const emit = (event: string, data: unknown): void => {
    if (event === 'audio' || event === 'audio_end') emitTo(reply, { event, data });
  };
  void (async () => {
    let speechError: { code: string; detail?: string } | null = null;
    try {
      const opened = await openReplyVoice(db, job.entityId, emit, timing);
      if (opened.voice) {
        for (const sentence of splitSentences(text)) opened.voice.say(sentence);
        opened.voice.end();
        speechError = await opened.voice.done;
      } else {
        speechError = opened.unavailable;
      }
    } catch (err) {
      speechError = {
        code: 'speech_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (reply.events.some((e) => e.event === 'audio')) timing.mark('lastAudio');
    reply.ended = true;
    emitTo(reply, { event: 'done', data: { speechError } });
    reply.readers.clear();
    // `warn` : le canal des lignes de journal du runner, comme `[voice-turn]`.
    console.warn(timing.line());
    setTimeout(() => replies.delete(audioId), REPLY_AUDIO_KEEP_MS).unref?.();
  })();
  return audioId;
}

/**
 * Ouvre la voix `audioId` de l'espace `entityId` pour un lecteur : ce qui est
 * déjà sorti, puis le direct, atomiquement (rien ne tombe entre les deux).
 * `null` : elle n'existe pas, plus, ou pas dans cet espace — les trois
 * répondent pareil, l'existence d'une voix d'un autre espace ne se devine pas.
 */
export function openReplyAudio(
  audioId: string,
  entityId: string,
  read: (e: ReplyAudioEvent) => void,
): { replayed: readonly ReplyAudioEvent[]; ended: boolean; close: () => void } | null {
  const reply = replies.get(audioId);
  if (!reply || reply.entityId !== entityId) return null;
  const replayed = [...reply.events];
  if (reply.ended) return { replayed, ended: true, close: () => {} };
  reply.readers.add(read);
  return { replayed, ended: false, close: () => reply.readers.delete(read) };
}
