// job/exchange-record.ts — ce que le runner écrit des outils d'un échange passé (#1075).
//
// LE DÉFAUT. Un échange redonné à un agent portait ses mots et pas ce que ses
// outils avaient fait. La seule trace structurelle, `[Actions performed in this
// exchange: …]`, n'était écrite que pour 21 noms d'outils intégrés tenus à la
// main (`STATE_CHANGING_TOOLS`) : un outil MCP, un outil de fichier,
// `run_command` ne laissaient rien. Un modèle rigoureux lisait alors son propre
// message plein de résultats précis, sans aucun appel avant lui, le prenait
// pour une invention, le désavouait devant la personne et refaisait le
// travail. Mesuré sur l'appel réel : avec les noms des outils ET les deux
// premières lignes du résultat de l'outil qui agit, le modèle retrouve son
// travail 5 fois sur 5, pour +193 jetons d'entrée (+0,5 %).
//
// LA RÈGLE, pour tout outil et sans liste tenue à la main :
//   [Actions performed in this exchange: tool_a, tool_b ×2, tool_c]
//   tool_b → <ce que l'appel a rendu, sur une ligne, à sa borne>
// Chaque outil appelé est nommé. Chaque appel qui n'était pas DÉCLARÉ en
// lecture seule AU MOMENT DE L'APPEL est cité (une ligne `nom → citation`). Des
// citations identiques se disent une fois avec leur compte (`nom ×N → …`).
//
// CE QUI EST LU COMME « CE QUI S'EST PASSÉ » (#1101). Le relevé est lu ainsi
// par le modèle : il ne dit donc que ce qui est acquis. Une phrase fausse dite
// à la personne le 14/11 l'a montré. Les mots du cadre vivent dans
// record-words.ts :
//   - un job qui n'a pas fini est dit par ses outils appelés jusque-là, sans
//     citation (`running`) : un appel raté qu'il refait n'est pas son issue ;
//   - un échec qu'un appel RÉUSSI du même outil a refait ensuite n'est pas
//     cité, il est compté sur ce succès (`nom (after 1 failed attempt) → …`) ;
//     un échec que rien n'a refait est cité, et dit (`nom (failed) → …`).
//     L'issue est lue sur ce que le runner a RANGÉ (`callOutcome`), jamais
//     sur les mots d'un résultat ;
//   - une citation qui ne tient pas entière garde ses deux premières lignes,
//     coupées entre deux mots, et finit par `…`. Une note de coupe a été
//     mesurée (15/11, modèle en service) : elle ne changeait pas ce que le
//     modèle lit, et coûtait +2,8 % par tour ; elle n'est pas posée. Une
//     réponse coupée avant la phrase qui la tranche reste trompeuse : c'est
//     la suite de #1101, pas réglée ici.
// Ce que le runner dit d'un appel est AVANT la flèche ; ce que l'outil a dit,
// APRÈS : un texte rangé ne peut pas imiter les mots du runner.
//
// « Déclaré » est un fait de l'APPEL, rangé quand il a tourné, jamais relu sur
// les déclarations du jour : la ligne `tool_calls` de l'appel porte le
// `risk_level` que l'outil déclarait (`read` pour un outil du produit ou une
// opération de connecteur en lecture seule) et, depuis 0166, le `readOnlyHint`
// qu'un serveur MCP donnait à son outil. Un appel sans ligne, ou dont la ligne
// ne dit pas « lecture seule », agit : le relevé en montre plus, jamais moins.
// Un `readOnlyHint` ajouté ou retiré après coup, un serveur supprimé, un second
// serveur du même nom ne changent donc rien au relevé d'un échange passé.
//
// CE QUI N'EST PAS UNE ACTION DE L'ÉCHANGE n'y figure pas : les appels qui ont
// livré la réponse que l'historique redonne déjà comme le tour de l'agent
// (désignés par celui qui la lit, `extractAssistantReply`), et la fin du job
// (`return_result`). Un échange qui n'a fait que répondre n'a aucun relevé. Un
// envoi qui n'est pas cette réponse (une image, un fichier, un message vers une
// autre personne ou un autre canal) reste une action, nommée et citée.
//
// UN CONSTRUCTEUR, TROIS LECTEURS : le fil d'un canal et l'historique d'un job
// lancé depuis une conversation de chat (thread-history.ts), et l'historique
// du tour de chat lui-même, tableau de bord et appareils (run-chat-turn.ts).
// Le travail d'un job délégué suit la même règle, sous la même borne.
//
// BORNES DITES (invariant #4) : au plus MAX_TOOL_NAMES noms par liste (le reste
// compté), NAME_MAX_CHARS par nom, RESULT_HEAD_MAX_CHARS par citation, au plus
// MAX_QUOTED_RESULTS citations distinctes par échange, les DERNIÈRES (celles
// qui tombent sont comptées), au plus 3 tâches et 3 délégations en ligne
// (task-ledger.ts), chaque texte de la base coupé à sa borne. Un relevé tient
// donc sous MAX_RECORD_CHARS, prouvé par le test du pire échange.
//
// PRÉFIXE STABLE : le relevé d'un échange passé est le même, octet pour octet,
// d'un tour au suivant (cache de prompt). Il ne vient que de ce que le job a
// rangé, dans un ordre déterministe : un job terminé ne range plus rien, son
// relevé ne bouge plus. Celui d'un job encore en cours (une seule ligne, ses
// outils appelés) change quand il appelle un outil de plus, puis une fois,
// quand il finit : il prend alors sa forme d'échange terminé, et n'en bouge
// plus.
//
// UNE LIGNE, TOUJOURS. Les premiers caractères du résultat d'un outil web ou
// MCP, un nom d'outil, le titre d'une tâche, le nom d'un agent viennent de la
// base et peuvent être écrits par un tiers. Chaque ligne du relevé passe par
// `oneLine` (tool-acts.ts) : tout séparateur de ligne ou de paragraphe Unicode
// et tout caractère de contrôle y devient une espace. Une citation commence
// toujours par le nom de l'outil et la flèche : elle ne peut ni ouvrir une
// ligne du relevé à elle, ni se faire passer pour une entrée du runner. Le
// cadre de la plateforme est retiré, les secrets masqués (`resultHead`).

import { and, inArray, isNotNull } from '@nodal-agents/db';
import { agentJobs, toolCalls } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import { isJobEnded } from './conversation-moments.ts';
import { RECORD_WORDS, type RecordWords } from './record-words.ts';
import {
  formatInlineDelegationEntry,
  formatTaskLedgerEntry,
  loadInlineDelegationLedger,
  loadTaskLedger,
  type InlineDelegationEntry,
  type TaskLedgerEntry,
} from './task-ledger.ts';
import {
  callOutcome,
  jobActs,
  oneLine,
  recordField,
  resultHead,
  toolNames,
  NAME_MAX_CHARS,
  type JobActs,
  type ToolCallFact,
} from './tool-acts.ts';

/** Au plus ce nombre de citations distinctes par échange : les dernières. */
export const MAX_QUOTED_RESULTS = 8;

/**
 * La taille maximale du relevé d'un échange (ses entrées jointes par un saut
 * de ligne), toutes bornes atteintes à la fois. Le test du pire échange
 * (exchange-record.test.ts) la vérifie ; avec un message de la personne et une
 * réponse à leur borne (2 × PER_TURN_MAX_CHARS), le tour tient sous le budget
 * du fil (BUDGET_CHARS) : il n'est jamais jeté pour son relevé.
 */
export const MAX_RECORD_CHARS = 9_000;

/** L'appel `callId` du job `jobId` était-il déclaré en lecture seule quand il a tourné ? */
export type DeclaredReadOnly = (jobId: string, callId: string | null) => boolean;

/** Un job dont le relevé dit les actes : son id (les déclarations rangées s'y lisent). */
type Acting = JobActs & { jobId: string | null };

/** Ce que le relevé d'un échange dit : le job de tête, et ce qu'il a délégué. */
export interface ExchangeFacts {
  /**
   * Le job de tête a-t-il fini, pour le lecteur (#1101) ? Un job qui n'a pas
   * fini n'est dit que par les outils qu'il a appelés : rien de ce qu'ils ont
   * rendu, ni de ce qu'ont rendu ses délégations, n'est encore son issue.
   */
  ended: boolean;
  own: Acting;
  tasks: readonly TaskLedgerEntry[];
  inline: readonly InlineDelegationEntry[];
}

/**
 * Les lignes du relevé d'un échange : les outils du job de tête, puis chaque
 * délégation, chacune suivie des résultats cités de ses appels qui agissent.
 * Un échange sans aucun appel et sans délégation n'a aucune ligne.
 *
 * Un job qui n'a pas fini (#1101) : UNE ligne, ses outils appelés jusque-là
 * (`words.running`), et aucune citation. Ce qu'un appel a rendu pendant que le
 * job tourne n'est pas encore ce qui s'est passé : le 14/11, le relevé d'une
 * tâche en cours citait un premier envoi raté qu'elle refaisait déjà, et la
 * personne s'est entendu dire qu'il y avait un problème. Ce qui est acquis :
 * que le job tourne, et ce qu'il a appelé.
 *
 * `words` : les mots du cadre (record-words.ts), ceux du runner par défaut.
 * Pure : un rejeu rebâtit le relevé d'un vrai échange en lui passant ses faits.
 */
export function exchangeRecordLines(
  facts: ExchangeFacts,
  readOnly: DeclaredReadOnly,
  words: RecordWords = RECORD_WORDS,
): string[] {
  const ownNames = toolNames(facts.own);
  if (!facts.ended) return ownNames === '' ? [] : [oneLine(words.running(ownNames))];
  const sections: Array<{ header: string | null; acts: Acting }> = [
    { header: ownNames === '' ? null : words.actions(ownNames), acts: facts.own },
    ...facts.tasks.map((t) => ({ header: formatTaskLedgerEntry(t), acts: t })),
    ...facts.inline.map((d) => ({ header: formatInlineDelegationEntry(d), acts: d })),
  ];
  const quoted = sections.map((s) =>
    quotedCallLines(
      s.acts.calls.filter((c) => s.acts.jobId === null || !readOnly(s.acts.jobId, c.id)),
      words,
    ),
  );
  const total = quoted.reduce((n, q) => n + q.length, 0);
  let skip = Math.max(0, total - MAX_QUOTED_RESULTS);
  const left = skip;
  const lines: string[] = [];
  sections.forEach((s, i) => {
    if (s.header !== null) lines.push(s.header);
    for (const line of quoted[i]!) {
      if (skip > 0) {
        skip -= 1;
        if (skip === 0) lines.push(words.notQuoted(left));
        continue;
      }
      lines.push(line);
    }
  });
  // Le seul passage obligé : quoi qu'une ligne contienne, elle reste UNE ligne.
  return lines.map(oneLine);
}

/**
 * Les citations des appels qui agissent d'UN job, dans l'ordre (#1101), avant
 * la borne. Ce que le runner dit d'un appel vient de ce qu'il a RANGÉ de son
 * issue (`callOutcome`), jamais des mots du résultat :
 *  - un échec suivi, plus tard dans le même job, d'un appel RÉUSSI du même
 *    outil a été refait : il n'est pas cité, il est compté sur la ligne de ce
 *    succès (`words.redone`). Lu comme « ce qui s'est passé », il ne l'était pas ;
 *  - un échec que rien n'a refait EST ce qui s'est passé : cité, et dit
 *    `words.failed` ;
 * Des lignes identiques (même outil, mêmes mots du runner, même citation) se
 * disent UNE fois, avec leur compte, là où tombe la dernière :
 * `telegram_send_message ×9 → {"sent":true}`. La borne compte ensuite des
 * lignes distinctes : neuf accusés identiques ne chassent plus un résultat qui
 * dit quelque chose. Pour tout outil, sans liste. Pure.
 */
export function quotedCallLines(
  calls: readonly ToolCallFact[],
  words: RecordWords = RECORD_WORDS,
): string[] {
  const outcomes = calls.map((c) => callOutcome(c.output));
  // Pour chaque échec, le premier succès du même outil qui le suit.
  const redoneBy = new Set<number>();
  const redoneCount = new Map<number, number>();
  const nextSuccess = new Map<string, number>();
  for (let i = calls.length - 1; i >= 0; i--) {
    const name = calls[i]!.name;
    if (outcomes[i] === 'succeeded') nextSuccess.set(name, i);
    const by = nextSuccess.get(name);
    if (outcomes[i] === 'failed' && by !== undefined) {
      redoneBy.add(i);
      redoneCount.set(by, (redoneCount.get(by) ?? 0) + 1);
    }
  }
  const entries = calls.flatMap((c, i) => {
    if (redoneBy.has(i)) return [];
    const head = resultHead(c.output);
    const redone = redoneCount.get(i) ?? 0;
    const notes = [
      ...(outcomes[i] === 'failed' ? [words.failed] : []),
      ...(redone > 0 ? [words.redone(redone)] : []),
    ];
    return [{ name: recordField(c.name, NAME_MAX_CHARS), notes, head }];
  });
  const key = (e: (typeof entries)[number]) => JSON.stringify([e.name, e.notes, e.head]);
  const count = new Map<string, number>();
  const last = new Map<string, number>();
  entries.forEach((e, i) => {
    count.set(key(e), (count.get(key(e)) ?? 0) + 1);
    last.set(key(e), i);
  });
  return entries.flatMap((e, i) =>
    last.get(key(e)) === i ? [words.quoteLine({ ...e, count: count.get(key(e))! })] : [],
  );
}

/** Ce qu'un lecteur sait d'un job pour dire s'il a fini : son statut, l'heure rangée à sa fin. */
export interface JobEndFacts {
  status: string | null;
  completedAt: Date | null;
}

/**
 * Les relevés d'une série d'échanges, par id de job : le job, ses délégations
 * terminées, et ce que chaque appel déclarait quand il a tourné. Un job sans
 * appel ni délégation n'a pas de relevé.
 *
 * `replyCallIds` : par job, les appels qui ont livré la réponse que
 * l'historique redonne déjà comme le tour de l'agent (`extractAssistantReply`,
 * le seul à les désigner). Ils ne sont ni nommés ni cités (`jobActs`). Un
 * chemin dont la réponse est le résultat du job (tableau de bord, appareil, tour
 * de chat) n'en passe aucun : aucun appel n'y a livré la réponse.
 *
 * `hasEnded` (#1101) : le job a-t-il fini POUR CE LECTEUR, lu sur ce que la
 * base range de lui (son statut, l'heure de sa fin), jamais sur ses résultats.
 * Par défaut, son statut est terminal (terminé, échoué, annulé). L'historique
 * d'un job lancé depuis une conversation lit un job fini APRÈS le départ de ce
 * job comme encore en cours (thread-history.ts) : il passe sa propre règle,
 * pour que le relevé dise la même chose que le cadre qu'il lui pose.
 */
export async function loadExchangeRecords(
  db: RunnerDeps['db'],
  jobIds: readonly (string | null)[],
  opts: {
    replyCallIds?: ReadonlyMap<string, ReadonlySet<string>>;
    hasEnded?: (job: JobEndFacts) => boolean;
  } = {},
): Promise<Map<string, string[]>> {
  const replyCallIds = opts.replyCallIds ?? new Map<string, ReadonlySet<string>>();
  const hasEnded = opts.hasEnded ?? ((job: JobEndFacts) => isJobEnded(job.status));
  const records = new Map<string, string[]>();
  const ids = [...new Set(jobIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return records;
  const jobs = await db
    .select({
      id: agentJobs.id,
      task: agentJobs.task,
      messages: agentJobs.messages,
      toolsUsed: agentJobs.toolsUsed,
      status: agentJobs.status,
      completedAt: agentJobs.completedAt,
    })
    .from(agentJobs)
    .where(inArray(agentJobs.id, ids));
  const taskLedger = await loadTaskLedger(db, ids);
  const inlineLedger = await loadInlineDelegationLedger(db, ids);
  const childIds = [...taskLedger.values(), ...inlineLedger.values()]
    .flat()
    .map((e) => e.jobId)
    .filter((id): id is string => id !== null);
  const readOnly = await loadCallDeclarations(db, [...ids, ...childIds]);
  for (const job of jobs) {
    const lines = exchangeRecordLines(
      {
        ended: hasEnded({ status: job.status, completedAt: job.completedAt }),
        own: { ...jobActs(job, replyCallIds.get(job.id)), jobId: job.id },
        tasks: taskLedger.get(job.id) ?? [],
        inline: inlineLedger.get(job.id) ?? [],
      },
      readOnly,
    );
    if (lines.length > 0) records.set(job.id, lines);
  }
  return records;
}

/**
 * Ce que chaque appel de ces jobs DÉCLARAIT quand il a tourné, lu sur ses
 * lignes `tool_calls` (par `job_id` et `tool_call_id`). Lecture seule si TOUTES
 * ses lignes le disent : `risk_level` `read` (un outil du produit, une opération
 * de connecteur) ou `read_only_hint` vrai (un outil MCP, 0166). Le
 * `readOnlyHint` d'un serveur n'abaisse jamais la porte d'approbation
 * (adapter-mcp, MCP-001) ; ici il ne décide que de ce que le relevé cite.
 */
async function loadCallDeclarations(
  db: RunnerDeps['db'],
  jobIds: readonly string[],
): Promise<DeclaredReadOnly> {
  const declared = new Map<string, boolean>();
  if (jobIds.length > 0) {
    const rows = await db
      .select({
        jobId: toolCalls.jobId,
        toolCallId: toolCalls.toolCallId,
        riskLevel: toolCalls.riskLevel,
        readOnlyHint: toolCalls.readOnlyHint,
      })
      .from(toolCalls)
      .where(and(inArray(toolCalls.jobId, [...new Set(jobIds)]), isNotNull(toolCalls.toolCallId)));
    for (const row of rows) {
      const key = `${row.jobId}\u0000${row.toolCallId}`;
      const readOnly = row.riskLevel === 'read' || row.readOnlyHint === true;
      declared.set(key, (declared.get(key) ?? true) && readOnly);
    }
  }
  return (jobId, callId) => callId !== null && declared.get(`${jobId}\u0000${callId}`) === true;
}
