// project-header.ts — LA PHRASE sous le nom d'un projet ouvert (#143).
//
// « Lead Dev · D:/APPS/NodalAI · git repository · 12 conversations · 41
// sessions ». Cinq faits, et QUE des faits que la page tient : l'agent
// responsable, le dossier, la présence de `.git` lue sur le disque, et les deux
// comptes.
//
// Pure, et extraite pour ça : ce qu'un en-tête AFFIRME se prouve sans monter un
// navigateur, et rien ici ne doit se dessiner quand la donnée manque
// (invariant #4) — pas de « — » à la place d'un agent inconnu, pas de
// « 0 conversations » sur un projet neuf.

import type { ProjectFacts } from '@/lib/project-actions.ts';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function projectFactsLine(facts: ProjectFacts): string {
  const parts: string[] = [];
  if (facts.agentName) parts.push(facts.agentName);
  parts.push(facts.path);
  // Un DÉPÔT se dit : c'est ce qui décide si une preuve peut constater un
  // changement, et le savoir change ce qu'on attend du projet.
  if (facts.isGitRepository) parts.push('git repository');
  if (facts.conversations > 0) {
    parts.push(plural(facts.conversations, 'conversation', 'conversations'));
  }
  if (facts.sessions > 0) parts.push(plural(facts.sessions, 'session', 'sessions'));
  return parts.join(' · ');
}
