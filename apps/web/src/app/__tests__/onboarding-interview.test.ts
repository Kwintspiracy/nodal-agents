// onboarding-interview.test.ts — l'entretien d'accueil : ce qu'il demande, et où
// chaque réponse est rangée (#986).
//
// Il ne demande plus de langue (décision de Quentin, 04/11/2026 : l'agent répond
// dans la langue qu'on lui parle, rien d'autre). Retirer une question décale
// toutes les suivantes : la réponse N doit toujours tomber dans la mémoire N, et
// la dernière toujours régler l'autonomie.

import { describe, it, expect } from 'vitest';
import {
  AUTONOMY_ANSWER_INDEX,
  DONE_MARKER,
  INTERVIEW_KICKOFF,
  INTERVIEW_MEMORY,
  interviewMemoryFor,
} from '../onboarding/interview.ts';

/** Les questions numérotées de la consigne, dans l'ordre. */
const questions = (): string[] =>
  INTERVIEW_KICKOFF.split('\n')
    .filter((l) => /^\d+\. /.test(l))
    .map((l) => l.replace(/^\d+\. /, ''));

describe('l’entretien d’accueil @cap:installer-et-demarrer/ecran', () => {
  it('ne demande plus de langue, et ne range aucune langue préférée', () => {
    expect(INTERVIEW_KICKOFF).not.toMatch(/language/i);
    expect(INTERVIEW_MEMORY.map((m) => m.prefix)).not.toContain('Operator — preferred language:');
    expect(INTERVIEW_MEMORY.some((m) => /language/i.test(m.prefix))).toBe(false);
  });

  it('autant de questions que de mémoires, numérotées 1 à N, et le compte dit en toutes lettres', () => {
    expect(questions()).toHaveLength(INTERVIEW_MEMORY.length);
    const numbers = INTERVIEW_KICKOFF.split('\n')
      .filter((l) => /^\d+\. /.test(l))
      .map((l) => Number(l.split('.')[0]));
    expect(numbers).toEqual([1, 2, 3, 4]);
    expect(INTERVIEW_KICKOFF).toContain('Ask these FOUR things');
    expect(INTERVIEW_KICKOFF).toContain('After the FOURTH answer');
    expect(INTERVIEW_KICKOFF).toContain(DONE_MARKER);
  });

  it('chaque réponse tombe dans la mémoire de SA question', () => {
    // Index = nombre de réponses déjà données.
    expect(interviewMemoryFor(0, 'Quentin')).toEqual({
      fact: 'Operator — what to call them: Quentin',
      category: 'context',
    });
    expect(interviewMemoryFor(1, 'Singapore')).toEqual({
      fact: 'Operator — where they are based: Singapore',
      category: 'context',
    });
    expect(interviewMemoryFor(2, 'Research and decks')).toEqual({
      fact: 'Operator — goal with Nodal-Agents / where they want help: Research and decks',
      category: 'context',
    });
    expect(interviewMemoryFor(3, 'take initiative')).toEqual({
      fact: 'How the operator wants to work together: take initiative',
      category: 'preference',
    });
    expect(interviewMemoryFor(4, 'extra')).toBeNull();
    // Les questions et les mémoires parlent de la même chose, dans le même ordre.
    const q = questions();
    expect(q[0]).toMatch(/call them/);
    expect(q[1]).toMatch(/based/);
    expect(q[2]).toMatch(/goal/);
    expect(q[3]).toMatch(/on your own|approval/);
  });

  it('la dernière réponse, celle de l’autonomie, est celle de la question d’autonomie', () => {
    expect(AUTONOMY_ANSWER_INDEX).toBe(3);
    expect(questions()[AUTONOMY_ANSWER_INDEX]).toMatch(/approval before acting/);
    expect(INTERVIEW_MEMORY[AUTONOMY_ANSWER_INDEX]?.prefix).toBe(
      'How the operator wants to work together:',
    );
  });
});
