// project-header.test.ts — LA PHRASE sous le nom d'un projet ouvert (#143).
//
// Ce qu'elle doit tenir : rien d'absent ne se dessine. Un projet neuf n'écrit
// pas « 0 conversations », un dossier sans `.git` n'écrit pas « not a git
// repository », un projet sans responsable n'écrit pas « — ».

import { describe, it, expect } from 'vitest';
import { projectFactsLine } from '../project-header.ts';
import type { ProjectFacts } from '@/lib/project-actions.ts';

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  id: 'p-1',
  name: 'nodal-agents',
  path: 'D:/APPS/NodalAI',
  kind: 'code',
  agentName: 'Lead Dev',
  agentAvatarUrl: null,
  isGitRepository: true,
  conversations: 12,
  sessions: 41,
  sessionsWithoutConversation: 3,
  ...over,
});

describe('projectFactsLine @cap:travailler-sur-des-fichiers/ecran', () => {
  it('dit l’agent, le dossier, le dépôt et les deux comptes', () => {
    expect(projectFactsLine(facts())).toBe(
      'Lead Dev · D:/APPS/NodalAI · git repository · 12 conversations · 41 sessions',
    );
  });

  it('un dossier qui n’est PAS un dépôt ne le dit pas — il se tait', () => {
    const ligne = projectFactsLine(facts({ isGitRepository: false }));
    expect(ligne).not.toContain('git');
    expect(ligne).toBe('Lead Dev · D:/APPS/NodalAI · 12 conversations · 41 sessions');
  });

  it('un projet NEUF ne compte pas jusqu’à zéro', () => {
    const ligne = projectFactsLine(
      facts({ conversations: 0, sessions: 0, isGitRepository: false }),
    );
    expect(ligne).toBe('Lead Dev · D:/APPS/NodalAI');
  });

  it('sans responsable, aucun tiret ne prend sa place — le dossier ouvre la phrase', () => {
    const ligne = projectFactsLine(facts({ agentName: null }));
    expect(ligne.startsWith('D:/APPS/NodalAI')).toBe(true);
    expect(ligne).not.toContain('—');
  });

  it('le singulier ne s’écrit jamais au pluriel', () => {
    expect(projectFactsLine(facts({ conversations: 1, sessions: 1 }))).toContain(
      '1 conversation · 1 session',
    );
  });
});
