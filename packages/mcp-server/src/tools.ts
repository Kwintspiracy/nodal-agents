// tools.ts — ce que ce serveur expose : `run_task`, la seule porte qui ÉCRIT,
// et `get_task`, qui relit un job que cette porte a créé (#887).
//
// La première version exposait directement `create_task` / `list_tasks` /
// `assign_*`, et la review l'a démontée en six constats avec une seule racine :
// ces outils tirent leur autorité du JOB qui les appelle. Les servir hors d'un
// job supprimait tout — la cohérence agent/entité, la hiérarchie, les
// approbations, l'audit, l'ancrage des tâches, les compteurs anti-boucle.
//
// Nodal avait déjà résolu exactement ce problème : la surface CHAT. Un tour de
// chat n'est pas un job, donc il n'a qu'un outil, `run_task`, qui crée un VRAI
// job — et c'est ce job qui exécute, avec sa boucle, ses gardes et son audit.
// Ce serveur applique le même contrat : un client MCP est une surface sans job,
// il reçoit la même porte d'entrée que le chat, pas les outils internes.
//
// `get_task` n'y fait pas exception : il n'écrit rien et n'accorde rien. Il
// relit un job de CE workspace créé sur le canal `mcp` — la réponse que
// l'appelant de `run_task` attendait et qui ne lui revenait jamais (#887).

import { z } from 'zod';
import { AgentSlugSchema } from '@nodal-agents/shared';

export const runTaskInputSchema = z.object({
  // LE contrat partage du slug (shared/agent-slug.ts) — la review a montre
  // que trois definitions divergentes rendaient un agent valide inciblable.
  agent: AgentSlugSchema.optional().describe(
    'Optional TARGET agent, by slug, resolved INSIDE this workspace only. ' +
      'Omit to address the workspace root agent. Choosing a target is the ' +
      'same power as choosing which chat to type in — the job runs under ' +
      "THAT agent's tools, approval rules and budgets, and MCP jobs never " +
      'get the configuration tools regardless of target.',
  ),
  // Une ASSERTION, jamais un choix (#769). La v1 laissait l'appelant fournir
  // l'entité du job, et la review l'a retiré (usurpation inter-workspace) :
  // l'entité vient de l'agent du serveur, et de lui seul. Ce champ ne déplace
  // rien : il ne peut que REFUSER, avant toute écriture, quand le serveur parle
  // pour un autre espace que celui que l'appelant attend. C'est la prévention
  // dont un appelant a besoin quand son épinglage peut casser (le banc des
  // workflows : un essai ne doit jamais être créé hors de l'espace banc).
  expectedWorkspaceId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Optional ASSERTION, never a choice: the id of the workspace the job must be ' +
        'created in. When this server speaks for another workspace, run_task refuses ' +
        'before creating anything (mcp_workspace_mismatch). It cannot move a job: the ' +
        'workspace is always the one of the agent this server was launched for.',
    ),
  caller: z
    .string()
    .min(1)
    .max(120)
    // Une etiquette est un IDENTIFIANT, pas du texte libre. Sans cette regex,
    // le champ acceptait retours a la ligne et Markdown, et il est interpole
    // dans le bloc Runtime — donc dans le MESSAGE SYSTEME du job. Un client
    // pouvait y ecrire une fausse section « instructions operateur » qui
    // obtenait la priorite d un message systeme (constat passe 5). Refuser a
    // l entree vaut mieux qu assainir au rendu : l erreur est nette, et aucun
    // rendu futur ne peut reintroduire le trou en oubliant l assainissement.
    .regex(/^[\w .:@/-]+$/, 'caller must be a plain label (letters, digits, spaces, .:@/-_ only)')
    .optional()
    .describe(
      'Optional label naming WHO is asking (e.g. "agent-dev-a", "quentin-terminal"). ' +
        'Purely declarative — recorded as provenance on the job, shown on the Runs ' +
        'page, and NEVER used for authorization: the job runs under the rules of the ' +
        'agent this server was launched for, whatever this says.',
    ),
  instruction: z
    .string()
    .min(1)
    .max(16_000)
    .describe(
      "La demande, en clair et auto-suffisante : l'agent qui l'exécute ne voit " +
        'RIEN de cette session MCP. Il travaille avec ses propres outils, ' +
        'skills et sous-agents, sous ses propres règles d approbation.',
    ),
});

export type RunTaskInput = z.infer<typeof runTaskInputSchema>;

/**
 * Description montrée au client MCP. Réutilise le vocabulaire de la surface
 * chat : ce que l'appel fait vraiment — créer un job traçable — plutôt qu'une
 * promesse d'exécution immédiate.
 */
export const RUN_TASK_DESCRIPTION =
  'Hand a request to this Nodal agent. Creates a TRACKED JOB the agent runs ' +
  'with its full toolset — connectors, skills, delegation to its team — under ' +
  'its own approval rules and budgets. Returns the job id immediately; the ' +
  'work itself runs asynchronously. To get the answer, call `get_task` with ' +
  'that jobId (optionally with waitSeconds to wait for it). State the ' +
  'request faithfully and self-contained: the agent sees nothing of this ' +
  'MCP session.';

/** L'attente la plus longue qu'un appel `get_task` peut demander, en secondes. */
export const GET_TASK_MAX_WAIT_SECONDS = 60;

export const getTaskInputSchema = z.object({
  jobId: z
    .string()
    .uuid()
    .describe('The jobId that run_task returned. Only jobs this MCP server created can be read.'),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(GET_TASK_MAX_WAIT_SECONDS)
    .optional()
    .describe(
      `Optional, 0 to ${GET_TASK_MAX_WAIT_SECONDS}. Wait up to this many seconds for the job ` +
        'to finish or to need a person, and return as soon as it does. Omit or 0 to read ' +
        'the current state at once.',
    ),
});

export type GetTaskInput = z.infer<typeof getTaskInputSchema>;

/**
 * Ce que `get_task` rend, dit au client. Le statut est celui du RUN — la tête
 * et tout ce qu'elle a délégué — pas celui d'une ligne : une tête qui attend
 * un délégué est `running`.
 */
export const GET_TASK_DESCRIPTION =
  'Read back a job that run_task created on this server: its status, the agent’s ' +
  'result, its deliverables, and anything waiting for a person. Read-only. ' +
  'status is the state of the whole run, delegated work included: running, ' +
  'waiting_for_person (an approval or a question to answer on the Nodal dashboard; ' +
  'see waitingForPerson), completed, failed or cancelled. result is the agent’s own ' +
  'answer, set once the run is over. Pass waitSeconds to wait for the run to finish ' +
  'or to need a person instead of polling.';
