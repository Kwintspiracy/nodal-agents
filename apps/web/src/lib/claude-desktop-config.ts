// claude-desktop-config.ts — poser l'entrée de Nodal dans la configuration de
// Claude Desktop (#485), sur la machine qui héberge Nodal.
//
// Trois règles, toutes pour ne rien perdre de ce que la personne y avait :
//   - le dossier de Claude Desktop doit exister : sans lui, Claude Desktop
//     n'est pas installé ici, et on le dit au lieu de créer une arborescence ;
//   - un fichier existant est COPIÉ avant d'être réécrit, et ses autres
//     serveurs et clés sont gardés tels quels (`withNodalEntry`) ;
//   - un fichier illisible n'est jamais écrasé : l'erreur remonte.

import 'server-only';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withNodalEntry, type DesktopServerEntry } from './mcp-clients.ts';

export type DesktopWriteResult = {
  path: string;
  /** La copie de l'ancien fichier ; `null` quand il n'existait pas. */
  backupPath: string | null;
  /** Une entrée `nodal` existait déjà et a été remplacée. */
  replaced: boolean;
};

export class DesktopNotInstalledError extends Error {
  constructor(readonly dir: string) {
    super(`Claude Desktop was not found on this machine (no folder at ${dir})`);
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeNodalIntoClaudeDesktop(
  path: string,
  entry: DesktopServerEntry,
  now: Date,
): Promise<DesktopWriteResult> {
  const dir = dirname(path);
  const dirStat = await stat(dir).catch(() => null);
  if (dirStat === null || !dirStat.isDirectory()) throw new DesktopNotInstalledError(dir);

  const existing = await readIfExists(path);
  // Calculé AVANT toute écriture : un fichier illisible s'arrête ici, intact.
  const { text, replaced } = withNodalEntry(existing, entry);

  let backupPath: string | null = null;
  if (existing !== null) {
    backupPath = `${path}.${now.toISOString().replace(/[:.]/g, '-')}.bak`;
    await copyFile(path, backupPath);
  }
  await writeFile(path, text, 'utf8');
  return { path, backupPath, replaced };
}
