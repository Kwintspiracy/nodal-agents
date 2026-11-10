// measure/spoken-reasoning.ts — la mesure qui choisit la valeur de départ de
// « Reasoning when spoken to » (#977).
//
// Pour chaque effort demandé, elle joue des tours de chat DITS par le vrai
// `runChatTurn`, avec le vrai prompt système d'un agent lu dans la base qu'on
// lui donne, et relève pour chaque tour : la décision (`run_task` appelé ou
// non, et si c'était le bon choix), le temps jusqu'au premier fragment de
// texte, les jetons de sortie, et si la réponse s'ouvre en racontant son
// aiguillage (« This is a general knowledge question, so… »), et la longueur
// de la réponse en mots et en phrases (#987).
//
// POURQUOI UN SCRIPT, ET PAS UNE SCÉNARIO DU BANC. `packages/bench` joue ses
// essais contre une stack qui tourne, par MCP ; un paquet ne peut pas importer
// le runner (dependency-cruiser, `packages-cant-import-apps`). La mesure, elle,
// doit appeler `runChatTurn` en direct, sans stack : elle vit donc dans le
// runner, à côté du code qu'elle mesure.
//
// CE QU'ELLE ÉCRIT : RIEN. Chaque tour se joue dans UNE transaction annulée à
// la fin : la conversation, les messages, le job qu'un `run_task` crée (jamais
// visible, donc jamais exécuté par un runner qui tourne sur la même base), les
// lignes `llm_calls`. L'effort mesuré n'est pas écrit sur l'agent : la
// transaction lit une COPIE temporaire des agents de l'espace
// (`pg_temp.agents`, qui masque `public.agents` pour cette seule transaction),
// où l'effort est posé. Aucune ligne de `public.agents` n'est verrouillée, et
// rien ne reste après le ROLLBACK. Chaque tour vérifie que l'effort rangé dans
// sa trace est bien celui qu'il mesure, sinon la mesure s'arrête (invariant #4).
//
// Ce que la base ne voit jamais, en revanche : les appels au modèle sont
// réels, et facturés sur la clé de l'agent.

import { asc, conversations, eq, llmCalls, sql, type AnyDrizzleDb } from '@nodal-agents/db';
import { REASONING_EFFORT_LEVELS, type ReasoningEffort } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import { runChatTurn } from '../chat/run-chat-turn.ts';
import { runInLane } from '../chat/turn-lane.ts';

/** Un effort mesuré : un palier de l'échelle, ou `auto` (NULL rangé). */
export type MeasuredEffort = ReasoningEffort | 'auto';

export function parseMeasuredEffort(value: string): MeasuredEffort {
  if (value === 'auto') return 'auto';
  if ((REASONING_EFFORT_LEVELS as readonly string[]).includes(value)) {
    return value as ReasoningEffort;
  }
  throw new Error(
    `unknown effort "${value}" (expected auto or one of ${REASONING_EFFORT_LEVELS.join(', ')})`,
  );
}

/** Une demande de la mesure, et la décision juste pour elle. */
export interface MeasureRequest {
  id: string;
  text: string;
  /** Vrai : la bonne réponse appelle `run_task`. Faux : elle répond, sans job. */
  needsTask: boolean;
}

/**
 * Les dix-sept demandes par défaut : sept qui demandent un travail (une
 * recherche, un fichier, une impression, une délégation de code, une
 * automatisation, une page à lire, une recherche sur le web), dix qui n'en
 * demandent aucun (l'heure ailleurs, un fait, un bonjour, un avis, un calcul
 * connu, une explication courte, et quatre demandes en anglais). Douze en français, la langue du
 * propriétaire ; cinq en anglais (#987), dont la question du climat de Tokyo
 * qui a ouvert le sujet de la longueur et une histoire de trois paragraphes
 * qui en demande, elle, beaucoup ;
 * `--requests` en donne d'autres. Aucune ne sort de la base : le job qu'un tour
 * crée est annulé avec lui, jamais exécuté.
 */
export const SPOKEN_REASONING_REQUESTS: readonly MeasureRequest[] = [
  {
    id: 'research',
    text: "Fais une recherche sur l'histoire du vélo électrique et fais-moi un résumé.",
    needsTask: true,
  },
  {
    id: 'file',
    text: 'Écris un fichier liste-courses.txt avec du lait, des œufs et du pain.',
    needsTask: true,
  },
  { id: 'print', text: 'Imprime-moi une page avec la recette des crêpes.', needsTask: true },
  {
    id: 'delegate-code',
    text: 'Demande à ton équipe de coder un petit script qui renomme mes photos par date.',
    needsTask: true,
  },
  {
    id: 'automation',
    text: "Crée-moi un rappel tous les jours à 8 heures pour boire de l'eau.",
    needsTask: true,
  },
  {
    id: 'fetch',
    text: "Va voir sur le site du musée d'Orsay ses horaires d'ouverture de demain.",
    needsTask: true,
  },
  { id: 'time', text: 'Quelle heure est-il à Tokyo en ce moment ?', needsTask: false },
  { id: 'fact', text: "Quelle est la capitale de l'Australie ?", needsTask: false },
  { id: 'greeting', text: 'Bonjour, comment ça va ?', needsTask: false },
  { id: 'opinion', text: 'Tu préfères le thé ou le café ?', needsTask: false },
  { id: 'leap-year', text: 'Combien de jours compte une année bissextile ?', needsTask: false },
  {
    id: 'explain',
    text: 'Explique-moi en deux phrases la différence entre un virus et une bactérie.',
    needsTask: false,
  },
  {
    id: 'weather-en',
    text: "What's the weather usually like in Tokyo in November?",
    needsTask: false,
  },
  { id: 'egg-en', text: 'How long does it take to boil an egg?', needsTask: false },
  {
    id: 'virus-bacterium-en',
    text: "What's the difference between a virus and a bacterium?",
    needsTask: false,
  },
  {
    // Une demande de longueur (#987) : la règle de brièveté ne doit pas la
    // plafonner. La réponse attendue garde ses trois paragraphes.
    id: 'story-en',
    text: 'Tell me a three-paragraph story about a robot learning to cook.',
    needsTask: false,
  },
  {
    id: 'news-en',
    text: 'Search the web for the latest news about Microsoft layoffs.',
    needsTask: true,
  },
  // #995, round 2: three requests the owner spoke to the robot, word for word
  // ("euh" included), where the routing was narrated for real.
  {
    id: 'weather-beijing-robot',
    text: 'Quelle est la météo à Pékin euh au mois de décembre en général ?',
    needsTask: false,
  },
  {
    id: 'magazine-robot',
    text: "Est-ce que tu peux me préparer une page format magazine euh au sujet euh de l'espionne en relation avec le PDG de Nvidia ?",
    needsTask: true,
  },
  {
    id: 'print-robot',
    text: "Du coup, est-ce que tu peux me l'imprimer maintenant ?",
    needsTask: true,
  },
];

/**
 * Les ouvertures qui racontent l'aiguillage au lieu de répondre : le défaut
 * vu le 03/11 (« This is a general knowledge question, so I can answer it
 * directly. » ; le 04/11 : « This is a creative writing request I can answer
 * directly, so no delegation is needed. », #995). Lues sur la PREMIÈRE phrase
 * seulement, en anglais et en français. Un repérage, pas un juge : chaque ouverture est aussi rendue
 * telle quelle dans le relevé, pour être relue.
 */
const ROUTING_NARRATION: readonly RegExp[] = [
  /\b(general[- ]knowledge|simple|quick|factual|straightforward|conversational|casual|creative(?: writing)?|writing|trivia)\s+(question|request|query|task)\b/i,
  /\b(answer|reply|respond)\s+(to\s+)?(it|this|that)?\s*(directly|right away|myself|without)\b/i,
  /\bno need (to|for)\b.*\b(task|job|tool|delegat\w*)\b/i,
  /\b(without|with no|no)\s+(any\s+)?(action|delegation|delegating)\b/i,
  /\b(doesn'?t|does not|won'?t|will not)\s+(need|require)\b.*\b(task|job|tool|delegat\w*)\b/i,
  /\bquestion\s+(de culture g[ée]n[ée]rale|g[ée]n[ée]rale|simple|factuelle)\b/i,
  /\bje (peux|vais) (y )?r[ée]pondre (directement|moi-m[êe]me|tout de suite|sans)\b/i,
  /\br[ée]pondre directement\b/i,
  // Conjugated forms, every person (#995, round 2): "Je réponds directement :",
  // "Je te réponds directement", "je répondrai moi-même".
  /\br[ée]pond\w*\s+(?:(?:te|vous|y|lui|cela|ça)\s+)?(?:directement|moi-m[êe]me|tout de suite|sans)\b/i,
  /\bje (peux|vais) (le |la |ça |cela )?(faire|traiter|g[ée]rer|[ée]crire) (directement|moi-m[êe]me)\b/i,
  // "answering directly", "I'll answer directly", "I replied myself".
  /\b(?:answer|reply|respond)\w*\s+(?:to\s+)?(?:(?:it|this|that|you)\s+)?(?:directly|right away|myself|without)\b/i,
  // "Creative writing is something I can do directly / myself".
  /\b(?:i can|i'll|i will|i'm able to|i could)\s+(?:just\s+)?(?:do|handle|write|take care of|answer)\b[^.!?]{0,30}\b(?:directly|myself|on my own)\b/i,
  /\b(?:do|handle|write)\s+(?:it|this|that)\s+(?:directly|myself)\b/i,
  /\bpas besoin de\b.*\b(t[âa]che|job|outil|d[ée]l[ée]gu\w*|lancer)\b/i,
  /\b(ne (n[ée]cessite|demande|requiert) pas)\b.*\b(t[âa]che|job|outil)\b/i,
];

/**
 * Does the line that goes with a `run_task` call narrate the routing (#995,
 * round 2)? It names a teammate (names come from the database, never from a
 * list written here), or says who it hands over to and why ("je délègue",
 * "je transmets à", "via X", "qui gère…", "team routing"). "Je lance la
 * recherche." says WHAT is being done: not routing. Read on the whole text, not
 * the first sentence: the line is short and the teammate often comes last.
 */
const LAUNCH_NARRATION: readonly RegExp[] = [
  /\b(?:d[ée]l[èe]gu\w*|delegat\w*|transmets|transmett\w*|transmis\w*|transf[èe]re\w*|confie\w*|confier)\b/i,
  /\bpass(?:e|er|erai|es|ing|ed)\s+(?:la main|le relais|la demande|cela|ça|ce|it|this|that|the \w+)?\s*(?:à|au|aux|(?:on |along )?to\b)/i,
  /\bhand(?:s|ing|ed)?\s+(?:it |this |that |the \w+ )?(?:off|over)\b/i,
  /\b(?:forward|route)(?:s|d|ing)?\s+(?:it |this |that |the \w+ )?to\b/i,
  /(?<![\p{L}\p{N}])(?:via|auprès d(?:e|u|es)|through)\s+(?:l['’]agent\s+|the agent\s+)?\p{Lu}/u,
  /\bqui\s+(?:g[èe]re|a\s|s['’]occupe|sait|fera|orchestre|ma[iî]trise|dispose|poss[èe]de|est charg[ée])/i,
  /\b(?:which|who)\s+(?:handles|has|manages|specializes|owns|is in charge|runs|orchestrates)\b/i,
  /\bteam routing\b/i,
];

const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function launchNarratesRouting(
  text: string,
  teammateNames: readonly string[] = [],
): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (LAUNCH_NARRATION.some((re) => re.test(trimmed))) return true;
  return teammateNames
    .map((n) => n.trim())
    .filter((n) => n !== '')
    .some((n) =>
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, 'iu').test(trimmed),
    );
}

/** La première phrase d'une réponse, bornée. */
export function openingOf(reply: string): string {
  const text = reply.trim();
  const end = text.search(/[.!?…](\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).slice(0, 240);
}

/** La réponse s'ouvre-t-elle en racontant le choix entre répondre et escalader ? */
export function opensWithRoutingNarration(reply: string): boolean {
  const opening = openingOf(reply);
  return ROUTING_NARRATION.some((re) => re.test(opening));
}

/**
 * Un mot : une suite de caractères entre deux blancs qui porte au moins une
 * lettre ou un chiffre. « 16 », « °C » et « to » comptent chacun pour un ; un
 * tiret seul, non. C'est ce qu'une voix dit comme un mot.
 */
export function wordCount(reply: string): number {
  return reply.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * Des abréviations qui finissent par un point sans finir la phrase. Les sigles
 * en lettres pointées (« e.g. », « i.e. », « U.S. ») sont reconnus à leur
 * forme, pas listés.
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'vs',
  'approx',
  'mme',
  'mlle',
]);

/**
 * Le nombre de phrases d'une réponse : une fin de phrase est « . ! ? … » suivi
 * d'un blanc (ou de la fin du texte), SAUF si le mot qui précède est une
 * abréviation (« e.g. », « Dr. »), ou si ce qui suit commence par une
 * minuscule ou un chiffre (« e.g. a jacket »). Un nombre décimal
 * (« 3.5 ») n'a pas de blanc après son point : il n'en finit jamais une.
 * Un repérage, pas un analyseur : sa limite est dite par ses tests.
 */
export function sentenceCount(reply: string): number {
  const text = reply.trim();
  let count = 0;
  let start = 0;
  for (const m of text.matchAll(/[.!?…]+["'”’)\]]*(?=\s|$)/gu)) {
    const before = text.slice(start, m.index);
    const lastWord = /(\S+)$/u.exec(before)?.[1] ?? '';
    const dotted = /^(\p{L}\.)+\p{L}$/u.test(lastWord);
    const abbreviation =
      m[0].startsWith('.') && (dotted || ABBREVIATIONS.has(lastWord.toLowerCase()));
    const after = text.slice(m.index + m[0].length).trimStart();
    const continues = after !== '' && /^[\p{Ll}\p{N}]/u.test(after);
    const empty = !/[\p{L}\p{N}]/u.test(before);
    if (abbreviation || continues || empty) continue;
    count++;
    start = m.index + m[0].length;
  }
  if (/[\p{L}\p{N}]/u.test(text.slice(start))) count++;
  return count;
}

/** Un tour joué, tel que la mesure le relève. */
export interface TurnRecord {
  effort: MeasuredEffort;
  run: number;
  requestId: string;
  needsTask: boolean;
  /** Le tour a lancé un job (`run_task`, relecture d'escalade comprise). */
  calledRunTask: boolean;
  /** La décision était la bonne pour cette demande. */
  rightDecision: boolean;
  /** Du début du tour au premier fragment de texte ; null : aucun texte diffusé. */
  firstDeltaMs: number | null;
  /** Du début du tour à son retour. */
  totalMs: number;
  /** Jetons de sortie de l'appel principal (la réponse), tels que `llm_calls` les a rangés. */
  replyOutputTokens: number | null;
  /** Jetons de sortie de tous les appels du tour (réponse, relecture, titre). */
  turnOutputTokens: number | null;
  /** Les appels du tour, dans l'ordre, et l'effort que chacun a demandé. */
  calls: Array<{ reasoningEffort: string | null; outputTokens: number | null; ms: number | null }>;
  opening: string;
  /** Turn WITHOUT a job: the reply opens by narrating the routing. */
  routingNarration: boolean;
  /** Turn WITH a job: the line that goes with `run_task` narrates the routing (#995). */
  launchNarration: boolean;
  /** La longueur de la réponse écrite (#987) : ses mots et ses phrases. */
  replyWords: number;
  replySentences: number;
  /** Le tour a échoué : le code rendu par `runChatTurn`. */
  error?: string;
}

/** Lève pour annuler la transaction du tour ; jamais une erreur de la mesure. */
class RollbackTurn extends Error {}

/** Les lignes `llm_calls` sont écrites sans être attendues (call-sink.ts) : on les attend ici. */
async function callsOf(
  tx: AnyDrizzleDb,
  conversationId: string,
): Promise<
  Array<{ reasoningEffort: string | null; outputTokens: number | null; ms: number | null }>
> {
  let rows: Array<{
    reasoningEffort: string | null;
    outputTokens: number | null;
    ms: number | null;
  }> = [];
  for (let i = 0; i < 20; i++) {
    rows = await tx
      .select({
        reasoningEffort: llmCalls.reasoningEffort,
        outputTokens: llmCalls.outputTokens,
        ms: llmCalls.durationMs,
      })
      .from(llmCalls)
      .where(eq(llmCalls.conversationId, conversationId))
      .orderBy(asc(llmCalls.createdAt));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows;
}

/**
 * Joue UN tour dit, dans une transaction annulée à la fin (voir l'en-tête).
 * `db` est la base pointée ; rien n'y reste.
 */
export async function playMeasuredTurn(
  db: AnyDrizzleDb,
  opts: {
    entityId: string;
    agentId: string;
    effort: MeasuredEffort;
    request: MeasureRequest;
    run: number;
    /** The workspace's teammate names, read from the database (a launch line that names one narrates the routing). */
    teammateNames?: readonly string[];
    /** La durée « dite » du message, rangée sur la ligne comme un vrai tour vocal. */
    spokenMs?: number;
  },
): Promise<TurnRecord> {
  const stored = opts.effort === 'auto' ? null : opts.effort;
  let record: TurnRecord | null = null;
  try {
    await db.transaction(async (raw) => {
      const tx = raw as unknown as AnyDrizzleDb;
      // Un tour peut attendre son modèle plus que la minute que le pool
      // accorde à une transaction inactive (client.ts) : celle-ci seulement.
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '600s'`);
      await tx.execute(
        sql`CREATE TEMP TABLE agents (LIKE public.agents INCLUDING DEFAULTS) ON COMMIT DROP`,
      );
      // Une base qui n'a pas encore la migration 0159 (la stack qui tourne,
      // avant le merge) : la colonne n'existe que sur la copie, en dernière
      // position, où le `SELECT *` ci-dessous la laisse à NULL. Déjà là : rien.
      // Ce n'est PAS une erreur de nombre de colonnes : un INSERT sans liste de
      // colonnes vise « les N premières colonnes, si la requête n'en fournit
      // que N » (documentation PostgreSQL, INSERT) ; la dernière prend son
      // défaut. Vérifié sur la base du propriétaire, qui n'a pas 0159 : 108
      // tours, 0 erreur (revue A, passe 1).
      await tx.execute(
        sql`ALTER TABLE pg_temp.agents ADD COLUMN IF NOT EXISTS spoken_reasoning_effort text`,
      );
      await tx.execute(
        sql`INSERT INTO pg_temp.agents SELECT * FROM public.agents WHERE entity_id = ${opts.entityId}`,
      );
      await tx.execute(
        sql`UPDATE pg_temp.agents SET spoken_reasoning_effort = ${stored} WHERE id = ${opts.agentId}`,
      );
      const [conv] = await tx
        .insert(conversations)
        // Un titre déjà donné : le tour ne paie pas l'appel qui nomme le fil.
        .values({
          entityId: opts.entityId,
          agentId: opts.agentId,
          title: 'Spoken reasoning measure',
        })
        .returning({ id: conversations.id });
      if (!conv) throw new Error('measure: the conversation row was not returned');

      const started = performance.now();
      let firstDeltaMs: number | null = null;
      // Comme toute entrée du chat : le tour passe par la file de sa
      // conversation (turn-lane.ts, #453). Le fil est neuf, la file vide.
      const conversationId = conv.id;
      const result = await runInLane(conversationId, () =>
        runChatTurn({
          deps: { db: tx } as unknown as RunnerDeps,
          entityId: opts.entityId,
          agentId: opts.agentId,
          conversationId,
          message: opts.request.text,
          spoken: { durationMs: opts.spokenMs ?? 2_500 },
          onTextDelta: () => {
            firstDeltaMs ??= Math.round(performance.now() - started);
          },
        }),
      );
      const totalMs = Math.round(performance.now() - started);
      const calls = await callsOf(tx, conversationId);

      // Le relevé ne vaut que si le tour a demandé l'effort mesuré.
      const asked = calls[0]?.reasoningEffort ?? null;
      if (calls.length > 0 && asked !== stored) {
        throw new Error(
          `measure: the turn asked for reasoning "${String(asked)}", not the measured "${String(stored)}"`,
        );
      }

      const reply = result.ok ? result.reply : '';
      const calledRunTask = result.ok && result.spawnedJobId !== undefined;
      const sum = calls.reduce<number | null>(
        (acc, c) => (c.outputTokens === null ? acc : (acc ?? 0) + c.outputTokens),
        null,
      );
      record = {
        effort: opts.effort,
        run: opts.run,
        requestId: opts.request.id,
        needsTask: opts.request.needsTask,
        calledRunTask,
        rightDecision: result.ok && calledRunTask === opts.request.needsTask,
        firstDeltaMs,
        totalMs,
        replyOutputTokens: calls[0]?.outputTokens ?? null,
        turnOutputTokens: sum,
        calls,
        opening: openingOf(reply),
        routingNarration: !calledRunTask && opensWithRoutingNarration(reply),
        launchNarration: calledRunTask && launchNarratesRouting(reply, opts.teammateNames ?? []),
        replyWords: wordCount(reply),
        replySentences: sentenceCount(reply),
        ...(result.ok ? {} : { error: result.error }),
      };
      throw new RollbackTurn();
    });
  } catch (err) {
    if (!(err instanceof RollbackTurn)) throw err;
  }
  if (!record) throw new Error('measure: the turn left no record');
  return record;
}

/**
 * Toute la mesure : `runs` passes ; dans chaque passe, chaque demande, et pour
 * chaque demande chaque effort à la suite — les efforts se croisent dans le
 * temps, pour qu'une heure chargée chez le fournisseur ne pèse pas sur un seul.
 */
export async function measureSpokenReasoning(
  db: AnyDrizzleDb,
  opts: {
    entityId: string;
    agentId: string;
    efforts: readonly MeasuredEffort[];
    runs: number;
    requests?: readonly MeasureRequest[];
    teammateNames?: readonly string[];
    onTurn?: (record: TurnRecord) => void;
  },
): Promise<TurnRecord[]> {
  const requests = opts.requests ?? SPOKEN_REASONING_REQUESTS;
  const records: TurnRecord[] = [];
  for (let run = 1; run <= opts.runs; run++) {
    for (const request of requests) {
      for (const effort of opts.efforts) {
        const record = await playMeasuredTurn(db, {
          entityId: opts.entityId,
          agentId: opts.agentId,
          effort,
          request,
          run,
          ...(opts.teammateNames ? { teammateNames: opts.teammateNames } : {}),
        });
        records.push(record);
        opts.onTurn?.(record);
      }
    }
  }
  return records;
}

/** Une ligne du résumé : un effort. */
export interface EffortSummary {
  effort: MeasuredEffort;
  turns: number;
  errors: number;
  rightDecisions: number;
  /** Demandes qui voulaient un travail, et parmi elles celles qui l'ont lancé. */
  taskTurns: number;
  taskLaunched: number;
  /** Demandes sans travail, et parmi elles celles qui n'en ont lancé aucun. */
  noTaskTurns: number;
  noTaskAnswered: number;
  /** Tours qui ont diffusé du texte (ceux qui comptent pour le premier mot). */
  withText: number;
  firstDeltaMedianMs: number | null;
  firstDeltaP90Ms: number | null;
  replyOutputTokensMedian: number | null;
  /** Turns without a job whose reply narrates the routing. */
  routingNarrations: number;
  /** Turns with a job whose launch line narrates the routing (#995). */
  launchNarrations: number;
  /**
   * Les mots des réponses directes (#987) : celles des demandes sans travail
   * qui ont répondu sans erreur et sans lancer de job — les mêmes que
   * `noTaskAnswered`. Un tour en erreur ou escaladé à tort n'a pas de réponse
   * à mesurer ; le compter à zéro tirerait la médiane vers le bas.
   */
  noTaskWordsMedian: number | null;
  noTaskWordsMax: number | null;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? null;
}

export function summarize(records: readonly TurnRecord[]): EffortSummary[] {
  const efforts = [...new Set(records.map((r) => r.effort))];
  return efforts.map((effort) => {
    const rows = records.filter((r) => r.effort === effort);
    const deltas = rows.flatMap((r) => (r.firstDeltaMs === null ? [] : [r.firstDeltaMs]));
    const tokens = rows.flatMap((r) => (r.replyOutputTokens === null ? [] : [r.replyOutputTokens]));
    const task = rows.filter((r) => r.needsTask);
    const noTask = rows.filter((r) => !r.needsTask);
    const answeredWords = noTask
      .filter((r) => r.error === undefined && !r.calledRunTask)
      .map((r) => r.replyWords);
    return {
      effort,
      turns: rows.length,
      errors: rows.filter((r) => r.error !== undefined).length,
      rightDecisions: rows.filter((r) => r.rightDecision).length,
      taskTurns: task.length,
      taskLaunched: task.filter((r) => r.calledRunTask).length,
      noTaskTurns: noTask.length,
      noTaskAnswered: noTask.filter((r) => r.error === undefined && !r.calledRunTask).length,
      withText: deltas.length,
      firstDeltaMedianMs: percentile(deltas, 50),
      firstDeltaP90Ms: percentile(deltas, 90),
      replyOutputTokensMedian: percentile(tokens, 50),
      routingNarrations: rows.filter((r) => r.routingNarration).length,
      launchNarrations: rows.filter((r) => r.launchNarration).length,
      noTaskWordsMedian: percentile(answeredWords, 50),
      noTaskWordsMax: answeredWords.length === 0 ? null : Math.max(...answeredWords),
    };
  });
}

/** Le résumé en tableau Markdown, prêt pour la PR. */
export function summaryTable(rows: readonly EffortSummary[]): string {
  const ms = (v: number | null): string => (v === null ? 'n/a' : `${(v / 1000).toFixed(2)} s`);
  const lines = [
    '| Effort | Right decisions | Task launched | No-task answered | First text (median / p90) | Reply output tokens (median) | Routing narrations (reply) | Routing narrations (launch) | No-task words (median / max) | Errors |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.effort} | ${r.rightDecisions}/${r.turns} | ${r.taskLaunched}/${r.taskTurns} | ` +
        `${r.noTaskAnswered}/${r.noTaskTurns} | ${ms(r.firstDeltaMedianMs)} / ${ms(r.firstDeltaP90Ms)} ` +
        `(${r.withText} turns with text) | ${r.replyOutputTokensMedian ?? 'n/a'} | ` +
        `${r.routingNarrations}/${r.noTaskTurns} | ${r.launchNarrations}/${r.taskTurns} | ${r.noTaskWordsMedian ?? 'n/a'} / ${r.noTaskWordsMax ?? 'n/a'} | ` +
        `${r.errors} |`,
    );
  }
  return lines.join('\n');
}
