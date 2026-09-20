'use client';

// WorkspacesList — la section WORKSPACES du panneau Work (#258).
//
// ⚠️ CE N'EST PLUS UN DOSSIER. En #230 les espaces de travail se dépliaient
// comme un canal ; la planche v2 en fait les LIGNES MÊMES de la section, sous
// son titre, sans rien à ouvrir. C'est cohérent avec le reste du panneau : les
// canaux sont des endroits d'où des conversations arrivent, et se plient ; un
// espace de travail est un endroit où l'on va, et une section de destinations
// ne se plie pas.
//
// ⚠️ LE POINT N'EST PAS UN ÉTAT DU PROJET. Un projet n'a pas de marqueur de
// lecture : la seule table qui en porte est `conversation_reads`. Le point
// rouge de la planche est donc LU par la chaîne qui existe — un projet a des
// travaux, un travail a une conversation, une conversation a un marqueur — et
// jamais inventé (invariant #4, décision de l'orchestrateur du 19/09 au soir).
// La lecture vit dans `listSidebarProjectsAction`, en une requête groupée et
// bornée aux projets affichés.
//
// ⚠️ « SEE ALL » RESTE, et la planche ne le dessine pas : elle montre cinq
// espaces, c'est-à-dire un cas où il n'y a rien de plus à voir. Il est gardé
// parce que `/spaces` porte plus que la liste — le bouton « New project » et
// sa table — et que sans lui la page ne serait plus atteignable depuis la
// barre. C'est le raisonnement que le propriétaire a retenu pour « Dashboard »
// le 19/09 au soir, appliqué au même cas.

import { useCallback } from 'react';
import { listSidebarProjectsAction } from '@/lib/project-actions.ts';
import SidebarDynamicList from './SidebarDynamicList';

export default function WorkspacesList() {
  // La lecture rend `unread` ; la liste dessine `calls`. La traduction est
  // ici, en un endroit, plutôt que dans le rendu de chaque ligne.
  const lire = useCallback(async (limit: number) => {
    const r = await listSidebarProjectsAction(limit);
    if (!r.ok) return r;
    return {
      ok: true as const,
      data: r.data.map((p) => ({ id: p.id, name: p.name, calls: p.unread })),
    };
  }, []);

  return (
    <SidebarDynamicList
      testId="workspaces"
      read={lire}
      hrefOf={(r) => `/spaces/${r.id}`}
      dot
      empty="No Project Yet"
      seeAll="/spaces"
      seeAllAlways
    />
  );
}
