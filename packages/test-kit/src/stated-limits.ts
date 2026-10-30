// stated-limits.ts — une limite de taille de message ÉCRITE dans un prompt,
// reconnue par sa FORME, jamais par le nombre nu.
//
// Les formes que l'ancien catalogue des canaux écrivait : « 4096 chars »,
// « 4 096 characters », « under_4096_chars », « 4096-char », « ≤4096 ». Un
// prompt porte des identifiants tirés au hasard (UUID, slugs) dont les
// chiffres épellent « 2000 » ou « 4096 » de temps en temps : un
// `includes('4096')` rougissait au hasard (PR #681, puis le CI de #877 sur
// `execute.test.ts`). Une seule définition, pour tous les tests de prompt.

/** Les limites de taille énoncées dans `prompt` ; vide quand aucune ne l'est. */
export function statedLimits(prompt: string): string[] {
  return (
    prompt.match(/(?:≤\s*)?\d[\d   ,.]*[\s_-]*(?:chars?|characters?|caractères)\b|≤\s*\d+/gi) ?? []
  );
}
