import { redirect } from 'next/navigation';

/**
 * La liste des runs a quitté cette adresse (#134).
 *
 * Activity (`/logs`) EST la liste des runs : une ligne repliée par run,
 * dépliable sur ses appels. Trois écrans racontaient « ce qu'un run a fait »,
 * chacun à sa façon ; il n'en reste qu'un. Un run garde son adresse
 * (`/jobs/<id>`, la page voisine) : on y arrive depuis une réponse du chat,
 * une alerte ou la ligne d'un tableau, jamais depuis un menu.
 *
 * Cette route reste pour les liens déjà écrits : conversations, signets,
 * notifications.
 */
export default function JobsPage(): never {
  redirect('/logs');
}
