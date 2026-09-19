import { permanentRedirect } from 'next/navigation';

/**
 * La page Scheduled n'existe plus (Quentin, 19/09/2026, #202).
 *
 * Elle listait les runs groupés par automatisation. Chaque automatisation
 * montre désormais les SIENS sur sa propre page, et la liste des
 * automatisations est la porte unique : deux endroits pour la même chose
 * obligeaient à choisir sans rien pour choisir, et le retour d'une page de run
 * déposait le lecteur sur un écran retiré du menu.
 *
 * La route reste, et REDIRIGE : elle est dans des favoris et dans des liens
 * déjà envoyés. Une redirection permanente, parce que ce déménagement est
 * définitif — rien ne reviendra vivre ici.
 *
 * Les pages de run gardent leur adresse (`/scheduled/<id>`, le dossier voisin) :
 * ce sont elles que les notifications et les fils pointent.
 */
export default function ScheduledPage(): never {
  permanentRedirect('/automations');
}
