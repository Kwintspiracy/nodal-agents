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
//      salir son dépôt pour une raison qui ne le regarde pas. Le prompt voyage
//      donc EN TÊTE DE STDIN, avec un en-tête qui le nomme, et il est renvoyé à
//      CHAQUE tour — voir `buildCodexStdin` pour pourquoi l'omettre à la
//      reprise était une erreur.
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
 * Le prompt est renvoyé à CHAQUE tour, reprise comprise.
 *
 * La première version l'omettait à la reprise, en se disant que la session le
 * portait déjà. C'était faux, et la revue Codex (27/08) l'a dit sans détour :
 * ce texte n'est pas qu'une personnalité. Il porte la mémoire de l'entité,
 * l'équipe, les dossiers, et l'instantané git — tout ce qui BOUGE entre deux
 * tours. L'omettre gelait l'agent sur l'état du premier message : un fichier
 * ajouté, un coéquipier attaché, une branche changée restaient invisibles
 * jusqu'à la fin du fil.
 *
 * Le coût est réel — ce texte revient dans le fil à chaque tour — et c'est le
 * même que celui que Claude paie avec `--append-system-prompt-file`, qu'il
 * repasse aussi à chaque tour. Un agent juste et un peu plus cher vaut mieux
 * qu'un agent bon marché qui travaille sur un état périmé.
 */
export function buildCodexStdin(opts: { message: string; personality: string }): string {
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
  const args = buildProviderArgs('codex', opts.mode, {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
  });

  // Les dossiers SECONDAIRES de l'agent (revue Codex, 27/08). `cwd` n'est que
  // le premier : sans `--add-dir`, un agent multi-dossiers voit les autres
  // annoncés dans son prompt et se les voit refuser à l'écriture — le prompt
  // promet ce que le bac à sable interdit.
  //
  // En lecture seule, il n'y a rien à ouvrir : le mode interdit déjà d'écrire
  // partout, et ajouter des racines n'y changerait rien.
  const extra = opts.mode === 'write' ? (opts.extraWriteDirs ?? []) : [];
  if (extra.length === 0) return args;
  // `-` doit rester EN DERNIER — c'est lui qui fait lire les instructions sur
  // stdin. On insère donc avant lui plutôt qu'on n'ajoute à la fin.
  const tail = args[args.length - 1] === '-' ? args.pop() : undefined;
  for (const dir of extra) args.push('--add-dir', dir);
  if (tail) args.push(tail);
  return args;
}

/** L'état de lecture d'un flux `codex exec --json`. */
export interface CodexParseState {
  sessionId: string | null;
  messages: string[];
  usage: ClaudeTurnResult['usage'];
  sawTurnCompleted: boolean;
  failure: string | null;
  unknownEventTypes: Set<string>;
  /**
   * Les appels d'outils dont le DÉBUT a été vu, et sous quels identifiants ils
   * ont été ouverts : un changement multi-fichiers en ouvre plusieurs pour un
   * seul identifiant d'item. Voir la fermeture.
   */
  openToolIds: Map<string, string[]>;
  /** Ceux déjà comptés pour le garde anti-boucle : jamais deux fois le même. */
  countedToolIds: Set<string>;
}

export function newCodexParseState(): CodexParseState {
  return {
    sessionId: null,
    messages: [],
    usage: null,
    sawTurnCompleted: false,
    failure: null,
    unknownEventTypes: new Set(),
    openToolIds: new Map(),
    countedToolIds: new Set(),
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
export function codexChangedPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const item = input as Record<string, unknown>;
  const changes = Array.isArray(item['changes']) ? item['changes'] : [];
  const paths = changes
    .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>)['path'] : null))
    .filter((p): p is string => typeof p === 'string' && p !== '');
  if (paths.length > 0) return paths;
  return typeof item['path'] === 'string' && item['path'] !== '' ? [item['path']] : [];
}

export function normalizeCodexToolInput(toolName: string, input: unknown): unknown {
  if (toolName !== 'file_change' || !input || typeof input !== 'object') return input;
  const [first] = codexChangedPaths(input);
  // Rien de reconnaissable : on rend l'item tel quel plutôt que de fabriquer un
  // chemin. Une ligne d'audit sans `file_path` est lisible ; un mauvais chemin
  // fabrique un projet fantôme dans l'onglet.
  if (!first) return input;
  // `file_path` est le nom que les deux surfaces cherchent — c'est la seule
  // raison de ce champ.
  return { ...(input as Record<string, unknown>), file_path: first };
}

/**
 * Un appel d'outil Codex → les appels que l'audit doit voir.
 *
 * UN par fichier touché quand c'est un `file_change` : les extracteurs de
 * l'onglet Code et du contexte des projets lisent `file_path`, au singulier, et
 * rien d'autre (revue Codex, 27/08). Ranger les autres chemins dans un
 * `file_paths` que personne ne lit revenait à ne compter que le premier fichier
 * — et à perdre entièrement les éditions appartenant à un autre projet.
 *
 * L'identifiant est suffixé par l'index pour que chaque ligne s'apparie avec sa
 * propre fin ; sans ça, deux `tool_use` partageraient un identifiant et le
 * second écraserait le premier dans la table d'appariement.
 */
export function expandToolCalls(
  id: string,
  name: string,
  input: unknown,
): Array<{ toolUseId: string; toolName: string; input: unknown }> {
  const paths = name === 'file_change' ? codexChangedPaths(input) : [];
  if (paths.length <= 1) {
    return [{ toolUseId: id, toolName: name, input: normalizeCodexToolInput(name, input) }];
  }
  const base = (input ?? {}) as Record<string, unknown>;
  return paths.map((p, i) => ({
    toolUseId: `${id}#${String(i)}`,
    toolName: name,
    input: { ...base, file_path: p },
  }));
}

/**
 * L'enveloppe que les surfaces Code reconnaissent comme un ÉCHEC.
 *
 * `isRefusedToolCall` (onglet Code) et le scan des projets ne connaissent que
 * deux formes : `<tool_use_error>` et `{"ok":false}`. Codex, lui, dit son échec
 * dans un champ `status` de son item — que personne ne lit. Un `file_change`
 * échoué était donc compté comme un fichier CHANGÉ, affiché dans le panneau
 * Changes, et pouvait faire naître un projet dans le contexte des agents (revue
 * Codex, 27/08).
 *
 * On n'apprend pas à deux consommateurs une troisième forme : on traduit à la
 * source, une fois, dans celle qu'ils connaissent déjà. La sortie d'origine est
 * conservée derrière l'enveloppe — l'audit doit rester lisible.
 */
const REFUSED_MARKER = '<tool_use_error>';

export function markRefusedIfFailed(item: unknown, output: string): string {
  const status = (item as Record<string, unknown> | undefined)?.['status'];
  if (status !== 'failed') return output;
  if (output.startsWith(REFUSED_MARKER)) return output;
  return `${REFUSED_MARKER}${output}`;
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
      const calls = expandToolCalls(live.event.id, live.event.name, live.event.input);
      // Les identifiants EXPANSÉS sont retenus, pas juste le brut : un
      // changement multi-fichiers ouvre `id#0`, `id#1`… et la fin ne porte que
      // `id`. Fermer sur le brut ne fermait AUCUNE des lignes ouvertes, et
      // toutes disparaissaient de l'audit (revue Codex, 27/08).
      state.openToolIds.set(
        live.event.id,
        calls.map((c) => c.toolUseId),
      );
      for (const call of calls) onEvent?.({ kind: 'tool_use', ...call });
    } else {
      // Une FIN sans DÉBUT n'est pas une anomalie chez Codex : un `file_change`
      // arrive normalement en `item.completed` seul (revue Codex, 27/08). Le
      // recorder apparie par identifiant — sans `tool_use` ouvert, il jetait
      // l'événement, et l'écriture disparaissait de l'onglet Code comme du
      // contexte des projets. On ouvre donc la paire ici, juste avant de la
      // fermer : mieux vaut une ligne complète a posteriori que rien.
      const item = evt['item'] as Record<string, unknown> | undefined;
      const opened = state.openToolIds.get(live.event.id);
      const calls: Array<{ toolUseId: string; toolName?: string; input?: unknown }> = opened
        ? opened.map((toolUseId) => ({ toolUseId }))
        : expandToolCalls(live.event.id, live.event.name, item);
      state.openToolIds.delete(live.event.id);
      for (const call of calls) {
        if (call.toolName !== undefined) {
          onEvent?.({
            kind: 'tool_use',
            toolUseId: call.toolUseId,
            toolName: call.toolName,
            input: call.input,
          });
        }
        onEvent?.({
          kind: 'tool_result',
          toolUseId: call.toolUseId,
          output: markRefusedIfFailed(item, (live.event.output ?? '').slice(0, OUTPUT_CAP)),
        });
      }
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
    const item = evt['item'] as Record<string, unknown> | undefined;
    if (!isCodexToolItem(item)) return false;
    if (typeof item?.['id'] === 'string') state.countedToolIds.add(item['id']);
    return true;
  }
  if (type === 'item.completed') {
    const item = evt['item'] as Record<string, unknown> | undefined;
    if (item?.['type'] === 'agent_message' && typeof item['text'] === 'string') {
      state.messages.push(item['text']);
      onEvent?.({ kind: 'assistant_text', text: item['text'] });
      return false;
    }
    // Un outil qui n'a JAMAIS eu de `item.started` n'a rien compté jusqu'ici.
    // C'est le cas normal d'un `file_change` (revue Codex, 27/08) : sans cette
    // ligne, une session qui n'écrit que des fichiers ne consomme aucun budget
    // et échappe entièrement au plafond de l'invariant #8.
    const id = typeof item?.['id'] === 'string' ? item['id'] : null;
    const jamaisOuvert = id !== null && !state.countedToolIds.has(id);
    if (isCodexToolItem(item) && jamaisOuvert) {
      state.countedToolIds.add(id);
      return true;
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
    // Un tour TUÉ par le délai est un échec, même s'il avait émis
    // `turn.completed` avant de se figer (revue Codex, 27/08) : sans ça, le
    // flux était complet, le code de sortie null, et le job se terminait
    // « réussi » alors qu'on venait de le tuer. Ce qui est livré à
    // l'utilisateur porterait le travail d'un processus qu'on a interrompu.
    timedOut ||
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
    stdin: buildCodexStdin({ message: opts.message, personality: opts.personality }),
    timeoutMs: opts.timeoutMs,
    ...(opts.maxToolCalls !== undefined ? { maxToolCalls: opts.maxToolCalls } : {}),
    // Codex ouvre un item d'outil par événement — jamais de lot, contrairement
    // aux appels parallèles de Claude. Le compte vaut donc 1 ou 0, mais il
    // passe par le même contrat pour que la mécanique n'ait pas deux cas.
    onLine: (line) => (handleCodexLine(state, line, opts.onEvent) ? 1 : 0),
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
