// figma-ds-lock.mjs — Figma design-system snapshot + diff (the /figma-sync
// engine, backlog N1.5, 2026-07-16).
//
// Pattern: a committed LOCKFILE (design/figma-ds.lock.json) captures the
// design system's last-synced state — text-style ramp + per-component
// variant axes, geometry, paints and text typography. `--diff` fetches the
// live file over REST and prints exactly what changed since the last sync;
// `--write` refreshes the lock after the changes have been applied to code.
//
// Why a lockfile instead of comparing Figma to the TSX directly: component
// code is arbitrary (dynamic classes, variant maps) — inferring its geometry
// statically is guesswork. The lock makes the question tractable: "what did
// the designer change in Figma since the code last matched it?" — and THAT
// delta is what /figma-sync translates into code.
//
// Usage (from apps/web — token: FIGMA_ACCESS_TOKEN or ~/.figma-token):
//   node scripts/figma-ds-lock.mjs --write   # (re)baseline the lock
//   node scripts/figma-ds-lock.mjs --diff    # exit 0 = in sync, 1 = deltas
//
// Scope notes:
//   - Sample TEXT CONTENT is deliberately NOT captured (it's illustrative,
//     not part of the contract). fontSize / font style / textStyleId are.
//   - Paints capture BOTH the bound variable id and the resolved rgba, so a
//     token VALUE change (same binding, new colour) and a REBINDING (new
//     variable) are distinguishable.
//   - Doc pages (Cover, Getting Started, foundations, Patterns, Examples)
//     hold no components-of-record and are skipped by the component walk;
//     anything COMPONENT/COMPONENT_SET elsewhere is captured wherever it is.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const FILE_KEY = 'GWXBALe90DMFR3XYGccofJ';
const HERE = dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = join(HERE, '..', 'design', 'figma-ds.lock.json');

// ─── Snapshot extraction (pure — unit-tested) ───────────────────────────────

function paintOf(p) {
  if (!p) return null;
  return {
    var: p.boundVariables?.color?.id ?? null,
    rgba: p.color
      ? [
          Math.round(p.color.r * 255),
          Math.round(p.color.g * 255),
          Math.round(p.color.b * 255),
          Math.round((p.opacity ?? 1) * 1000) / 1000,
        ]
      : null,
  };
}

function textsOf(node, acc = []) {
  if (node.type === 'TEXT') {
    acc.push({
      fontSize: node.style?.fontSize ?? null,
      fontStyle: node.style?.fontPostScriptName ?? node.style?.fontFamily ?? null,
      textStyleId: node.styles?.text ?? null,
      fill: paintOf(node.fills?.[0]),
    });
  }
  for (const c of node.children ?? []) textsOf(c, acc);
  return acc;
}

export function snapshotVariant(node) {
  return {
    w: node.absoluteBoundingBox?.width ?? null,
    h: node.absoluteBoundingBox?.height ?? null,
    padL: node.paddingLeft ?? 0,
    padR: node.paddingRight ?? 0,
    padT: node.paddingTop ?? 0,
    padB: node.paddingBottom ?? 0,
    gap: node.itemSpacing ?? 0,
    radius: node.cornerRadius ?? 0,
    strokeWeight: node.strokeWeight ?? 0,
    fill: paintOf(node.fills?.[0]),
    stroke: paintOf(node.strokes?.[0]),
    texts: textsOf(node),
  };
}

/** Builds the lock's `components` section from full component subtrees
 *  (REST /nodes response documents). */
export function snapshotComponents(nodeDocs) {
  const out = {};
  for (const doc of nodeDocs) {
    if (doc.type === 'COMPONENT_SET') {
      const axes = {};
      const variants = {};
      for (const child of doc.children ?? []) {
        for (const pair of child.name.split(',')) {
          const [k, v] = pair.split('=').map((s) => s.trim());
          if (k && v !== undefined) (axes[k] ??= []).includes(v) || axes[k].push(v);
        }
        variants[child.name] = snapshotVariant(child);
      }
      for (const k of Object.keys(axes)) axes[k].sort();
      out[doc.id] = { name: doc.name, kind: 'set', axes, variants };
    } else if (doc.type === 'COMPONENT') {
      out[doc.id] = { name: doc.name, kind: 'component', variants: { _: snapshotVariant(doc) } };
    }
  }
  return out;
}

// ─── Diff (pure — unit-tested) ───────────────────────────────────────────────

function flatten(obj, prefix = '', acc = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, acc);
    else acc[key] = v;
  }
  return acc;
}

export function diffLocks(oldLock, newLock) {
  const deltas = [];

  // Text-style renames (values changes surface as node-level deltas below).
  const oldNames = oldLock.styleNames ?? {};
  const newNames = newLock.styleNames ?? {};
  for (const id of Object.keys(oldNames)) {
    if (newNames[id] && newNames[id] !== oldNames[id]) {
      deltas.push({ kind: 'style-renamed', target: oldNames[id], to: newNames[id] });
    }
  }

  // Components.
  const oldC = oldLock.components ?? {};
  const newC = newLock.components ?? {};
  for (const id of new Set([...Object.keys(oldC), ...Object.keys(newC)])) {
    const o = oldC[id];
    const n = newC[id];
    if (!n) {
      deltas.push({ kind: 'component-removed', target: o.name, nodeId: id });
      continue;
    }
    if (!o) {
      deltas.push({ kind: 'component-added', target: n.name, nodeId: id });
      continue;
    }
    if (o.name !== n.name) {
      deltas.push({ kind: 'component-renamed', target: o.name, to: n.name, nodeId: id });
    }
    const variantNames = new Set([...Object.keys(o.variants), ...Object.keys(n.variants)]);
    for (const vn of variantNames) {
      if (!n.variants[vn]) {
        deltas.push({ kind: 'variant-removed', target: n.name, variant: vn, nodeId: id });
        continue;
      }
      if (!o.variants[vn]) {
        deltas.push({ kind: 'variant-added', target: n.name, variant: vn, nodeId: id });
        continue;
      }
      const a = flatten(o.variants[vn]);
      const b = flatten(n.variants[vn]);
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[k] !== b[k]) {
          deltas.push({
            kind: 'variant-changed',
            target: n.name,
            variant: vn,
            prop: k,
            from: a[k],
            to: b[k],
            nodeId: id,
          });
        }
      }
    }
  }

  return deltas;
}

// ─── REST plumbing ───────────────────────────────────────────────────────────

function token() {
  if (process.env.FIGMA_ACCESS_TOKEN) return process.env.FIGMA_ACCESS_TOKEN;
  try {
    return readFileSync(join(homedir(), '.figma-token'), 'utf8').trim();
  } catch {
    console.error('FIGMA_ACCESS_TOKEN absent et ~/.figma-token illisible.');
    process.exit(2);
  }
}

async function api(path) {
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { 'X-Figma-Token': token() },
  });
  const json = await res.json();
  if (json.status && json.err) {
    console.error(`Figma API ${json.status}: ${json.err}`);
    process.exit(2);
  }
  return json;
}

async function fetchLiveLock() {
  // Phase 1 — page skeleton: which nodes are components/sets, + style ramp ids.
  const file = await api(`/files/${FILE_KEY}?depth=2`);
  const componentIds = [];
  for (const page of file.document.children) {
    for (const node of page.children ?? []) {
      if (node.type === 'COMPONENT_SET' || node.type === 'COMPONENT') componentIds.push(node.id);
    }
  }

  // Phase 2 — full subtrees, batched. Each /nodes payload also ships a
  // styles name-map ({styleId: {name}}) — merged for readable lock entries.
  const nodeDocs = [];
  const styleNames = {};
  for (let i = 0; i < componentIds.length; i += 40) {
    const chunk = componentIds.slice(i, i + 40);
    const res = await api(`/files/${FILE_KEY}/nodes?ids=${chunk.join(',')}`);
    for (const id of chunk) {
      const entry = res.nodes[id];
      if (!entry) continue;
      nodeDocs.push(entry.document);
      for (const [sid, s] of Object.entries(entry.styles ?? {})) {
        if (s.styleType === 'TEXT') styleNames[sid] = s.name;
      }
    }
  }

  // Text-style NAMES: the /files/:key/styles endpoint needs the
  // library_content:read scope (not on this token). Not needed for detection —
  // a style VALUE change surfaces as resolved fontSize/lineHeight deltas on
  // every bound text node (captured per-variant above). The /nodes responses
  // carry a styles name-map for readability; collect it opportunistically.
  return {
    fileKey: FILE_KEY,
    fileName: file.name,
    lastSynced: new Date().toISOString(),
    styleNames,
    components: snapshotComponents(nodeDocs),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2];
  if (mode === '--write') {
    const lock = await fetchLiveLock();
    mkdirSync(dirname(LOCK_PATH), { recursive: true });
    writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 1) + '\n');
    console.log(
      `Lock écrit: ${Object.keys(lock.components).length} composants, ${Object.keys(lock.styleNames).length} text styles → ${LOCK_PATH}`,
    );
    return;
  }
  if (mode === '--diff') {
    let oldLock;
    try {
      oldLock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    } catch {
      console.error(`Pas de lock (${LOCK_PATH}). Lance d'abord: --write`);
      process.exit(2);
    }
    const newLock = await fetchLiveLock();
    const deltas = diffLocks(oldLock, newLock);
    if (deltas.length === 0) {
      console.log(`✔ Figma inchangé depuis le dernier sync (${oldLock.lastSynced})`);
      return;
    }
    console.log(`${deltas.length} changement(s) Figma depuis ${oldLock.lastSynced}:\n`);
    for (const d of deltas) {
      const where = d.variant && d.variant !== '_' ? ` [${d.variant}]` : '';
      const prop = d.prop ? ` ${d.prop}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}` : '';
      console.log(`  • ${d.kind} ${d.target}${where}${prop}`);
    }
    console.log('\nJSON:');
    console.log(JSON.stringify(deltas, null, 1));
    process.exit(1);
  }
  console.error('Usage: node scripts/figma-ds-lock.mjs --write | --diff');
  process.exit(2);
}

if (process.argv[1]?.endsWith('figma-ds-lock.mjs')) {
  await main();
}
