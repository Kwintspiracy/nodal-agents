// verification/harness.ts — constater ce qu'un HARNAIS de code a écrit.
//
// Issue #102, revue C de la PR #196. Depuis qu'une cible dossier ne crédite
// plus rien, un run de `code_task` en mode écriture ne constatait plus rien du
// tout : le CLI (Claude Code, Codex) écrit dans son propre processus, ses
// écritures ne passent par aucun outil de Nodal, et le seam n'a donc ni
// empreinte d'avant ni même la liste des fichiers à regarder. Tous les runs de
// harnais seraient partis en `produced = false`, et `declare_verification` les
// aurait refusés l'un après l'autre — un faux rouge sur tout le flux, aussi
// faux que le faux vert qu'on venait de retirer.
//
// Ce que ce module fait : il lit les lignes `tool_calls` VIVANTES que
// l'enregistreur pose pendant la session (`cli:Write`, `cli:file_change`, …),
// prend les chemins qu'elles DÉCLARENT, et va les regarder SUR LE DISQUE. Un
// fichier qui s'y trouve est une écriture constatée ; un fichier qui n'y est
// pas ne l'est pas, et cela se dit.
//
// Ce qu'il ne fait PAS, et la différence compte. Pour une cible nommée par un
// outil de Nodal, `observed.ts` compare une empreinte AVANT et APRÈS : un
// contenu réécrit à l'identique n'est pas une écriture. Ici il n'y a pas
// d'avant — personne ne savait quel fichier regarder avant que le CLI ne le
// nomme. Le constat est donc plus faible : ce que la ligne ANNONCE est-il ce
// que le disque porte ? Une écriture demande un fichier présent (vide compris :
// vider un fichier, c'est écrire), une suppression demande qu'il soit parti. Un CLI qui rapporterait un fichier sans l'avoir changé serait cru ;
// ce qu'on refuse, c'est de le croire sur un fichier ABSENT, et de créditer le
// projet entier sur la foi d'un `cwd`. La borne est écrite ici plutôt que
// passée sous silence.

import { stat } from 'node:fs/promises';
import { and, eq, inArray, toolCalls } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { MutationTarget } from '@nodal-agents/shared';
import {
  CLI_WRITE_TOOLS,
  isAbsolutePath,
  normalizePath,
  pathsDeclaredByCliWrite,
} from '@nodal-agents/shared';

/** Ce que le harnais a rapporté, trié par ce que le disque en dit. */
export interface HarnessWrites {
  /** Les fichiers rapportés et CONFIRMÉS par le disque — des écritures constatées. */
  readonly constates: readonly MutationTarget[];
  /** Une écriture annoncée dont le fichier n'est pas là. Dite, jamais créditée. */
  readonly introuvables: readonly string[];
  /** Une suppression annoncée dont le fichier est toujours là. Dite aussi. */
  readonly toujoursLa: readonly string[];
}

/** Les identifiants des lignes d'écriture CLI que ce job portait déjà. */
export type LignesDejaLa = ReadonlySet<string>;

/**
 * Les lignes d'écriture CLI déjà présentes sur ce job.
 *
 * Prise AVANT l'appel, cette liste borne la lecture d'après à CE run (revue C
 * de la PR #196, passe 2). Sans elle, un second `code_task` dans le même
 * dossier héritait des lignes du premier : le fichier écrit par le PREMIER run
 * est toujours sur le disque, donc le second passait pour avoir produit sans
 * avoir rien écrit — le faux vert de #102, revenu par la bande.
 *
 * Des identifiants de lignes plutôt qu'un instant : les deux horloges en jeu,
 * celle du processus et celle de la base, ne sont pas la même, et comparer des
 * dates écrites par l'une à un instant lu par l'autre est un pari, pas une
 * borne.
 */
export async function lignesDeHarnaisDejaLa(
  db: AnyDrizzleDb,
  jobId: string | null | undefined,
): Promise<LignesDejaLa> {
  if (!jobId) return new Set<string>();
  try {
    const lignes = await db
      .select({ id: toolCalls.id })
      .from(toolCalls)
      .where(and(eq(toolCalls.jobId, jobId), inArray(toolCalls.toolName, [...CLI_WRITE_TOOLS])));
    return new Set(lignes.map((l) => l.id));
  } catch (err) {
    console.warn(`[verification] HARNESS_ROWS_READ_FAILED job=${jobId}`, err);
    return new Set<string>();
  }
}

/** Le chemin ABSOLU d'un chemin rapporté, rebasé sur le dossier de travail. */
function absolu(chemin: string, workspaceRoots: readonly string[]): string | null {
  const p = normalizePath(chemin.trim());
  if (p === '') return null;
  if (isAbsolutePath(p)) return p;
  // Relatif : un CLI parle depuis son `cwd`, que l'appelant passe en tête des
  // racines. Sans racine, on ne devine pas — un chemin relatif résolu au hasard
  // ferait constater un fichier d'un autre dossier.
  const racine = workspaceRoots[0];
  return racine === undefined ? null : `${normalizePath(racine)}/${p.replace(/^\.\//, '')}`;
}

/**
 * Les fichiers qu'un harnais a écrits pendant CE job, constatés sur le disque.
 *
 * `roots` sert à deux choses : résoudre un chemin relatif (la première est le
 * dossier du run), et rien d'autre — le rebasage lexical et la règle de projet
 * restent l'affaire d'`observedDeliverableKeys`, qui les applique ensuite.
 *
 * Ne lève jamais : une panne de lecture se dit et ne crédite rien, comme
 * partout dans ce module (invariant #4).
 */
export async function constatedHarnessWrites(input: {
  readonly db: AnyDrizzleDb;
  readonly jobId: string;
  readonly roots: readonly string[];
  /**
   * Les lignes que le job portait AVANT ce run (`lignesDeHarnaisDejaLa`).
   * Elles sont écartées : elles parlent d'un autre run, et son fichier est
   * toujours sur le disque.
   */
  readonly dejaLa: LignesDejaLa;
}): Promise<HarnessWrites> {
  const rien = { constates: [], introuvables: [], toujoursLa: [] };
  if (!input.jobId) return rien;
  let lignes: Array<{ id: string; toolName: string; toolInput: unknown }> = [];
  try {
    lignes = await input.db
      .select({ id: toolCalls.id, toolName: toolCalls.toolName, toolInput: toolCalls.toolInput })
      .from(toolCalls)
      .where(
        and(eq(toolCalls.jobId, input.jobId), inArray(toolCalls.toolName, [...CLI_WRITE_TOOLS])),
      );
  } catch (err) {
    console.warn(`[verification] HARNESS_WRITES_READ_FAILED job=${input.jobId}`, err);
    return rien;
  }

  const vus = new Set<string>();
  const constates: MutationTarget[] = [];
  const introuvables: string[] = [];
  const toujoursLa: string[] = [];
  for (const ligne of lignes) {
    // CE run, et lui seul : une ligne déjà là appartient à un run précédent.
    if (input.dejaLa.has(ligne.id)) continue;
    for (const declare of pathsDeclaredByCliWrite(ligne.toolName, ligne.toolInput)) {
      const path = absolu(declare.path, input.roots);
      if (path === null || vus.has(path)) continue;
      vus.add(path);
      // Le disque, relu. Un fichier VIDE est un fichier : un harnais qui vide
      // un fichier a bel et bien écrit, et le dire « jamais vu sur le disque »
      // serait faux (revue C, passe 2).
      let present: boolean;
      try {
        present = (await stat(path)).isFile();
      } catch {
        present = false;
      }
      // Une suppression se constate par l'ABSENCE, une écriture par la
      // présence. Chaque désaccord entre ce qui est annoncé et ce que le disque
      // porte est dit sous son propre nom, jamais fondu dans l'autre.
      const tenu = declare.kind === 'delete' ? !present : present;
      if (tenu) {
        constates.push({ kind: 'file', path, deliverableType: 'code_project', scope: 'addressed' });
      } else if (declare.kind === 'delete') {
        toujoursLa.push(path);
      } else {
        introuvables.push(path);
      }
    }
  }
  return { constates, introuvables, toujoursLa };
}
