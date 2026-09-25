// run-page.ts — L'ADRESSE DE LA PAGE D'UN RUN OUVERT DEPUIS WORK (#472).
//
// Un run venu de dehors (dossier MCP) s'ouvre sous `/chat`, pour que la barre
// latérale reste sur Work. `/chat` porte aussi les fils de conversation
// (`/chat/<id>`) : cette adresse se construit et se reconnaît donc ICI, en un
// seul endroit. Le menu d'un fil (Rename, Delete) se posait sur toute adresse
// commençant par `/chat/`, et les runs l'avaient gagné avec un identifiant
// `runs/<id>` qu'aucune action n'accepte (revue de la PR #500).

export const RUN_PAGE_PREFIX = '/chat/runs/';

/** La page d'un run, sous Work. */
export function runPageHref(runId: string): string {
  return `${RUN_PAGE_PREFIX}${runId}`;
}

/**
 * L'identifiant de conversation d'une adresse de fil (`/chat/<id>`), ou null
 * pour toute autre adresse, la page d'un run comprise.
 */
export function conversationIdOfHref(href: string): string | null {
  if (!href.startsWith('/chat/') || href.startsWith(RUN_PAGE_PREFIX)) return null;
  const id = href.slice('/chat/'.length);
  return id !== '' && !id.includes('/') ? id : null;
}
