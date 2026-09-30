// workflows/redact.ts — ce qui ne part pas dans un dépôt public.

import { homedir } from 'node:os';

/**
 * Une fixture part dans un dépôt public : le dossier personnel de la machine
 * (et donc le nom de son utilisateur) y devient `~`, sous toutes ses écritures
 * — barres obliques ou inverses, simples ou échappées une ou deux fois en JSON.
 */
export function redactHome(text: string, home: string = homedir()): string {
  const parts = home.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return text;
  const pattern = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:\\\\+|/)');
  return text.replace(new RegExp(`${home.startsWith('/') ? '/' : ''}${pattern}`, 'gi'), '~');
}
