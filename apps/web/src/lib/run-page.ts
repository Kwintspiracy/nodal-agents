// run-page.ts — L'ADRESSE DE LA PAGE D'UN RUN (#472, #501).
//
// LA RÈGLE (#501) : un run s'ouvre dans la section à laquelle il APPARTIENT,
// jamais dans celle que l'adresse d'un lien écrit à la main désignait. Le rail
// lit sa section de l'adresse seule (`sidebar-nav.ts`), et il le fait exprès :
// « la dernière section visitée » ferait deux écrans pour une même adresse.
// L'adresse d'un run se décide donc sur le run, ici, en un seul endroit :
//
//   - un run né d'une AUTOMATISATION (cron ou webhook), ou délégué par un tel
//     run, appartient à Scheduled : `/jobs/<id>` ;
//   - tout autre run (une conversation, un canal, le serveur MCP, une tâche
//     envoyée depuis Runs) appartient à Work : `/chat/runs/<id>`.
//
// Un écran qui ouvre un run sans savoir d'où il vient (la cloche, une
// approbation, la liste des runs, la table Runs) pointe `openRunHref(id)`,
// `/runs/<id>` : cette route lit la tête de la chaîne du run et REDIRIGE vers
// son adresse. Elle ne dessine rien. Ouvrir un run depuis la cloche basculait
// la barre sur Scheduled, quel que soit le run (#501).
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

/** Les deux sections du rail où la page d'un run peut vivre. */
export type RunSection = 'work' | 'scheduled';

/**
 * Ce qu'il faut savoir de la TÊTE de la chaîne d'un run pour le ranger : le
 * type de son déclencheur (`agent_jobs.trigger_context->>'type'`) et son
 * automatisation (`agent_jobs.schedule_id`). Un délégué n'a pas de
 * déclencheur à lui (le runner ne le recopie pas) : c'est la tête qui dit
 * d'où vient le travail.
 */
export type RunRootOrigin = { triggerType: string | null; scheduleId: string | null };

/** Les déclencheurs qu'on PROGRAMME, ceux que le panneau Scheduled liste. */
const SCHEDULED_TRIGGERS: ReadonlySet<string> = new Set(['cron', 'webhook']);

/** La section d'un run, lue sur la tête de sa chaîne. */
export function runSectionOf(root: RunRootOrigin): RunSection {
  if (root.scheduleId !== null && root.scheduleId !== '') return 'scheduled';
  return root.triggerType !== null && SCHEDULED_TRIGGERS.has(root.triggerType)
    ? 'scheduled'
    : 'work';
}

/** L'adresse de la page d'un run dans sa section. */
export function runHrefIn(section: RunSection, runId: string): string {
  return section === 'work' ? runPageHref(runId) : `/jobs/${runId}`;
}

/**
 * OÙ SE RÉPOND UNE QUESTION (#465) : le fil de sa conversation, ou la page du
 * run qui l'a posée quand il n'y a pas de conversation (une automatisation).
 * La carte Approvals et la cloche renvoient toutes deux ici.
 */
export function questionHref(q: { conversationId: string | null; jobId: string }): string {
  const conversation = conversationOf(q.conversationId);
  return conversation !== null ? `/chat/${conversation}` : openRunHref(q.jobId);
}

/**
 * La conversation d'une ligne, ou null quand elle n'en a pas : `null` ET la
 * chaîne vide, qu'aucun fil ne porte. Une seule règle pour la cloche, la carte
 * Approvals et la liste des conversations (revue de #622) : un id vide ne se
 * pose sur aucune ligne, et `/chat/` n'est l'adresse de rien.
 */
export function conversationOf(id: string | null): string | null {
  return id === null || id === '' ? null : id;
}

export const OPEN_RUN_PREFIX = '/runs/';

/**
 * Ouvrir un run depuis un écran qui ne sait pas d'où il vient : la route
 * `/runs/<id>` redirige vers la section du run.
 */
export function openRunHref(runId: string): string {
  return `${OPEN_RUN_PREFIX}${runId}`;
}
