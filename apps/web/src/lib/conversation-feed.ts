// conversation-feed.ts — le fil d'un travail, tel que la page de l'espace le
// dessine (plan « De la maquette au produit », P2).
//
// Pur : des lignes déjà lues (le job et ses messages, ses tool_calls, ses
// llm_calls, ses enfants) → une suite d'items. Aucune requête, aucun texte
// d'interface : le composant met les mots, ce module met la STRUCTURE — et il
// dispatche sur la CARTE persistée par P1 (`tool_calls.card`, `presented`),
// jamais sur le nom de l'outil.
//
// Ce que le fil montre, dans cet ordre :
//   request  — la demande, avec d'où elle vient (canal, automatisation)
//   turn     — un tour de l'agent : sa prose, puis ses actions — les mineures
//              repliées en un groupe (raisonnement, lectures, recherches,
//              accusés), les résultats en cartes (fichiers, table, terminal,
//              envoi, verdict, délégation)
//   note     — un rappel du runner à l'agent (les messages `user` qui suivent
//              la demande sont des nudges, jamais l'utilisateur)
//   history  — ce qui PRÉCÈDE la demande : l'historique d'une conversation que
//              le runner préfixe au transcript (thread-history.ts) — replié
//   child    — un travail confié à un autre agent, avec son propre fil
//   answer   — la réponse finale, quand le travail est terminé
//
// Lecteur des trois formats de message : `blocksFromContent`
// (`transcript-blocks.ts`), réutilisé et non copié — plan, « ce qu'on garde ».
// Les parties `reasoning` (persistées par le runner, execute.ts) sont lues ici,
// en amont.

import { SENT_TEXT_KINDS } from '@nodal-agents/shared';
import type { ToolCard, ToolCardPayload } from '@nodal-agents/shared';
// UNIQUEMENT le type, et c'est load-bearing : ce module est lu par des
// composants `'use client'`, et une importation de VALEUR depuis
// `@nodal-agents/orchestration` embarquerait `@nodal-agents/db` et drizzle dans
// le paquet du navigateur — Turbopack ne compile alors plus la page du tout
// (voir `listInternalToolsAction`, lib/actions.ts). Un `import type` est effacé.
import type { ReviewVerdictRecord } from '@nodal-agents/orchestration';
import { blocksFromContent } from './transcript-blocks.ts';
import {
  parsePresented,
  outcomeOfToolOutput,
  callHappened,
  isToolCard,
} from './tool-card-payload.ts';
import { lineCountsOfCall, type LineCounts } from './coding-changes.ts';
import { knownHint, type FailureHint } from './failure-hint.ts';
import type { ProductionVerdict } from './chat-or-work.ts';

// ─── Entrées ──────────────────────────────────────────────────────────────────

export type FeedToolCallRow = {
  toolCallId: string | null;
  toolName: string;
  /** La carte DÉCLARÉE par l'outil (P1). null sur une ligne antérieure à 0092. */
  card: string | null;
  /** La charge utile présentée (P1). null : rien de présentable, l'écran dit « brut ». */
  presented: unknown;
  durationMs: number | null;
  turn: number | null;
  toolInput: unknown;
  toolOutput: string | null;
  createdAt: Date | null;
};

/**
 * Une QUESTION posée par l'agent et son sort (P10a) — une ligne
 * `approval_requests` de kind `question`, rangée par `tool_call_id` sur
 * l'étape qui l'a posée.
 */
export type FeedQuestionRow = {
  approvalRequestId: string;
  toolCallId: string | null;
  status: string;
  /** L'option retenue, sur une question répondue. */
  answer: string | null;
  /** La raison donnée en déclinant, s'il y en a une. */
  notes: string | null;
};

export type FeedLlmCallRow = {
  turn: number | null;
  source: string;
  modelEffective: string;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
};

export type FeedChildJob = {
  id: string;
  agentName: string | null;
  agentSlug: string | null;
  /**
   * L'image de l'agent, quand il en a une (`agents.avatar_url`). null : il
   * n'en a pas, et l'écran retombe sur ses initiales — jamais une image
   * inventée.
   */
  agentAvatarUrl: string | null;
  status: string | null;
  task: string | null;
  result: string | null;
  error: string | null;
  /**
   * Le geste que l'échec de ce délégué appelle, LU sur sa ligne
   * (`agent_jobs.failure_hint`, #193). Le slug du runner, tel quel : c'est
   * `hintSentence` qui décide s'il se dit, et comment.
   */
  failureHint: string | null;
  createdAt: Date | null;
  completedAt: Date | null;
  /**
   * Le verdict que ce délégué a ENREGISTRÉ, quand il en a enregistré un (#174).
   *
   * Exactement ce que l'outil `review_verdict` a validé par son schéma, relu
   * sur sa ligne `tool_calls` (`lireVerdictsLivres`, job-feed.ts). `null` ou
   * absent quand le job n'a livré aucun verdict : le bloc retombe alors sur la
   * prose de son résultat, qui reste tout ce qu'on sait de lui.
   *
   * Pourquoi ce champ existe : le fil DEVINAIT le verdict en lisant la
   * première ligne du résultat. Depuis #170 il voyage typé, et une prose qui
   * dit autre chose que ce qui a été enregistré ne doit plus gagner.
   */
  reviewVerdict?: ReviewVerdictRecord | null;
  /** Le fil de l'enfant, si l'appelant l'a construit (récursion à sa main). */
  feed?: ConversationFeed;
};

export type FeedJob = {
  id: string;
  task: string;
  channel: string;
  chatId: string | null;
  status: string | null;
  result: string | null;
  error: string | null;
  /**
   * Le geste que l'échec appelle, LU sur la ligne du job et non déduit de son
   * code d'erreur (`agent_jobs.failure_hint`, #193).
   */
  failureHint: string | null;
  agentName: string | null;
  agentSlug: string | null;
  agentAvatarUrl: string | null;
  createdAt: Date | null;
  completedAt: Date | null;
  messages: unknown[];
  /** Provenance cron (trigger_context) — le nom de l'automatisation, s'il y en a une. */
  scheduleName: string | null;
  children: FeedChildJob[];
};

// ─── Sorties ──────────────────────────────────────────────────────────────────

export type Origin = {
  channel: string;
  scheduleName: string | null;
  chatId: string | null;
};

// `StepOutcome` et sa lecture vivent dans `tool-card-payload.ts` : la frontière
// chat/travail (P7) lit la MÊME colonne, et deux lectures auraient divergé.
export type { StepOutcome } from './tool-card-payload.ts';
/** Réexporté pour que l'écran nomme le verdict sans importer l'orchestration. */
export type { ReviewVerdictRecord };
import type { StepOutcome } from './tool-card-payload.ts';

export type Step =
  | {
      kind: 'reasoning';
      text: string;
    }
  | {
      kind: 'tool';
      toolName: string;
      toolCallId: string | null;
      /**
       * Le TRAVAIL dont cette étape fait partie (P11). Un fil couvre plusieurs
       * jobs ; le diff d'un fichier se demande par (travail, appel), et sans ce
       * champ la carte aurait dû le deviner depuis l'item qui l'entoure.
       */
      jobId: string;
      /**
       * La carte persistée sur la ligne (P1). null : pas de ligne (l'outil n'est
       * pas passé par executeTool — return_result, assign_*) ou ligne
       * antérieure à 0092. L'écran montre alors le nom et la sortie brute.
       */
      card: ToolCard | null;
      /** La charge utile, VALIDÉE ; null si absente ou hors forme. */
      presented: ToolCardPayload | null;
      input: unknown;
      outputText: string | null;
      outcome: StepOutcome;
      durationMs: number | null;
      /**
       * P2bis — ce que CET appel a écrit, par chemin de fichier : lignes
       * ajoutées, lignes remplacées. `{}` quand il n'écrit pas de texte (une
       * lecture, un classeur xlsx) ou qu'il a été refusé.
       *
       * La lecture est celle de la page Code, au mot près (`lineCountsOfCall`
       * dans `coding-changes.ts`) : les deux écrans doivent dire le même
       * nombre du même fichier, et une recopie aurait divergé au premier outil
       * ajouté.
       */
      lineCounts: Record<string, LineCounts>;
      /**
       * P10a — la question que CET appel a posée, quand une ligne
       * `approval_requests` lui correspond par `toolCallId`. null pour toute
       * autre étape, et pour une carte `question` dont la ligne n'a pas été
       * chargée : l'écran montre alors la question sans boutons, plutôt que
       * des boutons qui ne résoudraient rien.
       */
      question: {
        approvalRequestId: string;
        status: string;
        answer: string | null;
        notes: string | null;
      } | null;
    };

export type TurnBlock =
  | { kind: 'prose'; text: string }
  /** Des actions mineures, repliées : raisonnement, lectures, recherches, accusés, brut. */
  | { kind: 'steps'; steps: Step[] }
  /** Un résultat qui se montre : fichiers, table, terminal, envoi, verdict, délégation. */
  | { kind: 'card'; step: Extract<Step, { kind: 'tool' }> };

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  durationMs: number;
  calls: number;
};

export type FeedItem =
  | { kind: 'request'; text: string; origin: Origin; at: Date | null }
  /**
   * Ce que le fil dit de LUI-MÊME, pas de la conversation : un rappel que le
   * runner a glissé à l'agent (`runner`), ou un aveu du fil sur ce qu'il ne
   * peut pas montrer (`thread`). Les deux se dessinent en marge — le bruit
   * système n'est pas un tour (P2bis).
   */
  | { kind: 'note'; text: string; origin: 'runner' | 'thread' }
  | {
      kind: 'turn';
      /** Rang d'affichage, 1..n dans CE job. */
      index: number;
      /**
       * Le compteur `turn` du runner, celui de `llm_calls.turn` — lu sur la ligne
       * d'audit d'un appel du tour (`audit`), ou déduit du tour précédent quand
       * le tour n'a appelé aucun outil (`inferred`). Le runner avance ce
       * compteur avant chaque tentative LLM, y compris une tentative rejetée
       * sans message de l'agent : l'index d'affichage ne suffit pas — et un
       * tour déduit ne porte NI modèle NI jetons (`usage: null`), parce qu'il
       * pourrait désigner l'appel d'une tentative rejetée.
       */
      turn: number;
      turnSource: 'audit' | 'inferred';
      agent: { name: string | null; slug: string | null; avatarUrl: string | null };
      model: string | null;
      blocks: TurnBlock[];
      usage: TurnUsage | null;
      /**
       * #135 — quand le tour a COMMENCÉ, tel que l'en-tête l'affiche à droite.
       * La seule date que ce fil lit vraiment est celle des lignes d'audit
       * d'outil (`tool_calls.created_at`) : c'est donc la PLUS ANCIENNE des
       * lignes du tour. `llm_calls` n'expose pas sa date ici, et l'inventer
       * depuis la date du job daterait tous les tours de la même heure. Un
       * tour qui n'a appelé aucun outil n'a donc pas d'heure — `null`, et
       * l'écran ne dessine rien (invariant #4 : rien d'inventé).
       */
      at: Date | null;
    }
  /**
   * Ce qui précède la demande : l'historique d'une conversation (Telegram,
   * Slack…) que le runner préfixe au transcript (thread-history.ts) pour que
   * l'agent se souvienne. Ce n'est PAS ce job — le fil le montre replié, à part.
   */
  | { kind: 'history'; exchanges: Array<{ role: 'user' | 'agent'; text: string }> }
  /**
   * Une délégation, TOUJOURS à plat (#135). `from` dit QUI a délégué : l'agent
   * du job pour un enfant direct, l'agent de l'enfant pour un petit-enfant
   * remonté. Sans lui, deux délégations de suite se liraient pareil alors que
   * la seconde part d'un autre agent.
   */
  | {
      kind: 'child';
      job: FeedChildJob;
      from: { name: string | null; slug: string | null; avatarUrl: string | null };
    }
  | { kind: 'answer'; text: string }
  /**
   * Un run qui s'est arrêté. `hint` nomme le GESTE que cet échec appelle,
   * quand il en appelle un (#184) — lu ici, dans le modèle, pour que les deux
   * écrans qui rendent un échec en disent la même chose. `null` est la réponse
   * ordinaire : presque aucun échec n'appelle un geste nommable.
   */
  | { kind: 'failure'; text: string; hint: FailureHint | null }
  /**
   * #135 / #132 — LE TRAVAIL d'un job, en un seul item.
   *
   * Le principe de Quentin (#132) : un seul rendu de ce qu'un run a fait, à
   * deux densités. Le chat l'ouvre REPLIÉ — la réponse de l'agent d'abord, et
   * dessous une ligne qui résume le run ; un clic déplie, bloc par bloc, ce que
   * la page du run montre. Pour que ce soit le MÊME rendu, le groupe vit dans
   * le MODÈLE et pas seulement dans l'écran : sinon chaque écran le referait à
   * sa façon, et les deux divergeraient au premier bloc ajouté.
   *
   * `items` porte les blocs du run dans l'ordre du temps — tours (raisonnement,
   * outils, ligne de modèle, prose intermédiaire, cartes de résultat) et
   * délégations, à plat (#141). Ce qui n'est PAS du travail reste dehors : la
   * demande, la consigne, les notes, la réponse, l'échec, le récapitulatif.
   *
   * Posé par `conversation-thread.ts`, jamais par `buildConversationFeed` : le
   * fil d'un job EST la vue dépliée, celle de la page du run.
   */
  | {
      kind: 'run';
      jobId: string;
      /** Qui a porté le run — l'agent de son premier tour. */
      agent: { name: string | null; slug: string | null; avatarUrl: string | null };
      model: string | null;
      /** Quand le run a commencé (`agent_jobs.created_at`). */
      at: Date | null;
      summary: RunSummary;
      items: FeedItem[];
    }
  /**
   * P7 — ce qui est SORTI du chat à ce tour, et où ça vit. Posé par
   * `conversation-thread.ts`, jamais par `buildConversationFeed` : un job seul
   * ne sait rien du projet courant ni des lignes de ses descendants.
   */
  | {
      kind: 'produced';
      jobId: string;
      /** Le statut du travail, pour le bouton Stop du récapitulatif. */
      status: string | null;
      verdict: ProductionVerdict;
      project: { id: string; name: string; path: string } | null;
      /** P2bis — de quoi dessiner le récapitulatif de livraison. */
      summary: DeliverySummary;
    }
  /**
   * P7 — la consigne que le chat a passée au travail. Ce n'est pas la demande
   * de l'utilisateur (elle est déjà au-dessus, telle qu'il l'a écrite) : c'est
   * sa reformulation par l'agent, repliée.
   */
  | { kind: 'handoff'; text: string };

/**
 * Ce que la LIGNE DE RÉSUMÉ d'un run dit de lui (#135, #132) : « 3 tools ·
 * 1 delegation · 2 model calls · 12 s · $0.04 ».
 *
 * Chaque champ peut manquer, et un champ absent ne se dessine pas — pas de
 * « 0 tools », pas de « $0 » (invariant #4). Un compte est donc un nombre
 * VÉRIFIÉ : les outils et le coût viennent des totaux du job, les délégations
 * et les appels de modèle se comptent sur les items du groupe, pour que la
 * ligne dise exactement ce que le dépliage montre.
 */
export type RunSummary = {
  tools: number;
  delegations: number;
  /** Les tours du groupe qui portent un `usage` — donc les lignes de modèle. */
  modelCalls: number;
  /** Du début à la fin du travail. null tant qu'il n'est pas terminé. */
  durationMs: number | null;
  costUsd: number | null;
};

/**
 * Une relecture du travail, telle que le récapitulatif de livraison la montre
 * (P2bis) : un délégué qui a rendu quelque chose, ou un verdict d'outil de
 * revue. `text` est BRUT (du markdown) — l'écran en tire sa première ligne
 * plate ; le modèle ne rend pas de texte d'interface.
 */
export type DeliveryReview = {
  name: string;
  text: string;
  ok: boolean;
  /** Un délégué porte un avatar ; un verdict d'outil n'en a pas. */
  isAgent: boolean;
  /**
   * L'image du délégué, quand il en a une (#135) — elle vient de la ligne du
   * fil, DÉJÀ lue : l'ajouter ne coûte aucune requête. `null` pour un verdict
   * d'outil, et pour un agent sans image, où les initiales prennent le relais.
   */
  avatarUrl: string | null;
};

/** Une commande de preuve et son sort. */
export type DeliveryCheck = { command: string; ok: boolean };

/**
 * Ce que le récapitulatif de livraison a le droit de dire d'un travail
 * (P2bis). CHAQUE champ peut manquer, et un champ absent ne se dessine pas :
 * la maquette montre « Lignes +27 −2 » et « Couverture 92 % », que rien en
 * base ne porte — ils n'ont donc pas de place ici (invariant #4).
 */
export type DeliverySummary = {
  /** Fichiers DISTINCTS écrits par le job et ses délégués ; 0 ⇒ pas de cellule. */
  files: number;
  /**
   * CES fichiers, dans l'ordre où ils ont été écrits (#135) — le récapitulatif
   * ne dit plus « 3 files » sans dire lesquels. Chemins canoniques, dédoublonnés
   * comme le compte : `filePaths.length === files`, toujours. L'écran en montre
   * douze au plus et compte le reste ; le modèle les porte tous.
   */
  filePaths: string[];
  /**
   * Les lignes écrites et remplacées, sommées sur le job et ses délégués — le
   * même churn que la page Code. null quand AUCUN appel n'a écrit de texte
   * (un travail qui n'a produit qu'un classeur n'a pas de lignes).
   */
  lines: LineCounts | null;
  /** Les commandes de preuve, passées sur total. null : aucune preuve n'a tourné. */
  tests: { passed: number; total: number } | null;
  /** Du début à la fin du travail. null tant qu'il n'est pas terminé. */
  durationMs: number | null;
  costUsd: number | null;
  reviews: DeliveryReview[];
  checks: DeliveryCheck[];
  /** 'green' toutes vertes, 'red' au moins une qui ne l'est pas, null aucune preuve. */
  verdict: 'green' | 'red' | null;
  /**
   * Le DERNIER verdict de relecture enregistré sous ce travail (#59), tel
   * quel : `'approve'`, `'request_changes'`, ou `null` quand personne n'a relu.
   */
  review: string | null;
  /**
   * Ce verdict demande-t-il des corrections ? Le bloc de conclusion dit
   * TOUJOURS « Delivered » — le travail a eu lieu — et ce champ décide de ce
   * qui se lit à côté : le mot de la relecture, la couleur de sa pastille et le
   * signe de l'en-tête (Quentin, 19/09 au soir).
   *
   * Un champ, pas un calcul refait dans le composant : la règle est celle de
   * `reviewBlocksDelivery` (`@nodal-agents/shared`), la même que celle qui
   * remplit `delivery_blocked` dans le résultat typé que reçoit le parent. Ce
   * que l'écran en fait et ce que le parent en fait sont deux décisions
   * distinctes, prises sur un seul et même fait.
   */
  changesRequested: boolean;
  /**
   * LES COMMANDES DE CE TRAVAIL, et ce qu'on a vu de chacune (#282).
   *
   * `observed` à faux veut dire : la commande a tourné et aucune écriture n'a
   * été CONSTATÉE sur son tour (#197). Ce n'est pas « elle n'a rien fait »,
   * c'est « on ne l'a pas vu » — dans un dépôt, le constat par git l'aurait vu.
   *
   * Le fait vient du verdict déjà calculé (`ProducedItem` de genre `command`,
   * son drapeau `certain`), jamais d'une seconde lecture des lignes d'audit :
   * deux lectures du même fait auraient divergé au premier correctif.
   */
  commands: DeliveryCommand[];
  /**
   * CE TRAVAIL A-T-IL PRODUIT QUELQUE CHOSE qu'on ait constaté ? C'est
   * `verdict.isWork`, transporté tel quel.
   *
   * Il décide du MOT de l'en-tête. Depuis #282 l'encart paraît aussi pour un
   * tour dont la seule commande n'a rien laissé voir ; écrire « Delivered »
   * au-dessus d'une liste de commandes non constatées dirait exactement le
   * contraire de ce que le verdict a mesuré (invariant #4).
   */
  produced: boolean;
  /**
   * COMMENT LE TRAVAIL S'EST REFERMÉ, quand il ne s'est pas terminé :
   * `'stopped'` (annulé par la personne) ou `'failed'`. `null` pour un travail
   * terminé, ou encore en cours. Il décide du mot de l'en-tête AVANT
   * `produced` : ce qu'un run arrêté a écrit reste nommé dessous, mais
   * « Delivered » ou « Ran » au-dessus dirait qu'il est allé au bout.
   */
  ended: 'stopped' | 'failed' | null;
  /**
   * LE TRAVAIL COURT ENCORE (statut vivant). L'encart paraît dès qu'un run en
   * cours a produit quelque chose ; « Delivered » et le crochet vert y
   * disaient un travail fini à côté d'une pastille « Running » (Quentin,
   * 22/09). Vivant, l'en-tête dit « Working », dans la couleur de « Running ».
   */
  live: boolean;
};

/** Une commande du travail, et ce qu'on a constaté d'elle (#282). */
export type DeliveryCommand = {
  /** La commande, telle que la carte d'outil l'a présentée. */
  label: string;
  /** Une écriture a-t-elle été constatée sur le tour de cette commande ? */
  observed: boolean;
};

export type FeedTotals = {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  /** null quand AUCUN appel n'a de coût connu — jamais un 0 qui voudrait dire « gratuit ». */
  costUsd: number | null;
  llmDurationMs: number;
  models: string[];
};

export type ConversationFeed = {
  items: FeedItem[];
  totals: FeedTotals;
};

// ─── Politique d'affichage : quelles cartes se montrent seules ───────────────
//
// Sur la CARTE, jamais sur le nom. Une lecture, une recherche, un accusé
// (`text`) et le brut restent des étapes repliées ; ce qui a produit quelque
// chose s'affiche.

export const STANDALONE_CARDS: ReadonlySet<ToolCard> = new Set<ToolCard>([
  'files',
  'table',
  'terminal',
  'sent',
  'checks',
  'delegation',
  'question',
]);

/** Le préfixe que le runner met devant ses rappels à l'agent (delivery / approval nudges). */
export const RUNNER_NOTE_PREFIX = '[système]';

/**
 * Une action se montre seule quand sa carte est une carte de résultat, que
 * l'appel a réussi, et que la charge utile a quelque chose à dessiner : une
 * table sans ligne ou une liste de fichiers vide restent des étapes — dire
 * « 0 souvenir » en carte pleine page serait du bruit, pas de l'information.
 */
export function showsAlone(step: Extract<Step, { kind: 'tool' }>): boolean {
  if (step.card === null || !STANDALONE_CARDS.has(step.card)) return false;
  // P10a — une question SUSPENDUE se montre, et c'est tout l'intérêt : l'appel
  // n'a pas réussi (il attend), et c'est précisément là qu'il faut les boutons.
  // La condition porte sur la CARTE et sur l'ÉTAT de la ligne, jamais sur le
  // nom de l'outil — un second outil qui poserait des questions demain hérite
  // du même traitement sans qu'on touche à ce fichier.
  if (step.card === 'question' && step.question !== null) return true;
  if (step.outcome !== 'success') return false;
  const p = step.presented;
  if (p === null) return true; // carte de résultat sans charge : l'écran montre le brut, mais à sa place
  if (p.card === 'table') return p.tables.some((t) => t.rows.length > 0);
  if (p.card === 'files') return p.total > 0;
  return true;
}

// ─── Lecture des lignes ───────────────────────────────────────────────────────

type ReasoningPart = { type: 'reasoning'; text: string };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksFromContent(withoutReasoning(content))
    .filter((b) => b.kind === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/** L'index du DERNIER message `user` dont le texte est exactement la tâche ; 0 sinon. */
function lastIndexOfTask(messages: readonly unknown[], task: string): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role === 'user' && typeof m.content === 'string' && m.content === task) return i;
  }
  return 0;
}

/** L'historique en échanges lisibles : qui a dit quoi, sans les résultats d'outils. */
function exchangesOf(
  messages: readonly unknown[],
): Array<{ role: 'user' | 'agent'; text: string }> {
  const out: Array<{ role: 'user' | 'agent'; text: string }> = [];
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown };
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = textOf(m.content).trim();
    if (text === '') continue;
    out.push({ role: m.role === 'user' ? 'user' : 'agent', text });
  }
  return out;
}

/** Le contenu sans ses parties `reasoning` — blocksFromContent ne les connaît pas et les rendrait en texte JSON. */
function withoutReasoning(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter(
    (p) => !(typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'reasoning'),
  );
}

function reasoningParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (p): p is ReasoningPart =>
        typeof p === 'object' &&
        p !== null &&
        (p as { type?: unknown }).type === 'reasoning' &&
        typeof (p as { text?: unknown }).text === 'string',
    )
    .map((p) => p.text);
}

// ─── Répétitions et compaction ────────────────────────────────────────────────

/** Le texte comparable d'un message : sans bords, espaces repliés. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Le dernier tour de l'agent a-t-il PARLÉ ? On remonte le fil jusqu'au
 * dernier tour qui porte une prose, à travers ce qui n'est pas une parole :
 * un tour MUET (l'appel `telegram_send_message` puis `return_result` qui
 * suivent la phrase), un rappel du runner, une délégation, un encart. On
 * s'arrête à la demande de l'utilisateur : au-delà, ce serait la conversation
 * d'avant.
 *
 * C'est une règle de STRUCTURE, pas de texte. Quatre formes de comparaison
 * (`includes`, suffixe, paragraphe, lignes jointes — revue Codex PR #46,
 * passes 49 à 52) ont chacune laissé passer un cas où le lecteur voyait deux
 * fois la même phrase, la dernière parce que la prose est du MARKDOWN
 * (« **Tout est prêt.** » ≠ « Tout est prêt. » à l'octet, égaux à l'écran).
 * Ce que l'agent a écrit EST sa réponse ; `job.result` n'est montré que
 * lorsque l'agent a fini sans un mot.
 */
function lastAgentTurnSpoke(items: readonly FeedItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item === undefined) continue;
    if (item.kind === 'request' || item.kind === 'history') return false;
    if (item.kind !== 'turn') continue;
    // Une prose, ou une carte d'ENVOI qui livre un TEXTE (`SENT_TEXT_KINDS` :
    // le `message` d'un canal, le `dashboard` de `dashboard_publish` — la
    // sorte réelle du présentateur, revue Codex passe 54, pas un `message`
    // supposé) : la carte `sent` montre déjà la phrase partie, la répéter en
    // `answer` l'affichait deux fois (passe 53). Un envoi de FICHIER ne porte
    // pas de texte : `job.result` reste alors la seule phrase, et se montre.
    // Toujours la structure — la sorte de carte —, jamais le texte.
    if (
      item.blocks.some(
        (bl) =>
          bl.kind === 'prose' ||
          (bl.kind === 'card' &&
            bl.step.presented?.card === 'sent' &&
            SENT_TEXT_KINDS.has(bl.step.presented.kind)),
      )
    )
      return true;
  }
  return false;
}

/** Le tour et le précédent sont-ils du même agent ? */
function sameAgent(
  a: { name: string | null; slug: string | null },
  b: { name: string | null; slug: string | null },
): boolean {
  if (a.slug !== null && b.slug !== null) return a.slug === b.slug;
  if (a.slug === null && b.slug === null) return a.name === b.name;
  return false;
}

function addUsage(a: TurnUsage | null, b: TurnUsage | null): TurnUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    // null + x = x, null + null = null : un coût inconnu n'est pas un coût nul.
    costUsd: a.costUsd === null ? b.costUsd : a.costUsd + (b.costUsd ?? 0),
    durationMs: a.durationMs + b.durationMs,
    calls: a.calls + b.calls,
  };
}

/**
 * Les tours MUETS se replient dans le précédent (P2bis).
 *
 * Le runner compte un tour par tentative LLM. Un agent qui enchaîne cinq
 * appels d'outils sans rien dire produisait cinq tours, donc cinq avatars et
 * cinq plaques — la capture de Quentin en montrait quatre d'affilée pour un
 * seul geste. Un tour qui ne DIT rien (pas de prose) et ne MONTRE rien (pas de
 * carte) n'est pas un tour à l'écran : ses étapes appartiennent au tour qui l'a
 * précédé.
 *
 * Ce qui empêche la fusion, et pourquoi : une prose ou une carte (le tour a
 * quelque chose à lui), un autre agent (ce serait mentir sur qui a agi), et
 * tout item entre les deux (une note, une demande, un encart : le fil a repris
 * la parole entre-temps).
 */
export function compactTurns(items: readonly FeedItem[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    const mute =
      item.kind === 'turn' && !item.blocks.some((b) => b.kind === 'prose' || b.kind === 'card');
    if (!mute || prev === undefined || prev.kind !== 'turn' || item.kind !== 'turn') {
      out.push(item);
      continue;
    }
    if (!sameAgent(prev.agent, item.agent)) {
      out.push(item);
      continue;
    }
    const steps = item.blocks.flatMap((b) => (b.kind === 'steps' ? b.steps : []));
    const blocks = [...prev.blocks];
    if (steps.length > 0) {
      const lastIdx = blocks.map((b) => b.kind).lastIndexOf('steps');
      const last = lastIdx >= 0 ? blocks[lastIdx] : undefined;
      if (last !== undefined && last.kind === 'steps') {
        blocks[lastIdx] = { kind: 'steps', steps: [...last.steps, ...steps] };
      } else {
        blocks.push({ kind: 'steps', steps });
      }
    }
    // L'identité du tour fusionné : un tour DÉDUIT ne porte ni modèle ni
    // jetons (passe 18) ; s'il absorbe un tour AUDITÉ, il prend son identité
    // (`turn`, `turnSource: 'audit'`) avec ses métriques — sinon des jetons
    // réels seraient attribués à un tour que le fil déclare non audité (revue
    // Codex PR #46, passe 49). Deux tours audités gardent le premier.
    const identity =
      prev.turnSource === 'inferred' && item.turnSource === 'audit'
        ? { turn: item.turn, turnSource: item.turnSource }
        : { turn: prev.turn, turnSource: prev.turnSource };
    out[out.length - 1] = {
      ...prev,
      ...identity,
      blocks,
      model: prev.model ?? item.model,
      // L'heure du tour fusionné est celle où il a COMMENCÉ : celle du premier
      // des deux, et celle du second quand le premier n'en avait pas.
      at: prev.at ?? item.at,
      usage: addUsage(prev.usage, item.usage),
    };
  }
  return out;
}

// ─── Le fil ───────────────────────────────────────────────────────────────────

export function buildConversationFeed(
  job: FeedJob,
  toolCalls: readonly FeedToolCallRow[],
  llmCalls: readonly FeedLlmCallRow[],
  /** Les questions de ce travail (P10a), rangées par `tool_call_id`. */
  questions: readonly FeedQuestionRow[] = [],
): ConversationFeed {
  const items: FeedItem[] = [];
  const origin: Origin = {
    channel: job.channel,
    scheduleName: job.scheduleName,
    chatId: job.chatId,
  };

  // Les lignes d'audit, par id d'appel ; et par nom pour les lignes anciennes
  // sans id (étape D, 2026-08), consommées dans l'ordre.
  const byCallId = new Map<string, FeedToolCallRow>();
  const byNameQueue = new Map<string, FeedToolCallRow[]>();
  for (const row of toolCalls) {
    if (row.toolCallId) byCallId.set(row.toolCallId, row);
    else {
      const q = byNameQueue.get(row.toolName) ?? [];
      q.push(row);
      byNameQueue.set(row.toolName, q);
    }
  }
  // Les questions par id d'appel. Une ligne sans `tool_call_id` n'est
  // rattachable à aucune étape : elle reste sur la page Approvals, où elle est
  // résoluble — jamais devinée par le nom de l'outil.
  const questionByCallId = new Map<string, FeedQuestionRow>();
  for (const q of questions) {
    if (q.toolCallId) questionByCallId.set(q.toolCallId, q);
  }

  const rowFor = (toolCallId: string, toolName: string): FeedToolCallRow | undefined => {
    const direct = byCallId.get(toolCallId);
    if (direct) return direct;
    return byNameQueue.get(toolName)?.shift();
  };

  // Les appels LLM, par tour (le tour k = le k-ième message de l'agent).
  const usageByTurn = new Map<number, TurnUsage & { model: string | null }>();
  for (const call of llmCalls) {
    if (call.turn === null) continue;
    const u = usageByTurn.get(call.turn) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null,
      durationMs: 0,
      calls: 0,
      model: null,
    };
    u.inputTokens += call.inputTokens ?? 0;
    u.outputTokens += call.outputTokens ?? 0;
    u.cachedTokens += call.cachedTokens ?? 0;
    u.cacheCreationTokens += call.cacheCreationTokens ?? 0;
    if (call.costUsd !== null) u.costUsd = (u.costUsd ?? 0) + call.costUsd;
    u.durationMs += call.durationMs ?? 0;
    u.calls += 1;
    u.model = call.modelEffective;
    usageByTurn.set(call.turn, u);
  }

  // La frontière : le message `user` qui EST la demande de ce job — le dernier
  // égal à `job.task` (l'historique préfixé peut contenir une demande identique
  // plus ancienne ; les messages `user` qui suivent la demande sont des rappels
  // du runner, jamais égaux à la tâche). Rien trouvé : tout est ce job.
  const boundary = lastIndexOfTask(job.messages, job.task);
  const before = job.messages.slice(0, boundary);
  const current = job.messages.slice(boundary);
  if (before.length > 0) items.push({ kind: 'history', exchanges: exchangesOf(before) });

  let turnIndex = 0;
  let lastTurn = 0;
  let sawRequest = false;
  let toolCallCount = 0;

  for (const raw of current) {
    const msg = raw as { role?: unknown; content?: unknown };
    const role = msg.role;

    if (role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : blocksFromContent(msg.content)
              .filter((b) => b.kind === 'text')
              .map((b) => b.text ?? '')
              .join('\n');
      if (!sawRequest) {
        sawRequest = true;
        items.push({ kind: 'request', text, origin, at: job.createdAt });
      } else {
        // Après la demande, un message `user` est un rappel du runner, pas
        // l'utilisateur — le fil le dit comme tel. Le runner répète souvent le
        // même rappel à chaque tour : deux fois de suite la même phrase, c'est
        // une phrase.
        const note = text.replace(RUNNER_NOTE_PREFIX, '').trim();
        const prev = items[items.length - 1];
        if (!(prev?.kind === 'note' && normalizeText(prev.text) === normalizeText(note))) {
          items.push({ kind: 'note', text: note, origin: 'runner' });
        }
      }
      continue;
    }

    if (role === 'assistant') {
      turnIndex += 1;
      const blocks: TurnBlock[] = [];
      const prose = blocksFromContent(withoutReasoning(msg.content)).filter(
        (b) => b.kind === 'text',
      );
      for (const p of prose) {
        if (p.text && p.text.trim() !== '') blocks.push({ kind: 'prose', text: p.text });
      }

      // Les actions : le raisonnement d'abord (c'est ainsi qu'il a décidé),
      // puis les appels, dans l'ordre. Les mineures s'agrègent en un groupe ;
      // une carte le clôt.
      let pending: Step[] = [];
      const flush = (): void => {
        if (pending.length > 0) blocks.push({ kind: 'steps', steps: pending });
        pending = [];
      };
      const rowTurns: number[] = [];
      // Les dates des lignes d'audit de ce tour : l'en-tête montrera la plus
      // ancienne (#135).
      const rowTimes: number[] = [];
      for (const text of reasoningParts(msg.content)) {
        pending.push({ kind: 'reasoning', text });
      }
      for (const b of blocksFromContent(withoutReasoning(msg.content))) {
        if (b.kind !== 'tool-call') continue;
        toolCallCount += 1;
        const toolName = b.toolName ?? 'unknown';
        const row = rowFor(b.toolCallId ?? '', toolName);
        if (row && row.turn !== null) rowTurns.push(row.turn);
        if (row?.createdAt) rowTimes.push(row.createdAt.getTime());
        const card = row && isToolCard(row.card) ? row.card : null;
        const q = b.toolCallId ? questionByCallId.get(b.toolCallId) : undefined;
        const outcome = outcomeOfToolOutput(row?.toolOutput);
        // Un appel qui n'a pas ABOUTI n'a rien écrit : une édition en attente
        // d'approbation, bloquée ou en erreur garde son entrée (le fil la
        // montre) mais aucun compteur — sinon la carte dirait « +2 −1 » sur un
        // fichier intact (vu en vrai le 07/09 : un `file_edit` en attente
        // comptait déjà). Et un appel SANS ligne d'audit ne compte pas non
        // plus : la ligne est la trace que l'outil a tourné — `executeTool`
        // avale l'échec de son insertion et l'appel reste dans le transcript
        // (revue Codex, passe 56) ; sans elle, on ne sait pas.
        const wrote = row !== undefined && callHappened(outcome);
        const step: Extract<Step, { kind: 'tool' }> = {
          kind: 'tool',
          toolName,
          toolCallId: b.toolCallId ?? null,
          jobId: job.id,
          card,
          presented: row ? parsePresented(row.presented) : null,
          input: b.payload,
          outputText: row?.toolOutput ?? null,
          outcome,
          durationMs: row?.durationMs ?? null,
          lineCounts: wrote ? lineCountsOfCall(toolName, b.payload, row?.toolOutput) : {},
          question: q
            ? {
                approvalRequestId: q.approvalRequestId,
                status: q.status,
                answer: q.answer,
                notes: q.notes,
              }
            : null,
        };
        if (showsAlone(step)) {
          flush();
          blocks.push({ kind: 'card', step });
        } else {
          pending.push(step);
        }
      }
      flush();

      const auditTurn = rowTurns[0];
      const turn = auditTurn ?? lastTurn + 1;
      const turnSource: 'audit' | 'inferred' = auditTurn !== undefined ? 'audit' : 'inferred';
      lastTurn = turn;
      // Un tour DÉDUIT ne reçoit aucune métrique : `lastTurn + 1` peut désigner
      // une tentative rejetée (le runner a compté un tour sans message), et
      // afficher ses jetons ici les attribuerait au mauvais appel (passe 18).
      // Les totaux du job, eux, restent justes.
      const u = turnSource === 'audit' ? usageByTurn.get(turn) : undefined;
      items.push({
        kind: 'turn',
        at: rowTimes.length > 0 ? new Date(Math.min(...rowTimes)) : null,
        index: turnIndex,
        turn,
        turnSource,
        agent: { name: job.agentName, slug: job.agentSlug, avatarUrl: job.agentAvatarUrl },
        model: u?.model ?? null,
        blocks,
        usage: u
          ? {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cachedTokens: u.cachedTokens,
              cacheCreationTokens: u.cacheCreationTokens,
              costUsd: u.costUsd,
              durationMs: u.durationMs,
              calls: u.calls,
            }
          : null,
      });
      continue;
    }

    // role === 'tool' : les résultats sont déjà joints aux appels par tool_calls.
  }

  // Les enfants : chacun un groupe, à la fin du fil (leur place exacte dans le
  // tour parent viendra avec la ligne d'audit de assign_*, qui n'existe pas
  // encore — execute() lève avant d'écrire).
  // JAMAIS imbriquées (#135, décision du tableau) : quand un délégué délègue à
  // son tour, sa délégation ne vit pas DANS son bloc — elle devient le bloc
  // SUIVANT, au même niveau, qui se lit « <enfant> delegated to <petit-enfant> ».
  // Tout replié, la chaîne entière reste lisible ; imbriquée, elle disparaissait
  // dès que le parent était fermé.
  //
  // Le fil d'un enfant est lui-même assemblé par cette fonction (job-feed.ts,
  // un niveau), donc ses propres items `child` sont DÉJÀ à plat et portent déjà
  // leur `from` : il suffit de les sortir de son fil et de les poser derrière
  // lui, dans l'ordre où ils sont arrivés.
  const from = { name: job.agentName, slug: job.agentSlug, avatarUrl: job.agentAvatarUrl };
  for (const child of job.children) {
    const own = child.feed;
    const lifted = own === undefined ? [] : own.items.filter((i) => i.kind === 'child');
    items.push({
      kind: 'child',
      job:
        own === undefined
          ? child
          : { ...child, feed: { ...own, items: own.items.filter((i) => i.kind !== 'child') } },
      from,
    });
    for (const item of lifted) items.push(item);
  }

  if (job.status === 'completed' && job.result && job.result.trim() !== '') {
    // `job.result` (ce que `dashboard_publish` / `return_result` ont posé) n'est
    // montré que si l'agent a fini SANS un mot : quand il a parlé, sa prose est
    // la réponse, et la répéter en plaque affichait deux fois le même texte
    // (constat de Quentin sur captures, 07/09 ; règle de structure, passe 52).
    if (!lastAgentTurnSpoke(items)) items.push({ kind: 'answer', text: job.result });
  } else if ((job.status === 'failed' || job.status === 'cancelled') && (job.error || job.result)) {
    items.push({
      kind: 'failure',
      text: job.error ?? job.result ?? '',
      // Le geste est LU, plus déduit (#193) : c'est le mot que le runner a
      // écrit sur la ligne du job. `knownHint` ne fait que rendre au type ce
      // que cet écran sait dire — un geste plus récent que lui reste muet.
      hint: knownHint(job.failureHint),
    });
  }

  // Les totaux, depuis les appels LLM du job (la barre d'état de P4 s'en sert).
  const models = new Set<string>();
  const totals: FeedTotals = {
    turns: turnIndex,
    toolCalls: toolCallCount,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    llmDurationMs: 0,
    models: [],
  };
  for (const call of llmCalls) {
    totals.inputTokens += call.inputTokens ?? 0;
    totals.outputTokens += call.outputTokens ?? 0;
    totals.cachedTokens += call.cachedTokens ?? 0;
    totals.cacheCreationTokens += call.cacheCreationTokens ?? 0;
    if (call.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + call.costUsd;
    totals.llmDurationMs += call.durationMs ?? 0;
    models.add(call.modelEffective);
  }
  totals.models = [...models];

  return { items: compactTurns(items), totals };
}
