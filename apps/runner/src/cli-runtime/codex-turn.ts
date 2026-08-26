// cli-runtime/codex-turn.ts — un tour de conversation d'un agent dont le
// runtime est Codex : l'agent EST une session `codex exec`.
//
// Le pendant de `claude-turn.ts`, et volontairement écrit dans le même ordre :
// construire l'argv, lire le flux ligne à ligne, réduire l'issue en résultat.
// La mécanique de processus (lancement, arbre tué, délai, garde anti-boucle)
// est partagée — voir `spawn-turn.ts`.
//
// TROIS DIFFÉRENCES avec Claude, toutes mesurées sur le binaire installé
// (`codex exec --help`, codex-cli, 27/08) et non lues sur une page d'aide :
//
//   1. **La persona n'a pas de drapeau.** Claude a
//      `--append-system-prompt-file` ; `codex exec` n'a AUCUN équivalent : ni
//      drapeau de prompt système, ni fichier d'instructions. Les seules entrées
//      sont le prompt (argument ou stdin), `-c` (TOML) et `AGENTS.md` dans le
//      dossier de travail. Écrire un `AGENTS.md` chez l'utilisateur serait
//      salir son dépôt pour une raison qui ne le regarde pas. La persona voyage
//      donc EN TÊTE DE STDIN, avec un en-tête qui la nomme.
//
//      Conséquence assumée : elle est envoyée au PREMIER tour seulement. À la
//      reprise, elle est déjà dans le fil de la session ; la répéter la
//      transformerait en message utilisateur dupliqué à chaque tour, payé à
//      chaque tour. Claude, lui, la repasse à chaque fois parce que chez lui
//      c'est un prompt SYSTÈME, pas un message.
//
//   2. **Le format d'événements est le sien.** `thread.started` porte l'identité
//      de session, `item.started` / `item.completed` les outils, un
//      `agent_message` la réponse, `turn.completed` l'usage, `turn.failed`
//      l'échec. Rien de tout ça ne ressemble aux enveloppes stream-json.
//
//   3. **Il ne rapporte aucun coût.** Le champ reste `null` — jamais un 0
//      deviné, qui ferait croire à un tour gratuit (invariant #4). Le budget
//      quotidien ne le borne donc pas ; c'est le délai par tour qui le borne.
//
// L'argv et la lecture des événements d'outils sont EMPRUNTÉS à l'outil
// `code_task`, qui pilote déjà ce binaire depuis le 19/08 (`buildProviderArgs`,
// `parseLiveToolEvent`). Deux façons de lancer le même CLI auraient dérivé —
// c'est précisément ce que l'extraction de `spawn-turn.ts` évite par ailleurs.

import {
  resolveCliPath,
  buildSpawnArgv,
  buildChildEnv,
  buildProviderArgs,
  parseLiveToolEvent,
} from '@nodal-agents/tools';
import { spawnCliTurn } from './spawn-turn.ts';
import type { ClaudeTurnEvent, ClaudeTurnResult, ClaudeTurnOptions } from './claude-turn.ts';

/** Même forme d'événement live que le chemin Claude — l'appelant ne trie pas. */
export type CodexTurnEvent = ClaudeTurnEvent;
/** Même forme de résultat : run-job/run-chat ne connaissent qu'un seul contrat. */
export type CodexTurnResult = ClaudeTurnResult;
/** Mêmes options. `extraDisallowed` est ignoré ici — voir plus bas. */
export type CodexTurnOptions = ClaudeTurnOptions;

/**
 * L'en-tête qui introduit la persona dans stdin.
 *
 * Il est là pour que la CLI ne confonde pas la personnalité avec la demande.
 * Sans lui, les deux textes se touchent et le modèle lit la consigne comme le
 * début de la tâche.
 */
export const CODEX_PERSONA_HEADER =
  '=== WHO YOU ARE (system instructions, not a task) ===' as const;
const CODEX_MESSAGE_HEADER = '=== THE REQUEST ===' as const;

/**
 * Le texte envoyé sur stdin. Pur, donc prouvable.
 *
 * À la reprise (`resumeSessionId` présent), la persona est OMISE : la session
 * la porte déjà. Voir l'en-tête du fichier.
 */
export function buildCodexStdin(opts: {
  message: string;
  personality: string;
  resumeSessionId?: string;
}): string {
  if (opts.resumeSessionId) return opts.message;
  return `${CODEX_PERSONA_HEADER}\n${opts.personality}\n\n${CODEX_MESSAGE_HEADER}\n${opts.message}`;
}

/**
 * Une restriction d'outils que Codex ne sait pas appliquer.
 *
 * Codex ne se confine pas en retirant des outils au modèle (la méthode de
 * Claude) mais par un bac à sable du système : une liste de noms d'outils
 * interdits n'a rien à quoi s'accrocher.
 *
 * La première version se contentait de le JOURNALISER et lançait la CLI sans
 * restriction. La revue Codex (27/08) a nommé ce que ça permettait : basculer un
 * agent restreint de Claude Code vers Codex lui RENDAIT les outils qu'on lui
 * avait explicitement retirés — en mode écriture, c'est une élévation de
 * permissions obtenue par un menu déroulant. Un repli silencieux exactement là
 * où il coûte le plus cher (invariant #4).
 */
export class CodexRestrictionsUnsupportedError extends Error {
  constructor(tools: readonly string[]) {
    super(
      `codex_cannot_restrict_tools: this agent forbids ${tools.join(', ')}, and the codex CLI ` +
        `cannot enforce a per-tool ban — it confines by OS sandbox, not by removing tools. ` +
        `Clear those restrictions, or keep this agent on a harness that supports them.`,
    );
    this.name = 'CodexRestrictionsUnsupportedError';
  }
}

/**
 * L'argv d'un tour, délégué à `buildProviderArgs` — l'unique constructeur
 * d'argv Codex de la base.
 *
 * Lève quand l'agent porte des restrictions d'outils : voir ci-dessus.
 */
export function buildCodexTurnArgs(opts: CodexTurnOptions): string[] {
  if (opts.extraDisallowed && opts.extraDisallowed.length > 0) {
    throw new CodexRestrictionsUnsupportedError(opts.extraDisallowed);
  }
  return buildProviderArgs('codex', opts.mode, {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
  });
}

/** L'état de lecture d'un flux `codex exec --json`. */
export interface CodexParseState {
  sessionId: string | null;
  messages: string[];
  usage: ClaudeTurnResult['usage'];
  sawTurnCompleted: boolean;
  failure: string | null;
  unknownEventTypes: Set<string>;
}

export function newCodexParseState(): CodexParseState {
  return {
    sessionId: null,
    messages: [],
    usage: null,
    sawTurnCompleted: false,
    failure: null,
    unknownEventTypes: new Set(),
  };
}

const OUTPUT_CAP = 20_000;
const FAILURE_CAP = 500;

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Les types d'item qui SONT un appel d'outil.
 *
 * Relevés dans les symboles du binaire installé (codex-cli 0.148.0, 27/08) et
 * non devinés : `command_execution`, `file_change`, `mcp_tool_call`,
 * `collab_tool_call`, `web_search`, `todo_list`, `dynamic_tool_call`. Le
 * `agent_message` et la compaction de contexte n'en sont pas.
 *
 * La liste sert au COMPTAGE anti-boucle, pas à l'audit : un type inconnu d'une
 * version future compte quand même dès qu'il ressemble à un outil (voir
 * `isCodexToolItem`), parce que sous-compter, ici, c'est laisser filer une
 * boucle.
 */
const CODEX_NON_TOOL_ITEMS = new Set(['agent_message', 'context_compaction', 'reasoning']);

/**
 * Cet item est-il un appel d'outil ?
 *
 * Écrit en NÉGATIF exprès : la liste des outils grandit à chaque version du
 * CLI, celle de ce qui n'en est pas est stable. Un type inédit compte donc
 * comme un outil — le plafond anti-boucle serre un peu trop plutôt que pas
 * assez, ce qui est le seul sens acceptable pour un garde-fou.
 */
export function isCodexToolItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const t = (item as Record<string, unknown>)['type'];
  return typeof t === 'string' && !CODEX_NON_TOOL_ITEMS.has(t);
}

/**
 * L'entrée d'un appel d'outil, remise dans la forme que les surfaces Code
 * attendent.
 *
 * Un `file_change` de Codex porte ses fichiers dans un tableau `changes`, alors
 * que l'onglet Code et le contexte des projets (`apps/web/src/lib/actions.ts`,
 * `apps/runner/src/job/code-projects.ts`) cherchent un `file_path` direct — la
 * forme des outils Claude. Sans cette traduction, les écritures d'un agent
 * Codex en mode écriture n'apparaissaient nulle part : ni onglet, ni projets
 * annoncés aux agents (revue Codex, 27/08).
 *
 * ⚠️ La forme vient des symboles du binaire (`FileChangeItem`, `FileUpdateChange`
 * avec `path` / `kind` add|delete|update) et d'une lecture défensive, PAS d'un
 * flux réel : le mode écriture n'a pas pu être observé sur cette machine (voir
 * le journal de la sonde, `scripts/probe-codex-sandbox.mjs`, qui rend
 * « undetermined »). D'où la règle : on lit ce qui est là, et on n'invente
 * AUCUN chemin quand rien ne correspond.
 */
export function normalizeCodexToolInput(toolName: string, input: unknown): unknown {
  if (toolName !== 'file_change' || !input || typeof input !== 'object') return input;
  const item = input as Record<string, unknown>;
  const changes = Array.isArray(item['changes']) ? item['changes'] : [];
  const paths = changes
    .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>)['path'] : null))
    .filter((p): p is string => typeof p === 'string' && p !== '');
  const direct = typeof item['path'] === 'string' ? item['path'] : null;
  const first = paths[0] ?? direct;
  // Rien de reconnaissable : on rend l'item tel quel plutôt que de fabriquer un
  // chemin. Une ligne d'audit sans `file_path` est lisible ; un mauvais chemin
  // fabrique un projet fantôme dans l'onglet.
  if (!first) return input;
  return {
    ...item,
    // `file_path` est le nom que les deux surfaces cherchent — c'est la seule
    // raison de ce champ.
    file_path: first,
    ...(paths.length > 1 ? { file_paths: paths } : {}),
  };
}

/**
 * Traite UNE ligne du flux. Rend `true` quand la ligne ouvre un appel d'outil —
 * c'est le signal que `spawn-turn.ts` compte pour le garde anti-boucle.
 *
 * Les types d'événements inconnus sont collectés, jamais devinés : une montée
 * de version du CLI se voit dans le journal au lieu de disparaître.
 */
export function handleCodexLine(
  state: CodexParseState,
  line: string,
  onEvent?: (evt: CodexTurnEvent) => void,
): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;

  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    state.unknownEventTypes.add('(non-json-line)');
    return false;
  }

  // Les outils d'abord, par le lecteur que `code_task` utilise déjà.
  const live = parseLiveToolEvent('codex', trimmed);
  if (live) {
    if (live.kind === 'use') {
      onEvent?.({
        kind: 'tool_use',
        toolUseId: live.event.id,
        toolName: live.event.name,
        input: normalizeCodexToolInput(live.event.name, live.event.input),
      });
    } else {
      onEvent?.({
        kind: 'tool_result',
        toolUseId: live.event.id,
        output: (live.event.output ?? '').slice(0, OUTPUT_CAP),
      });
    }
  }

  const type = evt['type'];
  if (type === 'thread.started') {
    if (typeof evt['thread_id'] === 'string') state.sessionId = evt['thread_id'];
    return false;
  }
  // Cycle de vie sans information à extraire, mais BIEN connu : sans cette
  // branche, `turn.started` tombait dans les types inconnus et chaque tour
  // RÉUSSI journalisait « CLI drift? » (revue Codex, 27/08). Un avertissement
  // qui se déclenche toujours ne signale plus rien : c'est la vraie dérive de
  // protocole qu'il aurait noyée.
  if (type === 'turn.started') return false;
  if (type === 'item.started') {
    // Le compteur anti-boucle voit TOUT appel d'outil, pas seulement ceux qui
    // méritent une ligne d'audit (revue Codex, 27/08). `parseLiveToolEvent` ne
    // reconnaît que `command_execution` et `file_change` ; les symboles du
    // binaire (codex-cli 0.148.0) en listent sept de plus — `mcp_tool_call`,
    // `web_search`, `todo_list`, `collab_tool_call`, `dynamic_tool_call`… Une
    // session qui boucle sur l'un d'eux n'incrémentait rien et dépassait
    // silencieusement le plafond de l'invariant #8.
    //
    // On compte donc sur l'ITEM, pas sur ce que l'audit sait rendre.
    return isCodexToolItem(evt['item']);
  }
  if (type === 'item.completed') {
    const item = evt['item'] as Record<string, unknown> | undefined;
    if (item?.['type'] === 'agent_message' && typeof item['text'] === 'string') {
      state.messages.push(item['text']);
      onEvent?.({ kind: 'assistant_text', text: item['text'] });
    }
    return false;
  }
  if (type === 'turn.completed') {
    state.sawTurnCompleted = true;
    const u = evt['usage'] as Record<string, unknown> | undefined;
    if (u) {
      // Sémantique OpenAI : `input_tokens` INCLUT les jetons de cache. On rend
      // l'entrée HORS cache, comme le reste de la base (voir parseCodexOutput).
      const rawIn = asNumber(u['input_tokens']);
      const cached = asNumber(u['cached_input_tokens']);
      state.usage = {
        inputTokens: Math.max(0, rawIn - cached),
        outputTokens: asNumber(u['output_tokens']),
        cachedTokens: cached,
        cacheCreationTokens:
          typeof u['cache_write_input_tokens'] === 'number' ? u['cache_write_input_tokens'] : null,
      };
    }
    return false;
  }
  if (type === 'turn.failed' || type === 'error') {
    state.failure = JSON.stringify(evt).slice(0, FAILURE_CAP);
    return false;
  }
  state.unknownEventTypes.add(String(type));
  return false;
}

/**
 * Réduit l'état de lecture et l'issue du processus en résultat de tour.
 *
 * Un flux qui s'arrête sans `turn.completed` ni `turn.failed` est une PANNE,
 * pas un tour vide : le dire est la seule façon de ne pas rendre à
 * l'utilisateur le silence d'une session morte comme s'il était une réponse.
 */
export function finishCodexTurn(
  state: CodexParseState,
  exitCode: number | null,
  timedOut: boolean,
  durationMs: number,
  stderrExcerpt: string,
  toolCapExceeded?: number,
): CodexTurnResult {
  const capDetail =
    toolCapExceeded !== undefined
      ? `tool_call_limit_exceeded: the CLI exceeded ${String(toolCapExceeded)} tool calls in one ` +
        `turn and was killed (anti-loop guard, invariant #8)`
      : null;

  const finalText = state.messages.join('\n\n');
  const streamIncomplete = !state.sawTurnCompleted && state.failure === null;
  const isError =
    capDetail !== null ||
    state.failure !== null ||
    streamIncomplete ||
    (exitCode !== null && exitCode !== 0);

  const errorDetail =
    capDetail ??
    state.failure ??
    (timedOut
      ? 'cli_timeout: the run exceeded its time budget and was killed'
      : streamIncomplete
        ? `cli_stream_incomplete: the stream ended without turn.completed or turn.failed ` +
          `(exit ${String(exitCode)}). stderr: ${stderrExcerpt.slice(0, 400)}`
        : `exit_code=${String(exitCode)}`);

  return {
    sessionId: state.sessionId,
    finalText,
    isError,
    errorDetail: isError ? errorDetail : null,
    usage: state.usage,
    // Codex rapporte UN usage agrégé et aucune attribution par modèle —
    // en fabriquer une inventerait une répartition qu'il n'a jamais faite.
    modelUsage: null,
    // Aucun coût dans son flux. `null`, jamais 0 (invariant #4).
    costUsd: null,
    numTurns: null,
    durationMs,
    exitCode,
    timedOut,
    // Pas d'équivalent de `rate_limit_event` dans ce flux : ne rien affirmer.
    rateLimit: null,
    // Le refus d'une commande par le bac à sable arrive dans la sortie de
    // l'outil, pas dans un compteur dédié. Zéro voudrait dire « aucun refus »,
    // ce qu'on ne sait pas.
    permissionDenials: 0,
    unknownEventTypes: [...state.unknownEventTypes],
  };
}

export class CodexCliNotFoundError extends Error {
  constructor() {
    super(
      'cli_not_installed: the "codex" CLI was not found on the runner machine. ' +
        'Install it (npm install -g @openai/codex) and log in (`codex login`).',
    );
    this.name = 'CodexCliNotFoundError';
  }
}

/**
 * Un tour. Ne rejette que pour un échec d'installation (binaire absent) ; toute
 * panne d'exécution revient en résultat structuré — fort, pas jeté.
 */
export async function runCodexTurn(opts: CodexTurnOptions): Promise<CodexTurnResult> {
  const cli = resolveCliPath('codex');
  if (!cli) throw new CodexCliNotFoundError();

  const { argv, envExtra } = buildSpawnArgv(cli, buildCodexTurnArgs(opts));
  const env = { ...buildChildEnv(process.env), ...envExtra } as unknown as NodeJS.ProcessEnv;
  const state = newCodexParseState();

  return spawnCliTurn<CodexTurnResult>({
    argv,
    env,
    cwd: opts.cwd,
    stdin: buildCodexStdin({
      message: opts.message,
      personality: opts.personality,
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    }),
    timeoutMs: opts.timeoutMs,
    ...(opts.maxToolCalls !== undefined ? { maxToolCalls: opts.maxToolCalls } : {}),
    onLine: (line) => handleCodexLine(state, line, opts.onEvent),
    finish: ({ exitCode, timedOut, durationMs, stderr, toolCapExceeded }) => {
      if (state.unknownEventTypes.size > 0) {
        console.warn(
          `[cli-runtime] unknown codex event types (CLI drift?): ` +
            [...state.unknownEventTypes].join(', '),
        );
      }
      return finishCodexTurn(state, exitCode, timedOut, durationMs, stderr, toolCapExceeded);
    },
  });
}
