// run-budget.ts — les bornes du budget de run et de l'attente du premier jeton
// (issue #442, migration 0126).
//
// Les MÊMES nombres que les CHECK de la migration : un formulaire qui accepterait
// davantage se ferait refuser par la base avec un message que personne ne
// comprend. Ici, et pas dans `actions.ts` : un fichier 'use server' n'exporte
// que des fonctions, et l'écran en a besoin aussi.

/** `entities.max_run_cost_usd` : 0 (aucun plafond) à 1000 $. */
export const RUN_COST_MAX_USD = 1000;
/** `entities.max_run_hours` : 0 (aucune limite) à 72 h. */
export const RUN_HOURS_MAX = 72;
/**
 * Le temps de travail d'une session de CLI de code (Claude Code, Codex) quand
 * l'espace règle `max_run_hours` à 0. La boucle de Nodal reste bornée sans lui
 * par ce qu'elle compte (tours, jetons, coût) ; une session de CLI garde sa
 * boucle et ne rapporte rien avant la fin, donc elle reçoit cette borne-ci.
 * Écrite sous le réglage (RunBudgetSection) et lue par le runner
 * (`cliSessionTimeLimitMs`) : un seul nombre, aux deux endroits.
 */
export const CLI_SESSION_HOURS_WITHOUT_TIME_LIMIT = 2;
/** `agents.idle_timeout_seconds` : 30 s à 1 h, ou NULL (la plateforme décide). */
export const FIRST_TOKEN_WAIT_MIN_S = 30;
export const FIRST_TOKEN_WAIT_MAX_S = 3600;

/** Le budget d'un agent (issue #447, migration 0127) : 0 = aucun plafond. */
export const AGENT_BUDGET_DAILY_MAX_USD = 1000;
export const AGENT_BUDGET_MONTHLY_MAX_USD = 10000;
/** À partir de quelle part d'un plafond l'écran prévient. */
export const AGENT_BUDGET_ALERT_MIN_PCT = 1;
export const AGENT_BUDGET_ALERT_MAX_PCT = 100;
