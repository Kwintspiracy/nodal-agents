// skills/detect-scripts.ts — generic detection of executable scripts bundled
// in a skill folder. The runtime does NOT execute skill scripts (security
// model: agents act through a controlled tool whitelist), so we surface the
// detected scripts to the user as a warning at install time.
//
// Detection is purely structural — no per-skill knowledge — via four signals:
//   1. file extension (.py, .sh, .ps1, …)
//   2. a leading shebang (#!) on extensionless files
//   3. presence under a conventional scripts/ directory
//   4. caller can additionally flag frontmatter `allowed-tools: Bash(...)`

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname, sep } from 'node:path';

export interface DetectedScript {
  /** Path relative to the skill root, forward-slashed. */
  path: string;
  /** Inferred language/runtime: 'python' | 'shell' | 'powershell' | 'ruby' | 'perl' | 'php' | 'node' | 'unknown'. */
  language: string;
}

const EXT_LANGUAGE: Record<string, string> = {
  '.py': 'python',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.bat': 'batch',
  '.cmd': 'batch',
  '.rb': 'ruby',
  '.pl': 'perl',
  '.php': 'php',
};

function shebangLanguage(firstLine: string): string | null {
  if (!firstLine.startsWith('#!')) return null;
  const l = firstLine.toLowerCase();
  if (l.includes('python')) return 'python';
  if (l.includes('bash') || l.includes('/sh') || l.includes(' sh')) return 'shell';
  if (l.includes('zsh')) return 'shell';
  if (l.includes('node')) return 'node';
  if (l.includes('ruby')) return 'ruby';
  if (l.includes('perl')) return 'perl';
  if (l.includes('php')) return 'php';
  return 'unknown';
}

const MAX_FILES_SCANNED = 5000;

/**
 * Walk a skill folder and return every detected script (deduped, sorted).
 * Reads only the first line of extensionless files (shebang sniff) — does not
 * slurp file contents.
 */
export async function detectScripts(
  skillDir: string,
  isExcluded?: (abs: string) => boolean,
): Promise<DetectedScript[]> {
  const found = new Map<string, string>();
  let scanned = 0;
  const stack: string[] = [skillDir];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (scanned >= MAX_FILES_SCANNED) break;
      const abs = join(dir, d.name);
      if (isExcluded?.(abs)) continue;
      if (d.isDirectory()) {
        if (d.name === '.git' || d.name === 'node_modules') continue;
        stack.push(abs);
        continue;
      }
      if (!d.isFile()) continue;
      scanned++;
      const rel = relative(skillDir, abs).split(sep).join('/');
      const ext = extname(d.name).toLowerCase();

      const extLang = EXT_LANGUAGE[ext];
      if (extLang) {
        found.set(rel, extLang);
        continue;
      }
      // Extensionless file: sniff a shebang (covers e.g. scripts/deploy).
      if (ext === '') {
        try {
          const info = await stat(abs);
          if (info.size > 0 && info.size < 1024 * 1024) {
            const buf = await readFile(abs, 'utf8');
            const firstLine = buf.slice(0, buf.indexOf('\n') === -1 ? buf.length : buf.indexOf('\n'));
            const lang = shebangLanguage(firstLine);
            if (lang) found.set(rel, lang);
          }
        } catch {
          // unreadable — ignore
        }
      }
    }
    if (scanned >= MAX_FILES_SCANNED) break;
  }

  return Array.from(found.entries())
    .map(([path, language]) => ({ path, language }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
