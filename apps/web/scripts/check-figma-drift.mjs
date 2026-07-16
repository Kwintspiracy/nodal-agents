// check-figma-drift.mjs — Figma ↔ code drift detector (backlog N1, 2026-07-16).
//
// The design system contract: the CODE is the source of truth, the Figma file
// is its mirror, and the `.figma.tsx` Code Connect files encode the mapping.
// Nothing enforces that contract mechanically — a variant added in Figma, a
// component deleted, or a ui/ component that never got mirrored all drift
// SILENTLY. This script is the machine check ("jamais fini sans rapport
// machine"): it fetches the live Figma file over REST, parses the repo's
// mapping files, and reports every divergence. Exit 1 on errors (CI-able).
//
// Usage:
//   FIGMA_ACCESS_TOKEN=... node scripts/check-figma-drift.mjs
//   (falls back to reading ~/.figma-token — scope needed: file_content:read)
//
// Checks:
//   E1  ui/<X>.tsx with no .figma.tsx referencing it        → error
//   E2  .figma.tsx pointing at a node-id absent from Figma  → error (stale)
//   E3  Figma component/set with no mapping                 → error
//   E4  variant axis VALUES diverge (added/removed in Figma) → error
//   E5  Figma axis not mapped (and not presentation-only)   → warning
//   W1  acknowledged gaps (KNOWN_GAPS below)                → warning

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const FILE_KEY = 'GWXBALe90DMFR3XYGccofJ';
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'ui');

/** Figma-only presentation axes: rendered by CSS states in code (hover/focus),
 *  deliberately absent from the .figma.tsx prop mappings. */
export const PRESENTATION_AXES = new Set(['State']);

/** Figma components whose code lives OUTSIDE the repo's ui/ mapping files —
 *  mapped via the Figma UI/MCP instead. Keyed by Figma name prefix. */
export const EXTERNAL_MAPPING_PREFIXES = ['Icon/'];

/** ui/ components acknowledged as NOT yet mirrored in Figma. Each entry is
 *  DEBT: create the Figma component + .figma.tsx, then remove it from here.
 *  Reported as warnings so the check still passes.
 *  (2026-07-16: emptied — PageShell, PageTopBar, SetRow and SidebarSection
 *  got their Figma components + mappings. Keep the mechanism for next time.) */
export const KNOWN_GAPS = new Set([]);

// ─── Parsers (pure — unit-tested) ───────────────────────────────────────────

/** Extracts every figma.connect() mapping from a .figma.tsx source. */
export function parseFigmaTsx(source) {
  const mappings = [];
  const connectRe = /figma\.connect\(\s*(\w+)\s*,\s*'[^']*node-id=(\d+)-(\d+)/g;
  let m;
  while ((m = connectRe.exec(source))) {
    mappings.push({ componentName: m[1], nodeId: `${m[2]}:${m[3]}` });
  }
  // Prop mappings are file-scoped (fine: one component per file by convention;
  // multi-connect files share the union, which only widens coverage).
  const enums = {};
  const enumRe = /figma\.enum\(\s*'([^']+)'\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  while ((m = enumRe.exec(source))) {
    const keys = [...m[2].matchAll(/(?:'([^']+)'|(\w+))\s*:/g)].map((k) => k[1] ?? k[2]);
    enums[m[1]] = keys;
  }
  const named = (fn) =>
    [...source.matchAll(new RegExp(`figma\\.${fn}\\(\\s*'([^']+)'`, 'g'))].map((x) => x[1]);
  return {
    mappings,
    enums,
    booleans: named('boolean'),
    strings: named('string'),
    instances: named('instance'),
  };
}

/** Walks a Figma REST file (depth>=3) into { nodeId, name, axes } entries.
 *  axes = { AxisName: Set(values) } for component sets, null for standalone. */
export function extractFigmaComponents(fileJson) {
  const out = [];
  for (const page of fileJson.document.children) {
    for (const node of page.children ?? []) {
      if (node.type === 'COMPONENT_SET') {
        const axes = {};
        for (const child of node.children ?? []) {
          for (const pair of child.name.split(',')) {
            const [k, v] = pair.split('=').map((s) => s.trim());
            if (!k || v === undefined) continue;
            (axes[k] ??= new Set()).add(v);
          }
        }
        out.push({ nodeId: node.id, name: node.name, page: page.name, axes });
      } else if (node.type === 'COMPONENT') {
        out.push({ nodeId: node.id, name: node.name, page: page.name, axes: null });
      }
    }
  }
  return out;
}

// ─── Drift computation (pure — unit-tested) ─────────────────────────────────

export function computeDrift({ figmaComponents, parsedFiles, uiComponentNames }) {
  const errors = [];
  const warnings = [];

  const mappedNodeIds = new Map(); // nodeId -> { file, parsed }
  const mappedCodeNames = new Set();
  for (const { file, parsed } of parsedFiles) {
    for (const m of parsed.mappings) {
      mappedNodeIds.set(m.nodeId, { file, parsed });
      mappedCodeNames.add(m.componentName);
    }
  }

  // E1 — every ui component is referenced by some figma.connect import.
  for (const name of uiComponentNames) {
    if (mappedCodeNames.has(name)) continue;
    if (KNOWN_GAPS.has(name)) {
      warnings.push(`W1 ${name}.tsx: pas encore de composant Figma (dette actée, KNOWN_GAPS)`);
    } else {
      errors.push(`E1 ${name}.tsx: aucun .figma.tsx ne le mappe`);
    }
  }

  const figmaById = new Map(figmaComponents.map((c) => [c.nodeId, c]));

  // E2 — stale mappings.
  for (const [nodeId, { file }] of mappedNodeIds) {
    if (!figmaById.has(nodeId)) {
      errors.push(`E2 ${file}: node ${nodeId} introuvable dans le fichier Figma (mapping périmé)`);
    }
  }

  for (const comp of figmaComponents) {
    const external = EXTERNAL_MAPPING_PREFIXES.some((p) => comp.name.startsWith(p));
    const mapped = mappedNodeIds.get(comp.nodeId);

    // E3 — unmapped Figma component.
    if (!mapped && !external) {
      errors.push(
        `E3 Figma "${comp.name}" (${comp.nodeId}, page ${comp.page}): aucun mapping .figma.tsx`,
      );
      continue;
    }
    if (!mapped || !comp.axes) continue;

    // E4/E5 — axis + value drift on component sets.
    for (const [axis, values] of Object.entries(comp.axes)) {
      const mappedValues = mapped.parsed.enums[axis];
      if (!mappedValues) {
        if (!PRESENTATION_AXES.has(axis)) {
          warnings.push(
            `E5 "${comp.name}": axe Figma "${axis}" non mappé dans ${mapped.file} (délibéré ?)`,
          );
        }
        continue;
      }
      for (const v of values) {
        if (!mappedValues.includes(v)) {
          errors.push(
            `E4 "${comp.name}": valeur Figma ${axis}=${v} absente du mapping ${mapped.file}`,
          );
        }
      }
      for (const v of mappedValues) {
        if (!values.has(v)) {
          errors.push(
            `E4 "${comp.name}": le mapping ${mapped.file} déclare ${axis}=${v}, disparu de Figma`,
          );
        }
      }
    }
  }

  return { errors, warnings };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  let token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    try {
      token = readFileSync(join(homedir(), '.figma-token'), 'utf8').trim();
    } catch {
      console.error(
        'FIGMA_ACCESS_TOKEN absent et ~/.figma-token illisible. Scope requis: file_content:read.',
      );
      process.exit(2);
    }
  }

  const res = await fetch(`https://api.figma.com/v1/files/${FILE_KEY}?depth=3`, {
    headers: { 'X-Figma-Token': token },
  });
  const fileJson = await res.json();
  if (fileJson.status) {
    console.error(`Figma API ${fileJson.status}: ${fileJson.err}`);
    process.exit(2);
  }

  const uiFiles = readdirSync(UI_DIR);
  const uiComponentNames = uiFiles
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.figma.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''));
  const parsedFiles = uiFiles
    .filter((f) => f.endsWith('.figma.tsx'))
    .map((f) => ({ file: f, parsed: parseFigmaTsx(readFileSync(join(UI_DIR, f), 'utf8')) }));

  const figmaComponents = extractFigmaComponents(fileJson);
  const { errors, warnings } = computeDrift({ figmaComponents, parsedFiles, uiComponentNames });

  console.log(
    `Figma "${fileJson.name}" : ${figmaComponents.length} composants · repo : ${uiComponentNames.length} composants ui, ${parsedFiles.length} .figma.tsx\n`,
  );
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const e of errors) console.log(`  ✖ ${e}`);
  if (errors.length === 0) {
    console.log(`\n✔ Aucune dérive (${warnings.length} warning(s))`);
  } else {
    console.log(`\n✖ ${errors.length} dérive(s) détectée(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
}

// Run only when invoked as a CLI (the vitest suite imports the pure functions).
if (process.argv[1]?.endsWith('check-figma-drift.mjs')) {
  await main();
}
