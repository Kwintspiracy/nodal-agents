/**
 * Combien de jobs MCP d'un workspace peuvent tourner en même temps (#498).
 *
 * UNE valeur, lue par le serveur MCP (qui l'applique, dans la transaction qui
 * insère le job) et par la carte Settings (qui la dit) : un nombre recopié
 * dans le texte d'un écran finit par dire autre chose que ce que le serveur
 * fait (#480, la carte taisait le plafond, puis l'aurait dit faux).
 */
export const MCP_MAX_JOBS_IN_FLIGHT = 5;
