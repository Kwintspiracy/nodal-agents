// /chat/runs/[id] — la page d'un run venu de DEHORS (dossier MCP), ouverte depuis Work.
//
// La même page que /jobs/[id], à une autre adresse. Pourquoi : le rail déduit
// sa section de l'adresse seule (sidebar-nav.ts), et `/jobs` appartient à
// « Scheduled ». Ouvrir un run depuis le dossier MCP de Work basculait donc la
// barre latérale sur Scheduled (Quentin, 24/09 : « mauvais et particulièrement
// irritant »). Sous `/chat`, l'adresse est celle de Work, et la barre reste où
// la personne était. Aucune copie de la page : c'est la même, réexportée.

export { default } from '../../../jobs/[id]/page.tsx';

// La configuration de route se lit dans CE fichier, jamais par réexport :
// Next l'analyse statiquement.
export const dynamic = 'force-dynamic';
