// router/resume.ts — inject child result into parent and resume
// Called when a child job completes (by cron or worker completing a child job).

import { eq, and } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import type { JobFailureHint } from '@nodal-agents/shared';
import { OrchestrationError } from '../errors';
import {
  REVIEW_CHANGES_REQUESTED,
  TOOL_RESULT_MODEL_CHARS,
  cutForContext,
  fitToolResult,
  reviewBlocksDelivery,
} from '@nodal-agents/shared';
import { nextFailedDelegationState, failedDelegationGuidance } from './failed-delegation';
import {
  readJobDeliverable,
  renderDeliveredVerdicts,
  verdictsBlockDelivery,
} from './job-deliverable';
import type { AuthoredReviewVerdict } from './job-deliverable';
import { filesTheChildWrote, readFilesWrittenBy } from './delegated-files';
import type { DelegatedFile } from './delegated-files';
import type { AgentId, EntityId, JobId, AnyDrizzleDb, AgentJob } from '../types';

/**
 * The TYPED outcome of one delegation, as the parent receives it.
 *
 * Modelled on Hermes (`tools/delegate_tool.py:2080-2130`): the parent never
 * gets a bare string it has to guess the meaning of, it gets a record whose
 * `status` field says whether anything was actually delivered. `summary` is the
 * child's deliverable — its final assistant text — and an empty summary on a
 * `completed` status is impossible by construction: the runner fails such a
 * child before it ever reaches here (execute.ts, empty-deliverable guard).
 */
export interface DelegationOutcomeRecord {
  status: 'completed' | 'failed' | 'blocked';
  /** The child's deliverable: the last assistant text it produced. */
  summary: string;
  /** Machine reason when status is not `completed`. */
  error?: string | null;
  /** How the child's run ended (`return_result_success`, `empty_deliverable`, …). */
  exit_reason?: string | null;
  /** Tools the child actually ran, so the parent can see what was attempted. */
  tools_used?: string[];
  /**
   * Les verdicts de revue livrés dans le SOUS-ARBRE de l'enfant, chacun avec
   * son auteur — slug d'agent et id de job (issues #124, #646). `summary` reste
   * la dernière phrase du modèle ; ce champ porte ce que l'outil
   * `review_verdict` a validé. Celui de l'enfant s'il en a enregistré un, ET
   * ceux de sa descendance : un intermédiaire qui relaie (root → Lead →
   * relecteur) ou qui juge à son tour ne fait plus disparaître le verdict d'en
   * dessous — aucun verdict d'un job n'en remplace un autre. Lus par
   * `readJobDeliverables`, seul lecteur de « ce qu'un job a livré ».
   * `[]` sur l'immense majorité des délégations, qui ne sont pas des revues.
   */
  review_verdicts?: AuthoredReviewVerdict[];
  /**
   * Ce que la relecture INTERDIT (#59). `review_changes_requested` dès qu'UN
   * des verdicts portés demande des corrections (`verdictsBlockDelivery`) : le
   * parent ne peut pas conclure que le travail est livré, et il reçoit ce fait
   * typé plutôt qu'une phrase à interpréter dans le résumé.
   *
   * `null` partout ailleurs — une délégation ordinaire, ou des relectures qui
   * approuvent toutes, n'interdisent rien.
   */
  delivery_blocked?: typeof REVIEW_CHANGES_REQUESTED | null;
  /**
   * Le geste que ce code d'échec appelle, quand il en appelle un — un CHAMP,
   * jamais une phrase (#119, revue passe 1). Le harnais n'a pas à écrire
   * « essaie un autre modèle » : il pose le fait, et l'écran ou le modèle le
   * dit dans la langue de la personne (invariant #2).
   */
  hint?: JobFailureHint | null;
  /**
   * L'issue du SOUS-ARBRE de cette délégation, spécialiste par spécialiste
   * (issue #116, résidus 1 et 2).
   *
   * Un parent ne voyait que son propre enfant. L'échec d'un PETIT-enfant ne lui
   * parvenait que dans le texte du livrable — la ligne `[delegation stopped:
   * … — no deliverable]` —, donc dans de la prose qu'un modèle peut écrire
   * lui-même, avec le nom qu'il veut. La PR #108 l'a relue un temps ; la revue
   * l'a mesuré et la relecture a été retirée avant le merge.
   *
   * Ce champ est écrit par le HARNAIS, depuis sa propre comptabilité : la carte
   * que le runner tient pendant le run de l'enfant, elle-même alimentée par les
   * enregistrements TYPÉS de ses propres enfants. Rien n'en est lu dans une
   * phrase, à aucun étage.
   *
   * Chaque entrée porte la DERNIÈRE issue connue du spécialiste nommé, y
   * compris `delivered` : c'est ce fait-là qui permet à une réparation réelle
   * d'effacer un échec propagé (résidu 2). Sans lui, un échec transmis une fois
   * ne pouvait plus s'effacer que par une livraison du même nom AU MÊME ÉTAGE,
   * jamais par une réparation faite ailleurs dans l'arbre.
   */
  sub_delegations?: SubDelegationOutcome[];
  /**
   * Combien d'issues du sous-arbre NE SONT PAS dans `sub_delegations` (revue
   * Codex de la PR #712, passe 3). Absent quand la liste est complète, ce qui
   * est le cas ordinaire.
   *
   * Une liste ne devient partielle qu'à un endroit : le rendu borné de
   * `renderDelegationOutcome`, quand le résultat ne tient pas dans le budget
   * d'un résultat d'outil. Le runner qui relit ce rendu ne connaît plus le nom
   * des issues retirées ; il les compte, et les fait remonter comptées.
   */
  sub_delegations_omitted?: number;
  /**
   * Combien d'issues du sous-arbre sont `failed`, sur TOUTES — celles que
   * `sub_delegations` liste et celles qu'elle ne liste plus. Absent quand la
   * liste est complète : le compte se lit alors sur la liste.
   *
   * C'est lui, et jamais la liste partielle, qui dit si quelque chose a échoué
   * (`failedSubDelegationsLeftUnnamed`) : une liste bornée qui ne montre aucun
   * échec ne prouve pas qu'il n'y en a eu aucun.
   */
  sub_delegations_failed?: number;
  /**
   * Les fichiers que l'enfant a ÉCRITS ou DÉCLARÉS, relus par `resumeDelegated`
   * sur les lignes d'état de vérification de l'enfant (issue #491) — jamais
   * fournis par l'appelant, jamais lus dans une phrase.
   *
   * Un enfant arrêté (budget, plafond de tours, runner redémarré, livrable
   * déclaré non vérifié…) a souvent déjà écrit son livrable. Sans ce champ, le
   * parent ne recevait qu'un échec et refaisait le travail.
   */
  files_written?: DelegatedFile[];
}

/**
 * La dernière issue connue d'UN spécialiste dans le sous-arbre d'une délégation.
 *
 * `tool` est le nom d'outil (`assign_<slug>`), le même à tous les étages : les
 * slugs sont globaux, donc la clé désigne le même spécialiste que le parent
 * l'ait appelé lui-même ou qu'un de ses enfants l'ait fait.
 */
export interface SubDelegationOutcome {
  tool: string;
  status: 'failed' | 'delivered';
}

/**
 * Les gestes que le harnais peut nommer après un échec.
 *
 * Le type vit dans `@nodal-agents/shared` (#194, revue passe 1) : le runner le
 * POSE, l'orchestration le TRANSPORTE, l'écran le DIT — trois paquets dont
 * aucun ne dépend des deux autres. Il reste exporté d'ici, où vit le record qui
 * le porte, pour que les appelants n'aient pas à changer d'import.
 */
export type { JobFailureHint };

/**
 * What the child handed back. `string` = the child's text result on success and
 * `{ error: string }` = a bare failure; both are legacy shapes kept for callers
 * that have no richer information, and both are normalized into a
 * `DelegationOutcomeRecord` before injection. A failure is injected as an `error-text`
 * tool_result so the parent's LLM treats it as a tool failure and can react
 * (notify the user, try a different sub-agent, `return_result{status:'blocked'}`)
 * instead of dying silently alongside the child.
 */
export type DelegationOutcome = string | { error: string } | DelegationOutcomeRecord;

/**
 * Marker opening the tool-result of a delegation that DELIVERED NOTHING.
 *
 * It exists so the runner can tell that case apart from the other `error-text`
 * tool-result an `assign_*` call can carry: a DEFERRAL (`buildDeferredToolResults`
 * — "another handoff took priority, call me again"), which is not a failure at
 * all. Without the marker, guard 3b's cross-run seeding would read a deferral as
 * an unresolved failure and refuse the parent's honest success.
 */
export const DELEGATION_FAILED_MARKER = '[delegation-produced-nothing]';

/** Normalize any accepted outcome shape into the typed record. */
export function normalizeDelegationOutcome(outcome: DelegationOutcome): DelegationOutcomeRecord {
  if (typeof outcome === 'string') {
    return { status: 'completed', summary: outcome, error: null, exit_reason: null };
  }
  if ('status' in outcome) return outcome;
  return { status: 'failed', summary: '', error: outcome.error, exit_reason: null };
}

/**
 * Valeur du `summary` d'un résultat de délégation qui dépasse le budget : le
 * texte n'est pas vide, il est APRÈS l'objet JSON, avec les constats.
 */
export const DELEGATION_TEXT_AFTER_OBJECT = '[after this object]';

/**
 * Render the typed outcome as the tool-result payload the parent's model reads.
 * JSON, deliberately: the fields are the contract, and a model that sees
 * `"status": "failed"` cannot mistake it for a specialist that answered.
 *
 * Un résultat de délégation EST un résultat d'outil : il tient dans le même
 * budget (`TOOL_RESULT_MODEL_CHARS`), coupé par la même fonction
 * (`cutForContext`, `@nodal-agents/shared`) que tous les autres (revue Codex de
 * la PR #712, passe 2 : un arbre large de relecteurs, chacun jusqu'à 50
 * constats, rendait un `tool_result` sans borne dans le contexte du parent).
 *
 * Le rendu entier n'est écrit que s'il porte TOUT et tient dans `room` : il est
 * alors tel qu'avant, octet pour octet. Sinon, c'est le rendu borné :
 *  1. un objet JSON VALIDE et COMPLET, qui tient par construction — jamais
 *     coupé comme du texte (revue Codex de la PR #712, passe 3 : un objet trop
 *     grand à lui seul était tranché, `parseDelegationOutcomePayload` rendait
 *     `null`, et le runner perdait en silence les échecs du sous-arbre). Voir
 *     `decisionsBornees` ;
 *  2. puis le texte long : le `summary` de l'enfant, puis chaque verdict mis en
 *     page (`renderDeliveredVerdicts`) avec son résumé et ses constats. C'est
 *     lui, et lui seul, que la coupe peut atteindre.
 * La marque de troncature dit combien a été retiré. Les constats complets
 * restent en base, dans les `tool_calls` de chaque job relecteur, que les ids
 * affichés désignent.
 */
export function renderDelegationOutcome(
  result: DelegationOutcomeRecord,
  room: number = TOOL_RESULT_MODEL_CHARS,
): string {
  const entier = JSON.stringify(
    {
      status: result.status,
      summary: result.summary,
      error: result.error ?? null,
      exit_reason: result.exit_reason ?? null,
      tools_used: result.tools_used ?? [],
      // Tous TOUJOURS présents, `[]` / `null` quand il n'y a pas eu de revue,
      // que rien n'est interdit ou qu'aucun geste n'est nommé : un champ qui
      // apparaît et disparaît se lit comme une absence de contrat.
      review_verdicts: result.review_verdicts ?? [],
      delivery_blocked: result.delivery_blocked ?? null,
      hint: result.hint ?? null,
      // Toujours présent, `[]` quand le sous-arbre n'a rien à dire — même
      // raison que les deux champs ci-dessus (#116).
      sub_delegations: result.sub_delegations ?? [],
      // Toujours présent, `[]` quand l'enfant n'a rien écrit (#491).
      files_written: result.files_written ?? [],
    },
    null,
    2,
  );
  // Une liste de sous-délégations déjà partielle (un étage plus bas a été
  // borné) ne s'écrit pas sous la forme entière, qui n'a pas de place pour le
  // dire : elle prend la forme bornée, qui porte ses comptes.
  if (entier.length <= room && (result.sub_delegations_omitted ?? 0) === 0) return entier;

  // Ce que chaque liste garde D'ABORD quand elle doit laisser des entrées : ce
  // sur quoi quelqu'un agit. L'ordre d'origine tient à l'intérieur de chaque
  // groupe. Les comptes, eux, portent sur toutes les entrées.
  //  - verdicts : ceux qui demandent des corrections, puisque ce sont eux qui
  //    bloquent la livraison ;
  //  - sous-délégations : les échecs, puisque ce sont eux que le runner dit à
  //    la personne (`[delegation stopped: …]`) ;
  //  - fichiers : ceux que l'enfant a écrits et qui sont là, puisque ce sont
  //    eux que le parent ne doit pas refaire (#491) ;
  //  - outils : l'ordre d'origine, aucun n'emporte de décision.
  const verdicts = gardeDAbord(result.review_verdicts ?? [], (v) => reviewBlocksDelivery(v));
  const texteLong = [
    result.summary === '' ? '' : `[summary]\n${result.summary}`,
    renderDeliveredVerdicts({ review_verdicts: verdicts, unreadable_review_verdicts: [] }),
  ]
    .filter((t) => t !== '')
    .join('\n\n');
  const decisions = decisionsBornees(
    result,
    {
      review_verdicts: verdicts.map((v) => ({
        author: v.author,
        verdict: v.verdict,
        counts: v.counts,
      })),
      sub_delegations: gardeDAbord(result.sub_delegations ?? [], (s) => s.status === 'failed'),
      files_written: gardeDAbord(
        result.files_written ?? [],
        (f) => filesTheChildWrote([f]).length > 0,
      ),
      tools_used: result.tools_used ?? [],
    },
    // Ni les listes ni le texte n'affament l'autre : l'objet prend au plus la
    // moitié de la place quand le texte long en veut davantage, et tout ce que
    // le texte laisse sinon.
    Math.max(Math.floor(room / 2), room - (texteLong === '' ? 0 : texteLong.length + 2)),
  );
  // L'objet sans aucune entrée de liste ne porte que des codes : il ne dépasse
  // pas la place. S'il le faisait, il serait rendu entier plutôt que coupé —
  // un objet tranché n'est plus lisible par personne.
  if (texteLong === '' || decisions.length >= room) return decisions;
  return cutForContext(`${decisions}\n\n${texteLong}`, room);
}

/** Les entrées qui vérifient `dAbord` en tête, l'ordre d'origine gardé dans chaque groupe. */
function gardeDAbord<T>(entrees: readonly T[], dAbord: (e: T) => boolean): T[] {
  return [...entrees.filter(dAbord), ...entrees.filter((e) => !dAbord(e))];
}

/** Les listes de l'objet borné, chacune déjà dans l'ordre où elle garde ses entrées. */
interface ListesBornables {
  review_verdicts: Array<Pick<AuthoredReviewVerdict, 'author' | 'verdict' | 'counts'>>;
  sub_delegations: SubDelegationOutcome[];
  files_written: DelegatedFile[];
  tools_used: string[];
}

type NomDeListe = keyof ListesBornables;

const LISTES: readonly NomDeListe[] = [
  'review_verdicts',
  'sub_delegations',
  'files_written',
  'tools_used',
];

/**
 * L'objet de décision d'un résultat borné : du JSON valide, complet, d'au plus
 * `place` caractères dès que ses champs scalaires y tiennent — par
 * CONSTRUCTION, jamais par une coupe de texte.
 *
 * Une seule forme pour toutes les listes : `<liste>` porte les entrées gardées,
 * `<liste>_omitted` dit combien n'y sont pas. Le total est leur somme.
 *
 * Ce qui ne s'omet JAMAIS : `status`, `error`, `exit_reason`,
 * `delivery_blocked` (calculé en amont sur tous les verdicts), `hint`, et les
 * comptes sur lesquels le runner et le parent décident, calculés sur TOUTES
 * les entrées — `review_verdicts_request_changes` et `sub_delegations_failed`.
 *
 * Les listes se remplissent à tour de rôle, une entrée chacune, dans l'ordre où
 * elles gardent leurs entrées : aucune ne prend toute la place aux autres. Une
 * liste dont l'entrée suivante ne tient plus s'arrête là — ce qu'elle garde est
 * toujours un début de son ordre.
 */
function decisionsBornees(
  result: DelegationOutcomeRecord,
  listes: ListesBornables,
  place: number,
): string {
  const echouees = listes.sub_delegations.filter((s) => s.status === 'failed').length;
  const corrections = listes.review_verdicts.filter((v) => reviewBlocksDelivery(v)).length;
  const rendre = (gardes: Record<NomDeListe, number>): string =>
    JSON.stringify(
      {
        status: result.status,
        error: result.error ?? null,
        exit_reason: result.exit_reason ?? null,
        delivery_blocked: result.delivery_blocked ?? null,
        hint: result.hint ?? null,
        review_verdicts: listes.review_verdicts.slice(0, gardes.review_verdicts),
        review_verdicts_omitted: listes.review_verdicts.length - gardes.review_verdicts,
        review_verdicts_request_changes: corrections,
        sub_delegations: listes.sub_delegations.slice(0, gardes.sub_delegations),
        sub_delegations_omitted:
          (result.sub_delegations_omitted ?? 0) +
          listes.sub_delegations.length -
          gardes.sub_delegations,
        sub_delegations_failed: result.sub_delegations_failed ?? echouees,
        files_written: listes.files_written.slice(0, gardes.files_written),
        files_written_omitted: listes.files_written.length - gardes.files_written,
        tools_used: listes.tools_used.slice(0, gardes.tools_used),
        tools_used_omitted: listes.tools_used.length - gardes.tools_used,
        summary: result.summary === '' ? '' : DELEGATION_TEXT_AFTER_OBJECT,
      },
      null,
      2,
    );

  const gardes: Record<NomDeListe, number> = {
    review_verdicts: 0,
    sub_delegations: 0,
    files_written: 0,
    tools_used: 0,
  };
  // Mesuré avec toutes les listes vides, donc avec les comptes `_omitted` au
  // plus grand : ajouter une entrée ne fait que les baisser, si bien que
  // `longueur` reste une borne HAUTE de la longueur réelle.
  let longueur = rendre(gardes).length;
  const ouvertes = new Set<NomDeListe>(LISTES);
  while (ouvertes.size > 0) {
    for (const nom of LISTES) {
      if (!ouvertes.has(nom)) continue;
      const liste: readonly unknown[] = listes[nom];
      const deja = gardes[nom];
      if (deja >= liste.length) {
        ouvertes.delete(nom);
        continue;
      }
      const cout = coutDansUneListe(liste[deja], deja === 0);
      if (longueur + cout > place) {
        ouvertes.delete(nom);
        continue;
      }
      gardes[nom] = deja + 1;
      longueur += cout;
    }
  }
  return rendre(gardes);
}

/**
 * Ce qu'une entrée ajoute à un tableau de second niveau dans
 * `JSON.stringify(_, null, 2)` : chacune de ses lignes indentée de quatre
 * espaces, plus `\n` … `\n  ` autour de la première (le `[]` vide avait déjà
 * ses crochets), ou `,\n` devant les suivantes.
 */
function coutDansUneListe(entree: unknown, premiere: boolean): number {
  const brut = JSON.stringify(entree, null, 2);
  const lignes = brut.split('\n').length;
  return brut.length + 4 * lignes + (premiere ? 4 : 2);
}

/**
 * Combien d'échecs du sous-arbre ce record compte SANS les nommer : ceux qu'un
 * rendu borné a retirés de `sub_delegations` (revue Codex de la PR #712,
 * passe 3). `0` sur un record complet.
 *
 * Le runner s'en sert pour ne jamais conclure « rien n'a échoué » d'une liste
 * partielle : il dit ces échecs comptés, et les fait remonter comptés.
 */
export function failedSubDelegationsLeftUnnamed(record: DelegationOutcomeRecord): number {
  const nommes = (record.sub_delegations ?? []).filter((s) => s.status === 'failed').length;
  return Math.max(0, (record.sub_delegations_failed ?? nommes) - nommes);
}

/**
 * L'inverse de `renderDelegationOutcome` : relit l'enregistrement typé dans la
 * charge utile d'un `tool_result` de délégation (issue #116).
 *
 * Elle vit ICI, contre le rendu, parce que deux formes qui divergent seraient
 * le bug : le runner qui relit ses propres délégations n'a jamais à connaître
 * la mise en page du texte d'échec.
 *
 * Deux formes acceptées, et seulement elles :
 *   - un succès, qui EST le JSON ;
 *   - un échec, `DELEGATION_FAILED_MARKER`, l'objet JSON, puis les consignes
 *     que le parent lit.
 * Dans les deux, l'objet peut être le rendu entier ou le rendu borné, suivi de
 * son texte long : l'objet borné est toujours du JSON complet, et ses comptes
 * (`sub_delegations_omitted`, `sub_delegations_failed`) sont relus avec lui.
 *
 * Rend `null` sur tout le reste — un report, un texte posé par la compaction,
 * une ligne d'une version antérieure. `null` veut dire « je ne sais pas », pas
 * « rien n'a échoué » : l'appelant garde alors ses heuristiques.
 *
 * Le balayage d'accolades est conscient des chaînes : le `summary` est du
 * texte de modèle et peut contenir une accolade, voire un faux
 * `"sub_delegations"`. Comme il est une VALEUR du même objet, il ne peut pas
 * en sortir, et le champ relu reste celui que le harnais a écrit.
 */
export function parseDelegationOutcomePayload(payload: string): DelegationOutcomeRecord | null {
  const debut = payload.indexOf('{');
  if (debut === -1) return null;
  let profondeur = 0;
  let dansChaine = false;
  let echappe = false;
  let fin = -1;
  for (let i = debut; i < payload.length; i++) {
    const c = payload[i];
    if (dansChaine) {
      if (echappe) echappe = false;
      else if (c === '\\') echappe = true;
      else if (c === '"') dansChaine = false;
      continue;
    }
    if (c === '"') dansChaine = true;
    else if (c === '{') profondeur++;
    else if (c === '}') {
      profondeur--;
      if (profondeur === 0) {
        fin = i;
        break;
      }
    }
  }
  if (fin === -1) return null;
  let brut: unknown;
  try {
    brut = JSON.parse(payload.slice(debut, fin + 1));
  } catch {
    return null;
  }
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return null;
  const objet = brut as Record<string, unknown>;
  const status = objet['status'];
  if (status !== 'completed' && status !== 'failed' && status !== 'blocked') return null;
  if (typeof objet['summary'] !== 'string') return null;
  const record: DelegationOutcomeRecord = { status, summary: objet['summary'] };
  if (typeof objet['error'] === 'string') record.error = objet['error'];
  if (typeof objet['exit_reason'] === 'string') record.exit_reason = objet['exit_reason'];
  const sub = objet['sub_delegations'];
  if (Array.isArray(sub)) {
    const issues: SubDelegationOutcome[] = [];
    for (const entree of sub) {
      if (!entree || typeof entree !== 'object' || Array.isArray(entree)) continue;
      const e = entree as Record<string, unknown>;
      const tool = e['tool'];
      const etat = e['status'];
      // Un nom d'outil de délégation, et rien d'autre : c'est la seule clé que
      // ce champ a le droit de nommer.
      if (typeof tool !== 'string' || !tool.startsWith('assign_')) continue;
      if (etat !== 'failed' && etat !== 'delivered') continue;
      issues.push({ tool, status: etat });
    }
    record.sub_delegations = issues;
  }
  // Les comptes d'une liste bornée (revue Codex de la PR #712, passe 3) : sans
  // eux, une liste partielle se lirait comme le sous-arbre entier.
  for (const champ of ['sub_delegations_omitted', 'sub_delegations_failed'] as const) {
    const n = objet[champ];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) record[champ] = n;
  }
  return record;
}

/**
 * Pose sur le record les verdicts livrés dans le sous-arbre de l'enfant, et ce
 * qu'ils interdisent (#59) — lus par `readJobDeliverable`, le lecteur unique de
 * « ce qu'un job a livré » (#646). Toujours relus ici : aucun appelant ne les
 * fournit, et une seconde source serait une seconde réponse.
 *
 * Une ligne illisible dans le sous-arbre ne remonte PAS en exception : elle
 * deviendrait une sortie de `resumeDelegated` AVANT la mise à jour du parent,
 * qui resterait `awaiting_delegation` avec un appel d'outil sans réponse, et
 * personne ne serait prévenu (revue de la PR #170, constat 2). La délégation
 * devient donc un ÉCHEC nommé : le parent reçoit le `error-text` des
 * délégations ratées, avec le code, et peut agir. Fort et à la bonne place.
 */
async function withDeliveredReviewVerdicts(
  outcome: DelegationOutcomeRecord,
  childJobId: JobId,
  db: AnyDrizzleDb,
): Promise<DelegationOutcomeRecord> {
  const delivered = await readJobDeliverable(db, childJobId as string);
  if (delivered && delivered.unreadable_review_verdicts.length > 0) {
    return {
      ...outcome,
      status: 'failed',
      error: 'review_verdict_malformed',
      review_verdicts: [],
      delivery_blocked: null,
    };
  }
  const verdicts = delivered?.review_verdicts ?? [];
  return {
    ...outcome,
    review_verdicts: verdicts,
    // Le champ est TOUJOURS écrit, `null` compris : un parent qui reçoit un
    // résultat sans ce champ ne saurait pas s'il n'y a rien à dire ou si
    // personne ne l'a regardé.
    delivery_blocked: verdictsBlockDelivery(verdicts) ? REVIEW_CHANGES_REQUESTED : null,
  };
}

/**
 * Extract the child slug from a `pending_delegation.toolName` of the form
 * `assign_<slug>` (e.g. `assign_summarizer` → `summarizer`). The runner
 * applies the same transform when dispatching, so this is just its inverse.
 * Returns `null` if the tool name doesn't follow the convention.
 */
function childSlugFromToolName(toolName: string): string | null {
  if (!toolName.startsWith('assign_')) return null;
  return toolName.slice('assign_'.length).replace(/_/g, '-');
}

// ─── resumeDelegated ──────────────────────────────────────────────────────────

/**
 * Inject the child job's result as a tool_result into the parent job's messages,
 * then set parent.status = 'pending' so the runner picks it up again.
 *
 * This implements the "parent resumes" leg of the Router delegation flow:
 *   child completes → resumeDelegated() → parent.status = 'pending' → worker resumes
 *
 * Steps:
 * 1. Load parent job — verify status is 'awaiting_delegation'
 * 2. Read pending_delegation.toolUseId
 * 3. Append tool_result block to parent.messages (text on success, error-text on failure)
 * 4. Include sideToolResults from pending_delegation (message-integrity invariant)
 * 5. Set parent.status = 'pending', clear pending_delegation
 *
 * @param parentJobId  The ID of the waiting parent job
 * @param childJobId   The ID of the completed child job — read for the
 *                     verdicts of its subtree (#124, #646), and for logging/audit
 * @param childOutcome The child's text result, OR `{error}` if the child failed
 * @param db           Drizzle DB handle
 * @returns            Updated parent job row
 */
export async function resumeDelegated(
  parentJobId: JobId,
  childJobId: JobId,
  childOutcome: DelegationOutcome,
  db: AnyDrizzleDb,
): Promise<AgentJob> {
  // 1. Load parent
  const parentRows = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      messages: agentJobs.messages,
      pendingDelegation: agentJobs.pendingDelegation,
      agentId: agentJobs.agentId,
      entityId: agentJobs.entityId,
      chainCount: agentJobs.chainCount,
      delegationDepth: agentJobs.delegationDepth,
      lastFailedDelegationSlug: agentJobs.lastFailedDelegationSlug,
      lastFailedDelegationStreak: agentJobs.lastFailedDelegationStreak,
      parentJobId: agentJobs.parentJobId,
      task: agentJobs.task,
      channel: agentJobs.channel,
      chatId: agentJobs.chatId,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, parentJobId as string))
    .limit(1);

  const parent = parentRows[0];
  if (!parent) {
    throw new OrchestrationError('parent_not_found', `Parent job not found: ${parentJobId}`);
  }

  // 2. Verify parent is waiting for delegation.
  //
  // Special case — parent already terminal: when the user cancels a parent
  // that was awaiting delegation, the cascade in `cancelJobAction` flips
  // the parent to 'cancelled' immediately, but the child is typically
  // already executing and finishes its current LLM turn before observing
  // its own cancel. When that child then calls resumeDelegated, the
  // parent is in 'cancelled' / 'completed' / 'failed' rather than
  // 'awaiting_delegation' — that's a legal race, not a bug. Returning a
  // no-op snapshot lets the caller's `executeJob(parent)` re-entry see
  // the terminal status via its own guard and exit with 'already_handled'.
  //
  // For non-terminal mismatches (pending / processing) we still throw —
  // those indicate a real concurrency violation (the parent isn't waiting
  // for this child) and we want to fail loud rather than silently corrupt
  // the parent's messages array.
  const TERMINAL_PARENT_STATUSES = new Set(['cancelled', 'completed', 'failed']);
  if (parent.status !== 'awaiting_delegation') {
    if (parent.status && TERMINAL_PARENT_STATUSES.has(parent.status)) {
      return {
        id: parent.id as JobId,
        agentId: parent.agentId as AgentId | null,
        entityId: parent.entityId as EntityId | null,
        status: parent.status,
        messages: Array.isArray(parent.messages) ? (parent.messages as unknown[]) : [],
        pendingDelegation: null,
        chainCount: parent.chainCount ?? 0,
        delegationDepth: parent.delegationDepth ?? 0,
        parentJobId: parent.parentJobId as JobId | null,
        task: parent.task,
        channel: parent.channel,
        chatId: parent.chatId,
      };
    }
    throw new OrchestrationError(
      'parent_wrong_status',
      `Parent job ${parentJobId} has status '${parent.status}', expected 'awaiting_delegation'`,
    );
  }

  // 3. Extract the tool_use_id we need to match
  const pending = parent.pendingDelegation as {
    toolUseId?: string;
    toolName?: string;
    subJobId?: string;
    sideToolResults?: Array<{
      type: string;
      tool_use_id: string;
      toolName?: string;
      content: string;
      is_error?: boolean;
    }>;
  } | null;

  if (!pending?.toolUseId) {
    throw new OrchestrationError(
      'missing_tool_use_id',
      `Parent job ${parentJobId} has no toolUseId in pending_delegation`,
    );
  }

  const toolUseId = pending.toolUseId;

  // toolName is required by AI SDK v4 tool-result format. It was added to
  // pending_delegation by handleDelegation; legacy rows without it are
  // unrecoverable at this layer (we can't reconstruct the assign_<slug> tool
  // name without re-querying the orchestrator's children).
  const toolName = pending.toolName;
  if (!toolName) {
    throw new OrchestrationError(
      'missing_tool_use_id',
      `Parent job ${parentJobId} has no toolName in pending_delegation (legacy row?)`,
    );
  }

  // 4. Build a tool-role message in AI SDK v6 ModelMessage format.
  // Shape: { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName,
  //          output: ToolResultOutput }, …] }
  // ToolResultOutput is a discriminated union — we use 'text' for normal child
  // results (string) and 'error-text' for the deferred-sibling markers (which
  // carry is_error=true so the LLM treats them as failures, not normal results).
  type ToolResultOutput = { type: 'text'; value: string } | { type: 'error-text'; value: string };
  // Le livrable d'une revue est le verdict enregistré, pas la phrase par
  // laquelle on l'annonce (issue #124), et il traverse les relais (#646). On le
  // lit sur les lignes `tool_calls` du sous-arbre et on le met dans le record
  // TYPÉ, seul objet que le parent reçoive : sans cela le parent redélègue la
  // même revue.
  const outcome = {
    ...(await withDeliveredReviewVerdicts(
      normalizeDelegationOutcome(childOutcome),
      childJobId,
      db,
    )),
    // Relu ICI, point de passage de toute issue de délégation qu'un parent
    // ATTEND — l'enfant exécuté en ligne, celui qu'un runner mort laisse au
    // faucheur, celui qu'une approbation reprend plus tard : un seul endroit,
    // une seule réponse, quelle que soit la façon dont l'enfant s'est arrêté
    // (#491). Sauf l'annulation : annuler un enfant annule aussi le parent qui
    // l'attend (execute.ts, `maybeResumeParent` et la délégation en ligne),
    // donc personne n'attend son résultat, et elle ne passe pas par ici.
    files_written: await readFilesWrittenBy(db, childJobId),
  };
  const isFailure = outcome.status !== 'completed';

  // Per-slug delegation cap: track the slug of the LAST failed child so the
  // runner can block a naive same-slug retry while still letting the
  // orchestrator fall back to a DIFFERENT specialist.
  //
  // Live regression — job `7767a3c1` (2026-05-19): Conciergus delegated to
  // Summarizus → timeout (51 turns, 2.4M tokens, never wrote anything). The
  // prior global counter (`failed_delegations_count`) blocked Conciergus's
  // legitimate fallback to Obsidius (different specialist, same job)
  // alongside the naive retry of Summarizus. Per-slug semantics let the
  // fallback go through.
  //
  // Set on failure → child slug of the failing delegation.
  // Cleared on success → so subsequent same-slug delegations are allowed
  // once any progress has been made on the parent.
  const failedSlug = isFailure ? childSlugFromToolName(toolName) : null;
  // The streak counts consecutive failures of that slug (#510): the gate
  // refuses a retry only from the second one, so the first failure leaves
  // room for ONE targeted retry of the agent that has the means.
  const nextFailedState = nextFailedDelegationState(
    {
      slug: parent.lastFailedDelegationSlug ?? null,
      streak: parent.lastFailedDelegationStreak ?? 0,
    },
    failedSlug,
  );

  // The parent MUST NOT be able to turn a failed delegation into a promise.
  // The incident this closes (#107, job f1852d35): the child produced nothing,
  // the parent read "(no output)" as an answer and told the user "recherche
  // lancée, je te renvoie la synthèse" — a result that had already failed to
  // exist. So the failure payload names the three legal moves and forbids the
  // fourth. LLM-channel text only; it never reaches the user (invariant #2).
  //
  // #491 — a child stopped AFTER writing files did deliver something: those
  // files. Telling the parent "NOTHING usable" made it redo the work and
  // overwrite them, so the payload then says what exists and forbids the redo.
  // ONLY a present file the child wrote counts (Codex review, passes 1, 2 and
  // 4): unchanged since (proven by its fingerprint), or written by it without
  // a fingerprint (shell, CLI harness, office tools), which the parent must
  // re-read. One absent, changed since, never written by the child, or in an
  // unknown state is not work to build on, and saying it is would make the
  // parent deliver nothing, or someone else's file.
  //
  // The moves themselves, and their order, live in failed-delegation.ts
  // (#510), which also says what the child left.
  const fichiersDeLEnfant = filesTheChildWrote(outcome.files_written);
  //
  // The whole block — marker and guidance included — fits the one tool-result
  // budget (`fitToolResult`): only the outcome's long text gives way, never the
  // moves the parent must read (Codex review of #712, pass 2).
  const consignes = failedDelegationGuidance(nextFailedState, {
    childLeftFiles: fichiersDeLEnfant.length > 0,
  });
  const errorValue = isFailure
    ? fitToolResult(
        (room) => `${DELEGATION_FAILED_MARKER}
${renderDelegationOutcome(outcome, room)}

${consignes}`,
        (t) => t.length,
      )
    : '';

  const primaryOutput: ToolResultOutput = isFailure
    ? { type: 'error-text', value: errorValue }
    : {
        type: 'text',
        value: fitToolResult(
          (room) => renderDelegationOutcome(outcome, room),
          (t) => t.length,
        ),
      };

  const toolResultParts: Array<{
    type: 'tool-result';
    toolCallId: string;
    toolName: string;
    output: ToolResultOutput;
  }> = [
    {
      type: 'tool-result',
      toolCallId: toolUseId,
      toolName,
      output: primaryOutput,
    },
  ];

  // Append deferred siblings (other assign_* dropped this turn). They share the
  // message-integrity invariant: every tool_use needs a matching tool_result.
  const sideResults = pending.sideToolResults ?? [];
  for (const sr of sideResults) {
    if (!sr.toolName) {
      throw new OrchestrationError(
        'missing_tool_use_id',
        `Side tool_result for ${sr.tool_use_id} has no toolName (legacy row?)`,
      );
    }
    toolResultParts.push({
      type: 'tool-result',
      toolCallId: sr.tool_use_id,
      toolName: sr.toolName,
      output: sr.is_error
        ? { type: 'error-text', value: sr.content }
        : { type: 'text', value: sr.content },
    });
  }

  // 5. Build updated messages array
  const existingMessages = Array.isArray(parent.messages)
    ? (parent.messages as unknown[])
    : (JSON.parse(String(parent.messages ?? '[]')) as unknown[]);

  const updatedMessages = [...existingMessages, { role: 'tool', content: toolResultParts }];

  // 6. Update parent: inject messages, set status → pending, clear pending_delegation,
  // bump chain_count. Each resume from a delegation suspension counts as one
  // self-chain step — invariant 8 caps this at maxChains (15) to prevent runaway
  // orchestrators that delegate forever instead of returning a result.
  const nextChainCount = (parent.chainCount ?? 0) + 1;
  // Conditional on status STILL being 'awaiting_delegation' (B4, audit
  // followup). The read-time check above (step 2) can go stale: the user may
  // cancel the parent in the window between that read and this write. An
  // unconditional UPDATE would resurrect the cancelled parent back to
  // 'pending' and re-trigger it. Guarding the write closes that TOCTOU — cancel
  // wins, 0 rows land, and we return the terminal no-op snapshot exactly like
  // the read-time terminal branch does.
  // agent_jobs-write: delegation-resume — gardée sur `awaiting_delegation`.
  const [updated] = await db
    .update(agentJobs)
    .set({
      messages: updatedMessages,
      status: 'pending',
      pendingDelegation: null,
      chainCount: nextChainCount,
      lastFailedDelegationSlug: nextFailedState.slug,
      lastFailedDelegationStreak: nextFailedState.streak,
      updatedAt: new Date(),
    })
    .where(
      and(eq(agentJobs.id, parentJobId as string), eq(agentJobs.status, 'awaiting_delegation')),
    )
    .returning();

  if (!updated) {
    // Lost the race to a concurrent cancel (or another resume). Re-read: a
    // terminal parent is a legal race (return a no-op snapshot so the caller's
    // executeJob re-entry exits via its own guard); anything else is a real
    // corruption and must fail loud.
    const [current] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJobId as string))
      .limit(1);
    if (current?.status && TERMINAL_PARENT_STATUSES.has(current.status)) {
      return {
        id: parent.id as JobId,
        agentId: parent.agentId as AgentId | null,
        entityId: parent.entityId as EntityId | null,
        status: current.status,
        messages: Array.isArray(parent.messages) ? (parent.messages as unknown[]) : [],
        pendingDelegation: null,
        chainCount: parent.chainCount ?? 0,
        delegationDepth: parent.delegationDepth ?? 0,
        parentJobId: parent.parentJobId as JobId | null,
        task: parent.task,
        channel: parent.channel,
        chatId: parent.chatId,
      };
    }
    throw new OrchestrationError('parent_not_found', `Failed to update parent job ${parentJobId}`);
  }

  return {
    id: updated.id as JobId,
    agentId: updated.agentId as AgentId | null,
    entityId: updated.entityId as EntityId | null,
    status: updated.status ?? 'pending',
    messages: Array.isArray(updated.messages) ? (updated.messages as unknown[]) : [],
    pendingDelegation: null,
    chainCount: updated.chainCount ?? 0,
    delegationDepth: updated.delegationDepth ?? 0,
    parentJobId: updated.parentJobId as JobId | null,
    task: updated.task,
    channel: updated.channel,
    chatId: updated.chatId,
  };
}
