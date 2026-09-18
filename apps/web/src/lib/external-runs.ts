// external-runs.ts — les règles de la liste des runs venus de dehors (#183) :
// où reprendre sa lecture, et ce qu'on a le droit d'en supprimer.
//
// Pures toutes les deux, et dans `lib/` plutôt que dans le dossier de l'écran,
// parce que les DEUX côtés s'en servent : l'action serveur qui lit et qui
// supprime, la liste cliente qui pagine et qui coche. Deux copies de la même
// règle auraient divergé au premier correctif — et ici, l'une des deux est une
// GARDE.
//
// ─── Où reprendre la lecture ─────────────────────────────────────────────────
//
// La base du propriétaire porte plus de cent runs de tête `api`/`mcp`. Le
// dossier MCP en chargeait la table entière ; il en charge une page, et
// « Load more » demande la suivante.
//
// UN CURSEUR, PAS UN `OFFSET`. Les runs arrivent pendant qu'on lit : une
// machine peut en poster un entre deux pages. Avec un `offset`, ce run neuf
// entre en tête, décale tout, et la page suivante REMONTRE la dernière ligne
// de la précédente — ou en saute une quand un run est supprimé. Un curseur
// désigne une LIGNE, pas un rang : ce qui arrive après ne le déplace pas.
//
// La clé est la paire `(created_at, id)`, l'ordre exact de la liste. `id`
// seul ne suffit pas — un uuid v4 n'a pas d'ordre chronologique — et
// `created_at` seul non plus : deux runs postés dans la même milliseconde
// perdraient l'un des deux.
//
// ⚠️ `created_at` est NULLABLE (`defaultNow()` sans `NOT NULL`,
// packages/db/src/schema/jobs.ts). Une ligne sans date se range EN TÊTE : la
// liste trie `DESC` tout court, donc `NULLS FIRST`, parce que c'est l'ordre
// exact de l'index `(entity_id, created_at DESC)`. `NULLS LAST` aurait mieux
// nommé les choses — « on ne sait pas quand » n'est pas « à l'instant » — mais
// coûtait le balayage de TOUS les jobs de l'entité à chaque page, mesuré sur
// 10 001 runs (Reviewer C, passe 1 de la PR #185).
//
// Le curseur sait désigner une telle ligne (`-|<id>`), et la borne la laisse
// derrière une fois passée : ni doublon, ni trou, seulement une place qu'on
// n'a pas choisie pour une ligne dont la date manque.

import { LIVE_JOB_STATUSES, redactSecretsInText } from '@nodal-agents/shared';
import { plainText } from '@/components/Markdown.tsx';
import { RUNNING_JOB_STATUSES } from './chat-folders.ts';
import { truncate } from './format-time';

/** Ce qu'il faut d'une ligne pour savoir où reprendre après elle. */
export type RunCursorRow = { createdAt: Date | null; id: string };

/** La position décodée. `createdAt` à `null` = une ligne sans date. */
export type RunCursor = { createdAt: Date | null; id: string };

/** La marque d'une date absente. Un `|` ne peut pas figurer dans un uuid. */
const SANS_DATE = '-';
const SEP = '|';

/** Où reprendre APRÈS cette ligne. */
export function encodeRunCursor(row: RunCursorRow): string {
  const quand = row.createdAt === null ? SANS_DATE : row.createdAt.toISOString();
  return `${quand}${SEP}${row.id}`;
}

/**
 * La position que désigne un curseur, ou `null` s'il ne désigne rien.
 *
 * Un curseur illisible — tapé à la main, tronqué par un copier-coller — rend
 * `null`, et l'appelant repart du DÉBUT plutôt que de rendre une page vide :
 * une liste qui disparaît sans rien dire serait pire que la première page
 * (invariant #4 — jamais un repli silencieux qui se fait passer pour un
 * résultat).
 */
export function decodeRunCursor(cursor: string | null | undefined): RunCursor | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  const coupe = cursor.indexOf(SEP);
  if (coupe <= 0) return null;
  const quand = cursor.slice(0, coupe);
  const id = cursor.slice(coupe + 1);
  if (id === '') return null;
  if (quand === SANS_DATE) return { createdAt: null, id };
  const date = new Date(quand);
  if (Number.isNaN(date.getTime())) return null;
  return { createdAt: date, id };
}

// ─── Ce qu'on peut supprimer ─────────────────────────────────────────────────

/**
 * Un run PEUT-IL être supprimé depuis la liste ?
 *
 * Non tant qu'il n'a pas fini, et ce n'est pas de la prudence : le runner relit
 * ses lignes pour reprendre, et le retirer sous ses pieds ferait échouer une
 * reprise au lieu de dire non.
 *
 * `LIVE_JOB_STATUSES`, donc TOUS les statuts vivants — `awaiting_approval`
 * compris, qui n'allume pas le point vert mais n'a pas fini pour autant :
 * supprimer un run arrêté sur une demande emporterait la demande avec lui
 * (`approval_requests` cascade), en silence.
 *
 * Un statut ABSENT compte comme vivant : une ligne qui vient de naître n'en a
 * pas encore, et la lire comme « terminée » serait le repli silencieux
 * qu'interdit l'invariant #4.
 *
 * L'écran s'en sert pour désactiver la case ; l'action la REFAIT avant
 * d'écrire, parce qu'un écran n'est pas une garde.
 */
export function runIsDeletable(status: string | null): boolean {
  if (status === null) return false;
  return !(LIVE_JOB_STATUSES as readonly string[]).includes(status);
}

// ─── Comment un run s'appelle ────────────────────────────────────────────────

/** La même borne que le titre d'une conversation : le CSS coupe le reste. */
const TITLE_MAX = 120;

/**
 * Le titre d'un run : la première ligne lisible de sa tâche, MASQUÉE.
 *
 * Trois gestes, dans cet ordre, et l'ordre est la moitié du sujet :
 *
 *   1. `plainText` aplatit le markdown — une tâche écrite en gras s'afficherait
 *      sinon avec ses astérisques, et surtout un `**sk-…**` ne serait reconnu
 *      par aucun motif de rédaction ;
 *   2. `redactSecretsInText` masque (SECRET-001, Reviewer C sur #179). Ce titre
 *      EST la tâche que quelqu'un a postée à `/api/agent` : une clé collée
 *      dedans s'affichait en clair dans la liste, sur une ligne que personne
 *      n'a besoin d'ouvrir pour la lire ;
 *   3. `truncate` coupe EN DERNIER — couper d'abord laisserait passer les 120
 *      premiers signes d'une clé, ce qui en est l'essentiel.
 *
 * La liste des conversations masque par la même règle et pour la même raison,
 * à son propre bord de lecture (`firstLine`, lib/conversation-actions.ts) :
 * elle coupe les siens à 60 signes AVANT que cette ligne ne les voie.
 *
 * Une tâche vide rend « Untitled run » : un titre vide se lirait comme un
 * défaut d'affichage.
 *
 * ⚠️ IL VIT ICI, et non dans le dossier de l'écran, depuis le 18/09/2026 : le
 * SOUS-MENU d'un dossier de la barre latérale nomme les mêmes runs que la
 * liste du dossier, et la lecture qui le remplit est une action serveur.
 * L'importer depuis `app/(dashboard)/chat/run-rows.ts` aurait bouclé —
 * run-rows lit déjà le type `ExternalRunRow` de cette action — et
 * dependency-cruiser refuse un cycle, `import type` ou non.
 */
export function runTitle(task: string): string {
  const line = redactSecretsInText(plainText(task));
  return line === '' ? 'Untitled run' : truncate(line, TITLE_MAX);
}

/**
 * Un run avance-t-il encore ? Les mêmes statuts que le point vert des dossiers.
 *
 * Ici pour la même raison que `runTitle` : le sous-menu de la barre latérale
 * allume le point d'un run par cette règle, et sa lecture est une action
 * serveur.
 */
export function runIsRunning(status: string | null): boolean {
  return status !== null && RUNNING_JOB_STATUSES.includes(status);
}
