// personality-tools.ts — une personnalité qui NOMME un outil que l'agent n'a
// pas, dite au démarrage du job plutôt que laissée à l'improvisation.
//
// Issue #62. Dev C portait dans sa personnalité « tu fais le travail de code
// demandé via `code_task` » — et `code_task` n'était pas dans sa liste
// d'outils, la skill qui le débloque ne lui étant pas assignée. L'agent a
// improvisé avec `file_write`, et bien improvisé. Personne n'aurait jamais su.
//
// La doctrine (10/09) : la personnalité dit ce que l'agent EST et ce qu'il
// reçoit ; les outils et les skills disent COMMENT. Un outil sélectionné
// s'ajoute au prompt tout seul et s'en retire tout seul. Quand la personnalité
// contredit la liste calculée, c'est un désaccord entre deux couches — et un
// désaccord se DIT (invariant #4), il ne se devine pas.
//
// Ce module ne juge que des FAITS : les noms d'outils que le registre connaît,
// ceux que la liste du job contient, ceux que le texte cite. Aucune
// interprétation du sens de la phrase.

/**
 * Les outils connus du registre que la personnalité cite et que la liste du
 * job ne contient pas — triés, sans doublon.
 *
 * Un nom compte s'il apparaît comme un MOT entier (bordé par autre chose
 * qu'une lettre, un chiffre ou `_`) : `file_write` dans « via file_write » ou
 * « `file_write` », jamais `file_write_all`. Seuls les noms du registre sont
 * cherchés — le texte peut parler de « write » ou de « code » sans nommer un
 * outil.
 */
export function toolsNamedButAbsent(input: {
  readonly personality: string | null | undefined;
  /** Les noms de la liste calculée pour CE job (invariant #9). */
  readonly available: readonly string[];
  /** Tous les noms que le registre connaît. */
  readonly known: readonly string[];
}): string[] {
  const text = input.personality ?? '';
  if (text.trim() === '') return [];
  const available = new Set(input.available);
  const out = new Set<string>();
  for (const name of input.known) {
    if (available.has(name) || out.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text)) out.add(name);
  }
  return [...out].sort();
}
