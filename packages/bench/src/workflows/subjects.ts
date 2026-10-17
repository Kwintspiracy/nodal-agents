// workflows/subjects.ts — les sujets de recherche calibrés, lus dans un fichier.
//
// Décision 3 du 17/10 : un sujet de recherche n'est accepté que si chaque
// modèle comparé, interrogé SANS outil, se trompe ou refuse au moins 2 fois sur
// 3. Un fait que tout modèle connaît de mémoire teste « donne tes sources », pas
// la recherche (penicilline, transistor, Apollo 11 : les sujets d'avant).
//
// Le sujet n'est donc jamais écrit dans un scénario : un scénario qui déclare
// `subject` lit le premier sujet calibré de son genre dans SUBJECTS_FILE. Tant
// qu'il n'y en a aucun, l'essai est SAUTÉ avec sa raison et le ticket (#776),
// comme un besoin absent. Il n'existe pas de sujet par défaut.
//
// La calibration elle-même (interroger les modèles) vient avec l'agent juge
// (#776) : elle demande d'appeler des modèles. Ce module ne fait que lire, et
// refuse un sujet dont le fichier ne prouve pas la calibration.

import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { matches, type ExpectedFact } from './judge-kit';
import { SUBJECTS_FILE } from './paths';

/** `research` : un fait, cherché par la racine seule. `deep-research` : un sujet, confié au spécialiste. */
export const SUBJECT_KINDS = ['research', 'deep-research'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export { SUBJECTS_FILE };
export const SUBJECTS_TICKET = '#776';

/** La raison du saut, quand aucun sujet calibré de ce genre n'existe. */
export function noSubjectReason(kind: SubjectKind): string {
  return `no calibrated research subject (kind ${kind}) in packages/bench/subjects/research-subjects.json: the trial does not run on a subject models know from memory (${SUBJECTS_TICKET})`;
}

/** Au moins 2 réponses fausses ou refusées sur 3 questions, pour chaque modèle. */
const MIN_ASKED = 3;
const MIN_WRONG_RATIO = 2 / 3;

const FactSchema = z.object({
  /** Ce que le rouge dira s'il manque : « name X », « give 1953 ». */
  says: z.string().min(1),
  pattern: z.string().min(1),
  flags: z
    .string()
    .regex(/^[imsu]*$/)
    .default(''),
});

const SubjectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(SUBJECT_KINDS),
  /** Le sujet, tel qu'il entre dans la demande française (`{subject}`). */
  request: z.string().min(10),
  facts: z.array(FactSchema).min(1),
  /** Ce que chaque modèle comparé a répondu sans outil : combien de questions, combien fausses ou refusées. */
  calibration: z
    .array(
      z.object({
        model: z.string().min(1),
        asked: z.number().int(),
        wrong: z.number().int(),
      }),
    )
    .min(1),
});
const FileSchema = z.object({ subjects: z.array(SubjectSchema) });

/** Un fait attendu, tel que le fichier l'écrit : sérialisable (une observation le garde tel quel). */
export interface SubjectFact {
  readonly says: string;
  readonly pattern: string;
  readonly flags: string;
}

export interface ResearchSubject {
  readonly id: string;
  readonly kind: SubjectKind;
  readonly request: string;
  readonly facts: readonly SubjectFact[];
  /** Les modèles sur lesquels le sujet est calibré. */
  readonly calibratedOn: readonly string[];
}

/** Les faits d'un sujet, prêts pour `missingFacts` (le motif a été compilé à la lecture). */
export function subjectFacts(subject: Pick<ResearchSubject, 'facts'>): ExpectedFact[] {
  return subject.facts.map((f) => matches(new RegExp(f.pattern, f.flags), f.says));
}

/**
 * Le sujet qu'un scénario à sujet reçoit pour l'observer. runTrial ne joue
 * jamais un tel scénario sans sujet (il le saute avant) : son absence ici est
 * une erreur du banc, dite.
 */
export function subjectOf(env: { readonly subject?: ResearchSubject }): ResearchSubject {
  if (!env.subject)
    throw new Error(
      'workflow_no_subject: a subject scenario was observed without its calibrated subject',
    );
  return env.subject;
}

/**
 * Lit les sujets calibrés. Un fichier absent : aucun sujet (les essais de
 * recherche sont sautés, et le disent). Un fichier mal formé, un motif qui ne
 * compile pas, ou un sujet dont la calibration ne tient pas la règle : une
 * erreur, jamais un sujet accepté en silence.
 */
export function readResearchSubjects(file: string = SUBJECTS_FILE): ResearchSubject[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(
      `workflow_subjects_unreadable: ${file} is not JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `workflow_subjects_unreadable: ${file} does not have the subjects shape (${parsed.error.message})`,
    );
  }
  return parsed.data.subjects.map((s) => {
    const weak = s.calibration.filter(
      (c) => c.asked < MIN_ASKED || c.wrong < c.asked * MIN_WRONG_RATIO,
    );
    if (weak.length > 0) {
      throw new Error(
        `workflow_subject_not_calibrated: ${s.id} is answered from memory too often (${weak.map((c) => `${c.model} wrong ${c.wrong}/${c.asked}`).join(', ')}); a subject needs at least 2 wrong answers out of 3 for every model`,
      );
    }
    return {
      id: s.id,
      kind: s.kind,
      request: s.request,
      facts: s.facts.map((f) => {
        try {
          new RegExp(f.pattern, f.flags);
        } catch (e) {
          throw new Error(
            `workflow_subjects_unreadable: subject ${s.id}, pattern ${JSON.stringify(f.pattern)} does not compile (${e instanceof Error ? e.message : String(e)})`,
          );
        }
        return { says: f.says, pattern: f.pattern, flags: f.flags };
      }),
      calibratedOn: s.calibration.map((c) => c.model),
    };
  });
}

/** Le premier sujet calibré de ce genre, ou null. */
export function pickSubject(
  kind: SubjectKind,
  subjects: readonly ResearchSubject[],
): ResearchSubject | null {
  return subjects.find((s) => s.kind === kind) ?? null;
}

export const SUBJECT_SLOT = '{subject}';

/** La demande d'un scénario à sujet, son sujet posé à la place de `{subject}`. */
export function requestWithSubject(template: string, subject: ResearchSubject): string {
  if (!template.includes(SUBJECT_SLOT)) {
    throw new Error(
      `workflow_subject_slot_missing: the request has no ${SUBJECT_SLOT} to hold the calibrated subject`,
    );
  }
  return template.split(SUBJECT_SLOT).join(subject.request);
}
