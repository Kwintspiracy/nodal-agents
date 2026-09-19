// /code — la liste a DISPARU, la route mène à Workspaces (#143).
//
// Deux pages listaient des projets avec un dossier et une preuve : celle-ci
// dérivait les siens des sessions de code, `/spaces` déclarait les siens. La
// différence était l'origine, et elle n'intéresse personne au moment de
// chercher son projet — elle est devenue un attribut de la ligne.
//
// Ce que cette page portait n'est PAS perdu : la DÉTECTION des dossiers où un
// agent a écrit alimente les lignes « Detected » de Workspaces, avec les deux
// gestes qu'elle avait (Register, Hide) ; le PANNEAU DE PREUVE d'un projet vit
// sur l'onglet « Files & proof » du projet ; les SESSIONS d'un projet sont dans
// son onglet Activity.
//
// La route reste et REDIRIGE plutôt que de rendre 404 : elle est dans des
// favoris et dans des liens déjà envoyés. `/code/[id]`, la page d'un run de
// code, ne bouge pas — c'est elle que les lignes de session ouvrent.

import { redirect } from 'next/navigation';

export default function CodePage(): never {
  redirect('/spaces');
}
