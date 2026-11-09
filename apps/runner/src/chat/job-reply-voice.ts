// chat/job-reply-voice.ts — ce que l'agent DIT quand un job lancé par la voix finit (#967).
//
// Un tour vocal qui lance un travail dit son accusé, puis le job tourne — 68 s
// pour la recherche du propriétaire le 04/11 — et finissait en silence : le
// résultat était dans le fil, écrit, et rien ne disait qu'il était là.
//
// LA RÈGLE DU PROPRIÉTAIRE (04/11). Un job lancé par la voix finit par DEUX
// choses, écrites l'une et l'autre par l'agent : son RÉSULTAT, écrit pour être
// lu, inchangé sur toute surface ; et une ANNONCE courte, écrite pour
// l'oreille — un résultat court est simplement dit, un document n'est jamais
// lu à voix haute : l'annonce dit qu'il est prêt, où le lire, et propose de
// l'envoyer sur un canal où la personne est joignable
// (packages/orchestration/src/spoken-announcement.ts).
//
// QUI PARLE. Un job qui finit (`completed`) avec un résultat, sans parent, et
// né d'une demande DITE (`agent_jobs.reply_rendering = 'spoken'`, hérité du
// tour vocal, #958). La règle se lit sur les FAITS de la ligne, jamais sur le
// canal : un job tapé (chat écrit, Telegram, Slack, Discord, MCP, routine)
// porte `text`, un délégué a un parent. Aucun ne passe par ici, et leur
// `job.finished` est celui d'avant, à l'octet.
//
// CE QUI N'EST PAS DIT, et pourquoi (invariant #2 : le runner n'écrit aucun mot
// pour la personne) :
//   - un job en ÉCHEC : son `job.failed` part comme toujours, l'explication
//     qu'il porte est rangée dans le fil, lue ; aucune annonce n'est inventée ;
//   - un job ARRÊTÉ (`cancelled`) : la personne a demandé l'arrêt ;
//   - un job fini SANS résultat (texte vide) : il n'y a rien à annoncer.
//
// LE CHEMIN. Au `job.finished`, le pointeur `reply.audio` part tout de suite ;
// puis l'agent écrit son annonce (`writeJobAnnouncement`, une génération
// courte), rangée sur la ligne (`agent_jobs.spoken_announcement`), puis dite
// UNE fois avec la voix de l'espace (`openReplyVoice`, la porte du tour et de
// l'essai des réglages), phrase par phrase. Ce qui est dit est l'annonce telle
// que l'agent l'a écrite, masquée de ses secrets ; rien n'est coupé, réécrit
// ni choisi ici.
//
// OÙ VA LA VOIX. Pas dans le flux des événements : chaque onglet ouvert sur
// l'espace recevrait des mégaoctets qu'il ne joue pas. Le flux porte le
// POINTEUR, et la voix se lit sur `GET /api/voice/replies/:audioId`
// (routes/voice-reply.ts), par le même protocole que la fin d'un tour dit
// (`audio`, `audio_end`, `done`). Le tableau de bord et un module sans écran
// la lisent de la même façon (règle de #948).
//
// PERSONNE N'ÉCOUTE : rien n'est produit. Au moment où le job finit, le bus
// sait qui écoute sa conversation (`listenersOf`) ; à zéro, aucune annonce
// n'est écrite, aucune voix demandée, aucun `reply.audio` ne part, et rien
// n'est rejoué plus tard — le résultat est dans le fil, écrit. La voix
// produite est gardée `REPLY_AUDIO_KEEP_MS` après sa fin, pour un lecteur qui
// l'ouvre en retard (un onglet qui attend qu'une autre voix finisse, un module
// qui se reconnecte), puis oubliée.
//
// LA MESURE. Une ligne par annonce dite, des nombres et des identifiants
// seulement, jamais les mots : `[voice-job-reply] timing {…}`, en
// millisecondes depuis la fin du job (le COMMIT de son statut) : l'annonce
// écrite, puis le premier et le dernier octet de voix sortis.

import { randomUUID } from 'node:crypto';
import { agentJobs, eq } from '@nodal-agents/db';
import { splitSentences } from '@nodal-agents/speech';
import { redactSecretsInText } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import { jobEvents, type JobEventBus } from '../events/job-events.ts';
import type { FinishedJob } from '../events/publish.ts';
import { makeLlmCallSink } from '../llm/call-sink.ts';
import { writeJobAnnouncement } from './job-announcement.ts';
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

/** Ce job finit-il par une annonce dite ? La règle de l'en-tête, sur les faits de la ligne. */
export function announcesItsEnd(job: FinishedJob): boolean {
  return (
    job.status === 'completed' &&
    job.parentJobId === null &&
    job.replyRendering === 'spoken' &&
    (job.result ?? '').trim() !== ''
  );
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
 * Le job vient de finir et son `job.finished` est parti. S'il s'annonce et que
 * quelqu'un écoute, `reply.audio` part tout de suite (avant l'annonce même),
 * puis l'annonce s'écrit et se dit : rend son identifiant. `null` : rien n'est
 * dit.
 */
export function speakFinishedJob(
  db: RunnerDeps['db'],
  job: FinishedJob,
  opts: { bus?: JobEventBus; now?: () => number } = {},
): string | null {
  const bus = opts.bus ?? jobEvents;
  const now = opts.now ?? Date.now;
  if (!announcesItsEnd(job)) return null;
  const endedAt = now();
  if (bus.listenersOf(job.entityId, job.conversationId, job.deviceId) === 0) {
    console.warn(
      `[voice-job-reply] job ${job.jobId} ended with a spoken request and no listener: nothing said`,
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
  // L'appareil d'où vient la demande (#945) l'entend sur son flux, comme le
  // tableau de bord l'entend sur le sien.
  bus.publish(
    job.entityId,
    job.conversationId,
    { type: 'reply.audio', jobId: job.jobId, conversationId: job.conversationId, audioId },
    job.deviceId,
  );

  const timing = createVoiceTiming(endedAt, now, 'voice-job-reply', JOB_REPLY_TIMING_MARKS);
  const emit = (event: string, data: unknown): void => {
    if (event === 'audio' || event === 'audio_end') emitTo(reply, { event, data });
  };
  void (async () => {
    let said: string | null = null;
    let speechError: { code: string; detail?: string } | null = null;
    try {
      const announcement = await writeJobAnnouncement(db, job.jobId, {
        observe: makeLlmCallSink(db, {
          source: 'announcement',
          entityId: job.entityId,
          getJobId: () => job.jobId,
          conversationId: job.conversationId,
        }),
      });
      timing.mark('announcement');
      if (!announcement.ok) {
        speechError = {
          code: announcement.code,
          ...(announcement.detail ? { detail: redactSecretsInText(announcement.detail) } : {}),
        };
      } else {
        // Les mots de l'agent, rangés tels quels ; ce qui est DIT est masqué.
        await db
          .update(agentJobs)
          .set({ spokenAnnouncement: announcement.text })
          .where(eq(agentJobs.id, job.jobId));
        said = redactSecretsInText(announcement.text);
        const opened = await openReplyVoice(db, job.entityId, emit, timing);
        if (opened.voice) {
          for (const sentence of splitSentences(said)) opened.voice.say(sentence);
          opened.voice.end();
          speechError = await opened.voice.done;
        } else {
          speechError = opened.unavailable;
        }
      }
    } catch (err) {
      speechError = {
        code: 'speech_failed',
        detail: redactSecretsInText(err instanceof Error ? err.message : String(err)),
      };
    }
    if (reply.events.some((e) => e.event === 'audio')) timing.mark('lastAudio');
    reply.ended = true;
    emitTo(reply, { event: 'done', data: { text: said, speechError } });
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
