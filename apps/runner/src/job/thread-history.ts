// thread-history.ts — load recent prior turns from the same chat thread.
//
// Solves the "agent forgets what it just said 30 seconds ago" bug on Telegram
// (and other conversational channels). Each Telegram message creates its own
// `agent_jobs` row with a fresh `messages` array — without this helper, the
// LLM only sees the current turn, never the prior exchanges.
//
// CE QUE CE FICHIER DÉCIDE, DEPUIS P6 : ce qu'on RELIT, jamais où le fil
// commence. L'identité d'un fil est la CONVERSATION (job/conversation-id.ts,
// migration 0094) — une par chat, jusqu'à ce que l'utilisateur en ouvre une
// autre. La règle du silence de 4 h qui vivait ici et qui découpait les
// conversations a disparu : elle décidait l'identité, et elle la décidait mal
// (répondre le lendemain ouvrait un fil neuf sans que personne ne l'ait
// demandé). Ce qui reste est un BUDGET : MAX_TURNS tours, BUDGET_CHARS
// caractères, pour que la relecture d'une conversation qui dure des semaines
// ne finisse pas par remplir la fenêtre à elle seule.
//
// Algorithm (see ~/.claude/plans/compiled-nibbling-stroustrup.md):
// - Only conversational channels (telegram, slack, discord). Others are
//   one-shot invocations and get no prior history.
// - Query up to MAX_TURNS recent terminal jobs of the SAME CONVERSATION —
//   head jobs only (`parent_job_id IS NULL`): a delegated child inherits its
//   creator's conversation_id without ever having been a user message.
// - Emit one (user, assistant) pair per prior job, from (task, result).
//   Skip jobs without a result (hard fail / interrupted — the user saw
//   nothing on their side either, so showing the LLM a hole is just noise).
// - Per-turn cap: truncate any single message above PER_TURN_MAX_CHARS so a
//   gigantic prior reply can't blow the budget on its own.
// - Total budget: drop oldest pairs from the front until under BUDGET_CHARS.
//   Always drop a full pair — never an assistant orphan that would leave
//   the LLM staring at "[assistant] response with no preceding user msg".
// - Return chronological (oldest first) so the LLM reads the thread the
//   way the user lived it.
//
// Fail-soft: callers should wrap in try/catch so a DB hiccup never kills a
// job — at worst the agent loses session continuity for that turn.
//
// Action ledger (2026-07-11 incident, Layer 1 of the 3-layer fix — see
// chain-counters.ts Guard 1g for the incident write-up): a prior job's OWN
// prose is not a reliable record of what it actually did. Its exchange gets
// the runner's record of its REAL tool calls — a structural fact the LLM can't
// override with confabulated prose on a later turn. Since #1075 that record
// covers EVERY tool, without a hand-kept list: every tool named, and the head
// of each result of a tool not declared read-only quoted
// (`loadExchangeRecords`, exchange-record.ts). The 21 names of
// `STATE_CHANGING_TOOLS` it replaces left every MCP, file and shell tool out,
// and a rigorous model disowned real work it could not see.
//
// Delegated-task ledger (2026-07-12 incident — see task-ledger.ts): a prior
// job that DELEGATED work via `create_task` (planner fan-out) or in line
// (`assign_*`) did the real action in a child job. Each delegation gets its
// own line, sourced from the CHILD job's tools, not the parent's prose
// summary, and the child's acting calls are quoted under the same rule.
//
// WHERE those lines go (#562): in a runner record AFTER the exchange — a user
// message marked `[système]` (runnerRecord) — never in an assistant part. They
// used to ride as text parts of the replayed assistant turn, and a model that
// reads its own turns ending in `[Delegated to X (completed) …]` writes one:
// run b7ecc59a forged a delegation outcome that way. Same for a `relay`
// result (children recompiled by the runner): it is the runner's, not the
// agent's reply.
//
// WHEN each turn happened (#650, 30/09): every replayed message the person
// sent carries the time they sent it, `[Wed, 30 Sept 2026, 23:07] …`, in the
// user's timezone and with the formatter the system prompt uses for "now"
// (`formatLocalTime`). Replayed undated, a root agent's reply of 29/09 14:21
// ("that sub-agent is down") was read on 30/09 at 23:07 as a present fact. The date
// is a fact about the turn, not a rule: the prompt adds nothing. It sits on
// the person's messages only — a stamp in an assistant part is a pattern the
// model would continue in its own replies — and it never changes once the turn
// is past, so the replayed prefix stays byte-identical from one turn to the
// next. `datedTurn` is the one form, shared with the web chat (run-chat-turn.ts).
//
// THE DASHBOARD TOO (handoff.ts, 18/10). A job the chat front hands work to
// is a turn of its conversation like a Telegram job, and it got NO history:
// the worker of a correction (job 039f8666) never read the first message, in
// which the owner had said « rien n'est imprimé avant mon accord » — only the
// front's retelling of it. The rule is now the same for every channel: the
// prior turns of the conversation, the person's messages verbatim and dated,
// the agent's replies, under the same MAX_TURNS / BUDGET_CHARS. Only the
// SOURCE differs, because a dashboard turn can be answered without a job: its
// turns are its `chat_messages` (`loadDashboardHistory`), where a channel's
// are its head jobs.

import { eq, and, ne, desc, inArray, isNull, lt } from '@nodal-agents/db';
import { agentJobs, chatMessages } from '@nodal-agents/db';
import type { ModelMessage } from 'ai';
import type { RunnerDeps } from '../deps.ts';
import { loadExchangeRecords } from './exchange-record.ts';
import {
  conversationMoments,
  isJobEnded,
  reachedThePerson,
  taskEndedAt,
} from './conversation-moments.ts';
import { ownTranscript } from './tool-acts.ts';
import {
  formatLocalTime,
  inboxMessageReceivedAt,
  isInboxMessage,
  keepsTurnsInChat,
  runnerRecordMessage,
} from '@nodal-agents/shared';
import { messageText } from './state.ts';

/**
 * Channels that represent ongoing conversations. Others (`api`, `cron`,
 * `task-board`, `internal`) are one-shot invocations and never get prior
 * history injected.
 *
 * `whatsapp` a été AJOUTÉ le 06/09 (revue Codex, passe 28). Il manquait depuis
 * l'origine : le canal a un handler, une conversation, une ligne `conversations`
 * depuis P6 — et repartait pourtant sans aucun tour précédent à chaque message,
 * exactement le bug d'amnésie que ce fichier existe pour fermer. Rien ne le
 * justifiait ; c'était un oubli, pas une décision.
 */
const CONVERSATIONAL_CHANNELS: ReadonlySet<string> = new Set([
  'telegram',
  'slack',
  'discord',
  'whatsapp',
]);

/** Max prior (user, assistant) pairs to load — enough to hold a multi-step thread. */
const MAX_TURNS = 8;
/**
 * Total char budget across all loaded pairs (~16K chars ≈ ~4K tokens). Trivial
 * against a 200K–1M context window, but big enough to actually carry a real
 * conversation: these agents are verbose (measured median reply ≈ 1.3K chars,
 * p75 ≈ 3K), so the old 4K budget held barely 1–2 exchanges before dropping the
 * foundational turns — the agent looked like it "lost the thread".
 */
export const BUDGET_CHARS = 16_000;
/**
 * Per-message char cap — any single turn longer than this is truncated (head
 * + tail). Exported (with `truncate` below) so other history-loading call
 * sites needing the same token-budget-proxy behavior — e.g. run-chat-turn.ts
 * (F-12, audit #2) — reuse it instead of re-implementing it.
 */
export const PER_TURN_MAX_CHARS = 2_400;

export interface LoadThreadHistoryOptions {
  db: RunnerDeps['db'];
  /**
   * LA clé de la relecture depuis P6 : la conversation dont ce job est un tour.
   * `null` (job hors conversation, ou job d'avant P6 dont l'uuid ne pointe
   * aucune ligne) ⇒ pas d'historique. `entity_id` / `agent_id` ne servent plus
   * de clé — la conversation les porte déjà, et deux agents ne partagent jamais
   * une conversation.
   */
  conversationId: string | null;
  /**
   * Job's `channel` column — `telegram`, `slack`, etc. Toujours nécessaire :
   * il décide si ce canal a une histoire (CONVERSATIONAL_CHANNELS) et par quel
   * outil d'envoi le tour précédent a parlé (CHANNEL_SEND_TOOL).
   */
  channel: string;
  /** Current job's id — excluded from the prior-history query. */
  excludeJobId: string;
  /**
   * The user's IANA timezone, the one the system prompt states "now" in
   * (`DeploymentContext.timezone`). Each replayed message of the person is
   * dated in it (#650).
   */
  timezone: string;
}

/**
 * Load recent prior turns from the same chat thread, formatted as
 * `ModelMessage[]` ready to prepend to the current job's messages array.
 *
 * Returns `[]` (no error thrown) when:
 * - The channel is not conversational.
 * - `conversationId` is null.
 * - The conversation has no terminal prior head job.
 * - All candidate jobs have null/empty `result` (e.g. all soft-skipped).
 */
export async function loadThreadHistory(opts: LoadThreadHistoryOptions): Promise<ModelMessage[]> {
  // Le tableau de bord et un appareil (#945) rangent leurs tours dans
  // `chat_messages` : leur histoire se lit là, pas dans les jobs.
  if (keepsTurnsInChat(opts.channel)) return loadDashboardHistory(opts);
  if (!CONVERSATIONAL_CHANNELS.has(opts.channel)) return [];
  if (!opts.conversationId) return [];

  const rows = await opts.db
    .select({
      id: agentJobs.id,
      task: agentJobs.task,
      result: agentJobs.result,
      messages: agentJobs.messages,
      channel: agentJobs.channel,
      createdAt: agentJobs.createdAt,
      completedAt: agentJobs.completedAt,
      resultKind: agentJobs.resultKind,
      runnerNotes: agentJobs.runnerNotes,
    })
    .from(agentJobs)
    .where(
      and(
        eq(agentJobs.conversationId, opts.conversationId),
        // Les tours du fil sont ses jobs de TÊTE : un enfant délégué hérite du
        // `conversation_id` de son créateur sans avoir été un message.
        isNull(agentJobs.parentJobId),
        // Terminal jobs that produced a user-facing turn — NOT just 'completed'.
        // A job that FAILED (e.g. the agent asked the user to launch ComfyUI, so
        // the generation couldn't finish) still DELIVERED a message the user saw
        // and replied to. Excluding it broke continuity: on the user's reply the
        // agent had no memory of what it had asked. extractAssistantReply returns
        // null for failed jobs with no usable result, so silent internal failures
        // are still skipped — only failures that spoke to the user are carried.
        inArray(agentJobs.status, ['completed', 'failed']),
        ne(agentJobs.id, opts.excludeJobId),
      ),
    )
    .orderBy(desc(agentJobs.createdAt))
    .limit(MAX_TURNS);

  // Flip to chronological (oldest first) so the budget loop drops the OLDEST
  // blocks first. Plus de marche par silences : les MAX_TURNS derniers tours de
  // la conversation SONT la relecture — leur âge ne les disqualifie plus, seul
  // le budget les écarte.
  const chronological = [...rows].reverse();

  // Ce que l'agent a répondu à chaque tour, lu AVANT le relevé : les appels
  // qui ont livré cette réponse sont déjà redonnés comme son tour, le relevé
  // ne les redit pas (#1075). Une seule lecture, ici, pour les deux.
  const replies = new Map(chronological.map((row) => [row.id, replyOfRow(row)]));

  // Le relevé de chaque tour (#1075, exchange-record.ts) : ses outils, ce que
  // ceux qui agissent ont rendu, et ses délégations — `create_task` comme EN
  // LIGNE (`assign_*`, incident du 26/08) : sans elles, un tour où
  // l'orchestrateur a réellement délégué et un tour où il a inventé le compte
  // rendu arrivaient identiques dans l'historique.
  const records = await loadExchangeRecords(
    opts.db,
    chronological.map((r) => r.id),
    new Map([...replies].map(([id, r]) => [id, r.reply?.callIds ?? new Set<string>()])),
  );

  // Each "block" is a contiguous slice of messages we keep or drop together
  // — either a 2-message `[user, assistant-text]` pair (no send-tool path)
  // or a 3-message `[user, assistant-tool-call, tool-result]` block (when
  // the channel has a send-tool mapping, e.g. telegram). The 3-message
  // shape is required so the LLM sees "reply via the channel send tool"
  // as the prior pattern and keeps using it on the current turn — a
  // text-only assistant shape was empirically observed to teach the LLM
  // to skip the tool entirely (job c25447d8, 2026-05-25).
  let nextSynthId = 0;
  const blocks: ModelMessage[][] = [];
  for (const row of chronological) {
    // Ce que le runner a écrit ne passe JAMAIS pour les mots de l'agent (#562),
    // et cela se lit à ses marques EXPLICITES, jamais à une absence :
    //  - `relay` : le texte d'AUTRES jobs recompilé par le runner (les enfants,
    //    dans fillResultFromChildrenIfEmpty comme dans failJob). Le rejouer comme
    //    ce que l'agent avait envoyé lui apprenait à écrire lui-même
    //    « ## Researcher\n… » — 12 887 caractères inventés par l'agent racine du
    //    run b7ecc59a avant que son enfant ne démarre. Il part tout entier dans
    //    le relevé ; la réponse de l'agent est ce qu'il a dit dans son tour.
    //  - `runner_notes` : les lignes que le runner a ajoutées à un résultat
    //    (avis d'échec de délégation, explication générique d'un échec, ligne
    //    d'un livrable non vérifié ; 0137 rattrape les lignes plus anciennes).
    //    Elles sont retirées des mots de l'agent et rangées dans le relevé.
    // `result_kind` NULL dit « provenance inconnue » : 0117 a laissé toutes les
    // lignes plus anciennes sans marque, et une vraie réponse d'avant n'existe
    // parfois que dans `result`. Elle reste lue comme avant cette PR — la
    // réponse de l'agent, moins ce que `runner_notes` reconnaît (revue Codex de
    // #576, passe 2). Voir `replyOfRow`.
    const { agentsOwnResult, runnerNotes, agentsWords, reply } = replies.get(row.id)!;
    const assistant = reply?.text ?? null;
    // Un texte que l'agent a lui-même envoyé n'est pas redit par le relevé.
    const unmarked = agentsOwnResult ? '' : (agentsWords ?? '').trim();
    const runnerResult = unmarked === (assistant ?? '').trim() ? '' : unmarked;
    // Ce que la personne a écrit PENDANT ce tour, remis au travail en cours
    // (#531) : rejoué juste après sa demande, pour que la précision ne
    // disparaisse pas des tours suivants. Lu à sa marque structurelle.
    // Chacun porte l'heure où il est ARRIVÉ (`receivedAt`), pas celle de la demande.
    const followUps: ModelMessage[] = (Array.isArray(row.messages) ? row.messages : [])
      .filter(isInboxMessage)
      .map((m) => ({
        text: messageText((m as { content?: unknown }).content).trim(),
        at: inboxReceivedAt(m, row.id),
      }))
      .filter(({ text }) => text !== '')
      .map(({ text, at }) => ({
        role: 'user',
        content: datedTurn(truncate(text), at, opts.timezone),
      }));
    if (!row.createdAt) throw new Error(`thread history: agent_jobs ${row.id} has no created_at`);
    const asked: ModelMessage[] = [
      { role: 'user', content: datedTurn(truncate(row.task), row.createdAt, opts.timezone) },
      ...followUps,
    ];
    // Un tour sans aucune trace n'est pas relu. Ce que ses outils ont fait en
    // est une (#1075) : un tour dont le seul envoi est parti vers une autre
    // personne n'a pas de réponse relue, mais il a agi, et il ne disparaît pas.
    if (
      assistant === null &&
      runnerResult === '' &&
      runnerNotes.length === 0 &&
      followUps.length === 0 &&
      !records.has(row.id)
    ) {
      continue;
    }

    // Le relevé de ses outils et de ses délégations (voir l'en-tête), puis ce
    // que le runner a écrit de son résultat.
    const allLedgerLines = [
      ...(records.get(row.id) ?? []),
      ...(runnerResult !== '' ? [truncate(runnerResult)] : []),
      ...runnerNotes,
    ];
    // Ce que le runner a écrit de ce tour vient APRÈS lui, dans un message à
    // part dont la provenance est structurelle — jamais dans une part
    // assistant (#562). Voir @nodal-agents/shared, runner-record.ts.
    const record: ModelMessage[] =
      allLedgerLines.length > 0 ? [runnerRecordMessage(allLedgerLines) as ModelMessage] : [];

    if (assistant === null) {
      // Un tour où l'agent n'a rien dit lui-même : seul le relevé en reste.
      blocks.push([...asked, ...record]);
      continue;
    }

    const sendTool = CHANNEL_SEND_TOOL[row.channel];
    if (sendTool) {
      const callId = `history-tool-${nextSynthId++}`;
      blocks.push([
        ...asked,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: callId,
              toolName: sendTool,
              input: { text: truncate(assistant) },
            },
          ],
        } as ModelMessage,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              toolName: sendTool,
              // La même forme de RÉSULTAT que l'outil rend en vrai
              // (`{sent: true}`). Un tour rejoué reste reconnaissable par
              // ailleurs — identifiant `history-tool-N`, texte tronqué, lignes
              // d'actions ajoutées — et cette ligne ne prétend pas le contraire
              // (revue Codex, PR #48, qui a corrigé la première version de ce
              // commentaire). Ce qu'elle corrige est plus étroit et suffisant :
              // `{messageId: 'history'}` donnait au modèle une CHAÎNE à
              // interpréter, exactement ce dont il s'est saisi le 08/09 en
              // prenant « 2311 » pour une réponse de l'utilisateur.
              output: { type: 'json', value: { sent: true } },
            },
          ],
        } as ModelMessage,
        ...record,
      ]);
    } else {
      blocks.push([...asked, { role: 'assistant', content: truncate(assistant) }, ...record]);
    }
  }

  // Apply total char budget: drop oldest blocks (from the front) until under.
  // Each iteration drops one full block — never leaves orphan tool-results
  // or unpaired assistant tool-calls behind.
  while (blocks.length > 0 && totalChars(blocks) > BUDGET_CHARS) {
    blocks.shift();
  }

  return blocks.flatMap((b) => b);
}

/** Au-delà, une conversation du tableau de bord n'est pas relue plus loin : le budget l'arrête bien avant. */
const DASHBOARD_ROWS_LIMIT = 200;

/**
 * L'historique d'un job du TABLEAU DE BORD : les tours de sa conversation tels
 * que la personne les a vécus, lus dans `chat_messages` — ses messages, mot
 * pour mot et datés, et les réponses de l'agent, celles du chat comme le
 * résultat d'un job qu'il a lancé. La même règle que les canaux : au plus
 * MAX_TURNS tours, sous BUDGET_CHARS, les plus anciens tombent d'abord.
 *
 * Ce qui précède le job, et lui seul : les lignes écrites avant sa création,
 * moins le message de la personne qui EST sa tâche (le dernier qui lui est
 * égal) — il ouvre le job, il n'est pas de l'historique.
 *
 * Ce que le runner a écrit d'un job lancé — un résultat recompilé (`relay`),
 * ses notes, les délégations — va dans le relevé `[système]`, jamais dans la
 * bouche de l'agent (#562), comme pour un canal.
 *
 * Depuis #1078, ce qu'un job lancé a produit (son résultat, puis ce relevé) est
 * relu à l'heure où il a FINI, pas sous le tour qui l'a lancé : le même ordre
 * que le tour de chat (conversation-moments.ts). Au lancement, les mots de
 * l'agent de cette ligne.
 */
async function loadDashboardHistory(opts: LoadThreadHistoryOptions): Promise<ModelMessage[]> {
  if (!opts.conversationId) return [];
  const [current] = await opts.db
    .select({ task: agentJobs.task, createdAt: agentJobs.createdAt })
    .from(agentJobs)
    .where(eq(agentJobs.id, opts.excludeJobId));
  if (!current?.createdAt) {
    throw new Error(`thread history: agent_jobs ${opts.excludeJobId} has no created_at`);
  }
  const rows = await opts.db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
      jobId: chatMessages.jobId,
      jobStatus: agentJobs.status,
      jobCompletedAt: agentJobs.completedAt,
      spokenAnnouncement: agentJobs.spokenAnnouncement,
      result: agentJobs.result,
      resultKind: agentJobs.resultKind,
      runnerNotes: agentJobs.runnerNotes,
    })
    .from(chatMessages)
    .leftJoin(agentJobs, eq(chatMessages.jobId, agentJobs.id))
    .where(
      and(
        eq(chatMessages.conversationId, opts.conversationId),
        lt(chatMessages.createdAt, current.createdAt),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(DASHBOARD_ROWS_LIMIT);
  const chronological = [...rows].reverse();
  for (let i = chronological.length - 1; i >= 0; i--) {
    const r = chronological[i]!;
    if (r.role === 'user' && r.content === current.task) {
      chronological.splice(i, 1);
      break;
    }
  }

  // LES MOMENTS de la conversation, dans l'ordre où ils ont eu lieu (#1078,
  // conversation-moments.ts) — le même ordre que le tour de chat. La fin d'un
  // job lancé est un moment, à l'heure où il a fini. « Ce qui précède le job, et
  // lui seul » : un job lancé n'a fini, pour ce lecteur, que s'il a fini AVANT
  // la création du job qu'on démarre. Sinon il est relu comme un travail encore
  // en cours, et l'historique de ce job ne dépend pas de ce qui arrive après
  // son départ.
  type Row = (typeof chronological)[number];
  const createdAt = current.createdAt;
  const endOf = (r: Row): Date | null => {
    if (!r.jobId) return null;
    const endedAt = taskEndedAt({ status: r.jobStatus, completedAt: r.jobCompletedAt });
    return endedAt !== null && endedAt < createdAt ? endedAt : null;
  };
  const moments = conversationMoments(chronological, (r) => ({
    writtenAt: r.createdAt,
    endedAt: endOf(r),
  }));

  // Un tour : un message de la personne, et ce qui suit jusqu'au suivant (les
  // réponses de l'agent, les fins de job). On garde ou on jette un tour entier,
  // jamais une moitié. Seuls les MAX_TURNS derniers peuvent être relus : les
  // relevés ne se lisent que pour eux.
  const turns: Array<typeof moments> = [];
  for (const m of moments) {
    const last = turns[turns.length - 1];
    if ((m.kind === 'row' && m.row.role === 'user') || !last) turns.push([m]);
    else last.push(m);
  }
  const first = Math.max(0, turns.length - MAX_TURNS);
  const records = await loadExchangeRecords(
    opts.db,
    turns
      .slice(first)
      .flat()
      .flatMap((m) => (m.kind === 'row' ? [m.row.jobId] : [])),
  );

  /**
   * Ce que le job lancé a produit, dans les formes de ce lecteur : son propre
   * résultat comme les mots de l'agent, puis le relevé du runner (ses outils,
   * un résultat recompilé, ses notes).
   */
  const outcome = (row: Row) => {
    const runnerNotes = Array.isArray(row.runnerNotes) ? row.runnerNotes : [];
    return {
      own: row.resultKind !== 'relay' ? withoutRunnerNotes(row.result, runnerNotes) : null,
      relay: row.resultKind === 'relay' ? (row.result ?? '').trim() : '',
      runnerNotes,
    };
  };
  const spokenAndRecord = (said: string, recordLines: readonly string[]): ModelMessage[] => [
    ...(said !== '' ? [{ role: 'assistant', content: truncate(said) } as ModelMessage] : []),
    ...(recordLines.length > 0 ? [runnerRecordMessage(recordLines) as ModelMessage] : []),
  ];
  const recordOf = (row: Row, out: ReturnType<typeof outcome> | null): string[] => [
    ...(records.get(row.jobId!) ?? []),
    ...(out && out.relay !== '' ? [truncate(out.relay)] : []),
    ...(out?.runnerNotes ?? []),
  ];

  const messagesOf = (m: (typeof moments)[number]): ModelMessage[] => {
    const row = m.row;
    if (m.kind === 'end') {
      // La fin du job, à l'heure où il a fini : ce qu'il a produit.
      const out = outcome(row);
      return spokenAndRecord((out.own ?? '').trim(), [
        ...recordOf(row, out),
        // Ce qui a atteint la personne à la fin, quand c'est rangé.
        ...reachedThePerson(row.spokenAnnouncement, truncate),
      ]);
    }
    if (row.role === 'user') {
      if (!row.createdAt) throw new Error('thread history: a chat_messages row has no created_at');
      return [
        { role: 'user', content: datedTurn(truncate(row.content), row.createdAt, opts.timezone) },
      ];
    }
    if (!row.jobId) return spokenAndRecord(row.content.trim(), []);
    // Un job fini SANS heure de fin rangée garde son issue sous son lancement,
    // comme avant #1078 : il n'a pas de moment où la poser.
    const unplaced = row.jobCompletedAt === null && isJobEnded(row.jobStatus);
    // Une fin placée plus loin, ou un travail encore en cours pour ce lecteur :
    // au lancement, les mots de l'agent et ce que ses outils ont fait.
    const out = unplaced ? outcome(row) : null;
    const said = [row.content.trim(), (out?.own ?? '').trim()].filter((t) => t !== '').join('\n\n');
    return spokenAndRecord(said, endOf(row) !== null ? [] : recordOf(row, out));
  };

  // Un tour jeté (au-delà de MAX_TURNS, ou par le budget) emporte la fin des
  // jobs qu'il a lancés : une fin n'est jamais relue sans son lancement.
  const assemble = (from: number): ModelMessage[][] => {
    const dropped = new Set(
      turns
        .slice(0, from)
        .flat()
        .flatMap((m) => (m.kind === 'row' ? [m.row] : [])),
    );
    return turns
      .slice(from)
      .map((turn) =>
        turn.filter((m) => !(m.kind === 'end' && dropped.has(m.row))).flatMap(messagesOf),
      )
      .filter((b) => b.length > 0);
  };
  let from = first;
  let kept = assemble(from);
  while (kept.length > 0 && totalChars(kept) > BUDGET_CHARS) kept = assemble(++from);
  return kept.flatMap((b) => b);
}

/**
 * A message of the person as it is replayed: the time they sent it, then their
 * words (#650). `[Wed, 30 Sept 2026, 23:07] Fais-moi une recherche…` — the same
 * wall-clock form as the prompt's "now", so the model compares like with like,
 * and the same for every turn, today's included. A past turn's stamp never
 * changes: the replayed prefix stays stable for prompt caching.
 */
export function datedTurn(text: string, at: Date, timezone: string): string {
  return `[${formatLocalTime(timezone, at)}] ${text}`;
}

/** L'heure d'arrivée d'un message remis (#531) ; la plateforme la pose à chaque remise. */
function inboxReceivedAt(message: unknown, jobId: string): Date {
  const receivedAt = inboxMessageReceivedAt(message);
  const at = receivedAt === null ? null : new Date(receivedAt);
  if (!at || Number.isNaN(at.getTime())) {
    throw new Error(`thread history: an inbox message of agent_jobs ${jobId} has no receivedAt`);
  }
  return at;
}

/**
 * Le résultat sans les lignes que le runner y a ajoutées. Elles y sont posées
 * par `stampFailedDelegations` à la fin, séparées par une ligne vide, et
 * `runner_notes` dit exactement lesquelles : aucune supposition sur le texte.
 */
function withoutRunnerNotes(result: string | null, notes: readonly string[]): string | null {
  if (result === null) return null;
  let text = result;
  for (const note of [...notes].reverse()) {
    if (text === note) text = '';
    else if (text.endsWith(`\n\n${note}`)) text = text.slice(0, -(note.length + 2));
  }
  return text;
}

/**
 * Map of channel → the tool the agent uses to emit a user-visible reply.
 * For conversational channels, the user-facing text typically lives inside
 * a `*_send_message` tool call rather than in `return_result` — the agent
 * delivers the answer through the channel API directly, and only acks via
 * `return_result({status: 'success'})` with no text. Without this lookup we
 * lose the user-visible reply and the next turn's session-memory context
 * comes back empty.
 *
 * S3 (multichannel plan): exported so a later phase can extend this map
 * per-channel once other channels get their OWN send tool name.
 *
 * WhatsApp est dans CONVERSATIONAL_CHANNELS et VOLONTAIREMENT absent d'ici : il
 * n'a pas d'outil d'envoi à lui, et les noms des outils de livraison ne
 * changeront qu'à cette phase-là. Un tour WhatsApp est donc relu sous la forme
 * TEXTE à deux messages, pas sous la forme appel d'outil à trois — poser ici un
 * nom d'outil qui n'existe pas apprendrait au modèle à appeler le vide.
 * (Le commentaire disait l'inverse jusqu'au 06/09 : il affirmait que WhatsApp
 * était dans l'ensemble au-dessus, ce qui était faux — revue Codex, passe 28.)
 *
 * Discord/Slack ingress (D2, K2): a discord or slack job's send tool IS
 * 'telegram_send_message' — the 6 delivery tools are registered by
 * CREDENTIAL AVAILABILITY, not by channel-specific name (see execute.ts's
 * capabilityTools gating and delivery-guard.ts's
 * resolveChannelForJob/resolveBotToken), and the tool itself already
 * dispatches through the channel-neutral ChannelAdapter resolved from the
 * job's OWN channel. Reusing the telegram-named tool for a discord/slack job
 * is functionally correct but semantically odd — renaming the 6 tools to
 * channel-neutral names (e.g. `send_message`) is cleanup-phase work, not
 * this ticket.
 */
export const CHANNEL_SEND_TOOL: Readonly<Record<string, string>> = {
  telegram: 'telegram_send_message',
  discord: 'telegram_send_message',
  slack: 'telegram_send_message',
};

/**
 * Resolve the assistant's user-visible reply for a prior job, using a
 * fallback chain (rationale in the file header):
 *   1. `result` column when populated — long-form return_result with text.
 *   2. Concatenated `text` from every `<channel>_send_message` tool call in
 *      the messages array (the actual user-visible reply for conversational
 *      channels), whatever its target (#1077). Their call ids come back with
 *      it: the runner record does not repeat them (#1075).
 *   3. Last assistant message's text content — covers exotic flows that
 *      neither populated `result` nor used the channel send tool.
 *   4. `null` to signal "skip this job".
 *
 * Important — session-memory chaining defense: each prior job's `messages`
 * JSONB contains BOTH its own turns AND the history that was injected into
 * IT when it ran (a chain effect). When we extract a reply via fallbacks
 * #2 / #3, we must restrict the search to the prior job's OWN turns,
 * otherwise we surface text from much older jobs and the per-turn
 * truncation chops the actually-relevant tail. The boundary is the user
 * message whose content equals `agent_jobs.task` — everything from that
 * index onwards is the job's own content. Empirically observed on job
 * 9c22d5b3 (2026-05-26) where 3 Stripe-related prior jobs all returned
 * the same stale MCP pre-amble before this fix.
 */
/**
 * Ce que l'agent a répondu à un tour passé, et ce qui en vient : ses propres
 * mots (`result` moins ce que le runner y a écrit), et la réponse relue.
 */
function replyOfRow(
  row: {
    task: string;
    result: string | null;
    messages: unknown;
    channel: string;
    resultKind: string | null;
    // Typed through `Record`: `runner-notes-one-writer.test.ts` reads a key
    // followed by a colon as a write, and this is a read of the stored column.
  } & Record<'runnerNotes', unknown>,
) {
  const agentsOwnResult = row.resultKind !== 'relay';
  const runnerNotes = Array.isArray(row.runnerNotes) ? (row.runnerNotes as string[]) : [];
  const agentsWords = withoutRunnerNotes(row.result, runnerNotes);
  const reply = extractAssistantReply({
    task: row.task,
    result: agentsOwnResult ? agentsWords : null,
    messages: row.messages,
    channel: row.channel,
  });
  return { agentsOwnResult, runnerNotes, agentsWords, reply };
}

/**
 * La réponse relue d'un tour, et les appels qui l'ont LIVRÉE (#1075) : ceux-là
 * sont déjà redonnés comme le tour de l'agent, le relevé ne les redit pas.
 * Vide quand la réponse vient de `result` ou d'un texte de l'assistant.
 *
 * Tout appel de l'outil d'envoi du canal est lu comme la réponse, quelle que
 * soit sa cible : la lecture d'avant #1075, inchangée. Un envoi vers une autre
 * personne est donc relu comme des mots dits à celle-ci et n'est pas dans le
 * relevé ; c'est le défaut que décrit #1077 (où un message est parti n'est
 * rangé nulle part), ni créé ni aggravé ici.
 */
interface AssistantReply {
  text: string;
  callIds: ReadonlySet<string>;
}

function extractAssistantReply(row: {
  task: string;
  result: string | null;
  messages: unknown;
  channel: string;
}): AssistantReply | null {
  // 1. result column.
  if (row.result !== null && row.result !== undefined && row.result.trim() !== '') {
    return { text: row.result, callIds: new Set() };
  }

  // The boundary between injected history and the job's own turns — the same
  // one its tool record reads (`ownTranscript`, tool-acts.ts).
  const messages = ownTranscript(row.messages, row.task);

  // 2. channel-specific send-message tool calls (within current-job slice).
  const sendTool = CHANNEL_SEND_TOOL[row.channel];
  if (sendTool) {
    const parts: string[] = [];
    const callIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as {
          type?: unknown;
          toolName?: unknown;
          toolCallId?: unknown;
          input?: unknown;
        };
        if (part.type !== 'tool-call' || part.toolName !== sendTool) continue;
        const input = part.input;
        if (input && typeof input === 'object' && 'text' in input) {
          const text = (input as { text: unknown }).text;
          if (typeof text === 'string' && text.trim() !== '') {
            parts.push(text);
            if (typeof part.toolCallId === 'string') callIds.add(part.toolCallId);
          }
        }
      }
    }
    if (parts.length > 0) return { text: parts.join('\n\n'), callIds };
  }

  // 3. last assistant text content (within current-job slice).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const content = msg.content;
    if (typeof content === 'string' && content.trim() !== '') {
      return { text: content, callIds: new Set() };
    }
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: unknown; text?: unknown };
        if (part.type === 'text' && typeof part.text === 'string') textParts.push(part.text);
      }
      const joined = textParts.join('');
      if (joined.trim() !== '') return { text: joined, callIds: new Set() };
    }
  }

  // 4. nothing to show.
  return null;
}

/**
 * Cap a single turn at PER_TURN_MAX_CHARS, keeping BOTH the head AND the tail
 * (70/30). A long agent reply's TAIL is usually the most load-bearing part for
 * continuity — the conclusion, the next step, the question to the user ("…now
 * launch ComfyUI and tell me when it's ready"). The old head-only slice dropped
 * exactly that tail, so the next turn lost the instruction it was replying to.
 */
export function truncate(s: string): string {
  if (s.length <= PER_TURN_MAX_CHARS) return s;
  const head = Math.floor(PER_TURN_MAX_CHARS * 0.7);
  const tail = PER_TURN_MAX_CHARS - head;
  return s.slice(0, head) + ' […truncated…] ' + s.slice(s.length - tail);
}

function totalChars(blocks: ReadonlyArray<ReadonlyArray<ModelMessage>>): number {
  let total = 0;
  for (const block of blocks) {
    for (const msg of block) {
      const content = msg.content;
      if (typeof content === 'string') {
        total += content.length;
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: unknown; text?: unknown; input?: unknown };
        if (part.type === 'text' && typeof part.text === 'string') {
          total += part.text.length;
        } else if (part.type === 'tool-call' && part.input && typeof part.input === 'object') {
          const text = (part.input as { text?: unknown }).text;
          if (typeof text === 'string') total += text.length;
        }
        // tool-result parts (synthetic) contribute negligible chars; ignore
        // in the budget so a couple of tokens of JSON acks don't push us over.
      }
    }
  }
  return total;
}
