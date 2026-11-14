// job/tool-acts.ts — ce qu'un job a fait de ses outils, lu sur ce qu'il a rangé (#1075).
//
// Les faits d'un échange passé que le relevé du runner redonne au modèle
// (exchange-record.ts) : chaque appel d'outil du job, dans l'ordre, et ce que
// l'appel a rendu. Rien d'autre que ce que la base garde d'un job terminé :
// `tools_used` et la transcription `messages`. Les deux registres de
// délégation (task-ledger.ts) lisent les jobs délégués par les mêmes
// fonctions, pour qu'un outil appelé par un délégué se dise comme un outil
// appelé par le job de tête.
//
// La transcription d'un job porte AUSSI l'historique qu'on lui a redonné en
// tête (thread-history.ts) : ses appels synthétiques ne sont pas les siens.
// `ownTranscript` coupe là où commence le tour du job, la même frontière que
// celle qui lit sa réponse.

import type { ModelMessage } from 'ai';
import { isInboxMessage, redactSecretsInText, unwrapUntrusted } from '@nodal-agents/shared';
import { returnResultTool } from '@nodal-agents/tools';
import { toolResultOutputText, toolResultShape } from './tool-result-shape.ts';

/** Au plus ce nombre de caractères par résultat cité. */
export const RESULT_HEAD_MAX_CHARS = 200;
/** Au plus ce nombre de lignes non vides par résultat cité. */
const RESULT_HEAD_LINES = 2;

/** Un appel d'outil d'un job : son nom, et ce qu'il a rendu (`undefined` : aucun résultat rangé). */
export interface ToolCallFact {
  name: string;
  output: unknown;
}

/** Ce qu'un job a fait de ses outils. */
export interface JobActs {
  /** `agent_jobs.tools_used` : les outils qu'il a exécutés, dans l'ordre de leur premier appel. */
  toolsUsed: readonly string[];
  /** Ses appels, dans l'ordre de sa transcription. */
  calls: readonly ToolCallFact[];
}

/**
 * Le tour du job dans sa transcription : à partir du message qui l'ouvre, sa
 * tâche (`openingMessages`). Ce qui précède est l'historique qu'on lui a
 * redonné. Le DERNIER message de la personne égal à la tâche, parce qu'un tour
 * redonné plus ancien peut porter les mêmes mots ; jamais un message remis en
 * cours de route (#531), lu à sa marque, qui peut aussi les porter. Sans
 * frontière trouvée, la transcription entière.
 */
export function ownTranscript(messages: unknown, task: string): ModelMessage[] {
  const all = Array.isArray(messages) ? (messages as ModelMessage[]) : [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (!m || m.role !== 'user' || isInboxMessage(m)) continue;
    if (typeof m.content === 'string' && m.content === task) return all.slice(i);
  }
  return all;
}

/**
 * Ce qu'un job a fait de ses outils, lu sur sa ligne `agent_jobs`.
 *
 * Ce qui n'est pas une action de l'échange n'en fait pas partie (#1075) :
 *  - les appels qui ont LIVRÉ sa réponse (`replyCallIds`), quand l'historique
 *    la redonne déjà comme le tour de l'agent. Qui les désigne : celui qui lit
 *    cette réponse (`extractAssistantReply`, thread-history.ts), une seule
 *    source ; le relevé ne les redit pas ;
 *  - la fin du job (`return_result`, lu sur la déclaration de l'outil) : elle
 *    est l'échange lui-même, pas une chose qu'il a faite.
 * Un outil dont TOUS les appels sont ainsi écartés n'est pas nommé, même si
 * `tools_used` le porte. Un envoi qui n'est pas la réponse reste une action.
 */
export function jobActs(
  job: { task: string | null; messages: unknown; toolsUsed: unknown },
  replyCallIds: ReadonlySet<string> = new Set(),
): JobActs {
  const all = jobCalls(job);
  const calls = all.filter(
    (c) => c.name !== returnResultTool.name && !(c.id !== null && replyCallIds.has(c.id)),
  );
  const called = new Set(all.map((c) => c.name));
  const kept = new Set(calls.map((c) => c.name));
  const toolsUsed = (Array.isArray(job.toolsUsed) ? (job.toolsUsed as unknown[]) : []).filter(
    (t): t is string =>
      typeof t === 'string' && t !== returnResultTool.name && (!called.has(t) || kept.has(t)),
  );
  return { toolsUsed, calls: calls.map(({ name, output }) => ({ name, output })) };
}

/** Every call of the job's own transcript, with its id and its stored result. */
function jobCalls(job: {
  task: string | null;
  messages: unknown;
}): Array<ToolCallFact & { id: string | null }> {
  const own = ownTranscript(job.messages, job.task ?? '');
  const results = new Map<string, unknown>();
  for (const m of own) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const p of m.content as unknown[]) {
      const part = p as { type?: unknown; toolCallId?: unknown; output?: unknown };
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        results.set(part.toolCallId, part.output);
      }
    }
  }
  const calls: Array<ToolCallFact & { id: string | null }> = [];
  for (const m of own) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const p of m.content as unknown[]) {
      const part = p as { type?: unknown; toolName?: unknown; toolCallId?: unknown };
      if (part?.type !== 'tool-call' || typeof part.toolName !== 'string') continue;
      const id = typeof part.toolCallId === 'string' ? part.toolCallId : null;
      calls.push({
        id,
        name: part.toolName,
        output: id === null ? undefined : results.get(id),
      });
    }
  }
  return calls;
}

/**
 * Les outils d'un job, chacun une fois, `nom ×N` quand il a été appelé N fois :
 * « web_search, file_write ×2 ». L'ordre de `tools_used` (le premier appel
 * exécuté), puis ceux que la transcription montre appelés sans les avoir
 * exécutés (un appel refusé). Le compte vient de la transcription ; un outil
 * que seule `tools_used` connaît compte pour un.
 */
export function toolNames(acts: JobActs): string {
  const counts = new Map<string, number>();
  for (const name of acts.toolsUsed) counts.set(name, 0);
  for (const call of acts.calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

/**
 * Le début de ce qu'un appel a rendu, cité comme une donnée : ses deux
 * premières lignes non vides, jointes par une espace, au plus
 * RESULT_HEAD_MAX_CHARS caractères. Une seule ligne, toujours : un texte venu
 * d'un tiers ne peut pas ouvrir une ligne du relevé à lui.
 *
 * Le cadre que la plateforme pose autour d'un résultat tiers est retiré par sa
 * propre fonction (`unwrapUntrusted`), jamais par un préfixe recopié ici, et
 * les secrets sont masqués comme partout où le runner rend un texte rangé
 * (`redactSecretsInText`), AVANT la coupe : un secret coupé en deux ne se
 * reconnaîtrait plus.
 */
export function resultHead(output: unknown): string {
  if (output === undefined) return '(no result recorded)';
  if (toolResultShape(output) === 'elided') return '(result no longer in the transcript)';
  const lines = redactSecretsInText(unframedText(output))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, RESULT_HEAD_LINES);
  const head = lines.join(' ');
  if (head === '') return '(empty result)';
  return head.length > RESULT_HEAD_MAX_CHARS
    ? `${head.slice(0, RESULT_HEAD_MAX_CHARS - 1)}…`
    : head;
}

/**
 * Le texte d'un résultat sans le cadre des résultats tiers, sous les trois
 * formes que le runner range : un texte encadré, des parts de contenu (le texte
 * encadré, puis des fichiers), et le bloc `{ error }` d'un échec que l'outil a
 * levé, dont le message est encadré (`raisedErrorBlockLength`).
 */
function unframedText(output: unknown): string {
  const out = (output ?? {}) as { type?: unknown; value?: unknown };
  if (out.type === 'content' && Array.isArray(out.value)) {
    return toolResultOutputText({
      type: 'content',
      value: (out.value as Array<{ type?: unknown; text?: unknown }>).map((p) =>
        p.type === 'text' && typeof p.text === 'string'
          ? { ...p, text: unwrapUntrusted(p.text) }
          : p,
      ),
    });
  }
  if (out.type === 'json' && out.value !== null && typeof out.value === 'object') {
    const value = out.value as Record<string, unknown>;
    if (typeof value['error'] === 'string') {
      return JSON.stringify({ ...value, error: unwrapUntrusted(value['error']) });
    }
  }
  return unwrapUntrusted(toolResultOutputText(out));
}
