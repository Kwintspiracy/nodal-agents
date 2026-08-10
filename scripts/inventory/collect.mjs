// Inventaire exhaustif des capacités de Nodal-Agents, extrait du code.
// Écrit inventory.json ; n'imprime que des compteurs.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// Résolu depuis ce fichier : le chemin absolu d'origine ne valait que sur une machine.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..').replaceAll(sep, '/');
const OUT = process.argv[2];

function walk(dir, pred, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!['node_modules', 'dist', '.next', '.turbo', 'out'].includes(e)) walk(f, pred, acc);
    } else if (pred(f)) acc.push(f);
  }
  return acc;
}

const isSrc = (f) => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f);
const isTest = (f) => /\.(test|spec)\.tsx?$/.test(f);

// ── Corpus de tests : tout le texte des fichiers de test du repo ──────────────
const testFiles = [...walk(join(ROOT, 'packages'), isTest), ...walk(join(ROOT, 'apps'), isTest)];
const testBlobs = testFiles.map((f) => ({ f, txt: readFileSync(f, 'utf-8') }));
const e2eFiles = walk(join(ROOT, 'apps/web/tests/e2e'), (f) => /\.spec\.ts$/.test(f));
const e2eBlobs = e2eFiles.map((f) => ({ f, txt: readFileSync(f, 'utf-8') }));

/**
 * Où un identifiant est-il testé ? unit / e2e / aucun.
 *
 * Deux régimes, parce qu'un nom de fonction et un chemin de route ne se citent
 * pas de la même façon dans un test.
 *
 * Un identifiant ordinaire (`deleteWorkspaceAction`) est cherché comme mot
 * entier ou entre quotes — assez strict pour ne pas confondre `attach_mcp` avec
 * `attach_mcp_server`.
 *
 * Un CHEMIN (tout ce qui contient un `/`) est cherché en sous-chaîne littérale.
 * Le régime strict produisait des faux négatifs francs : `/webhooks/:slug/:secret`
 * était compté « sans test » alors que `apps/runner/src/tests/routes/webhook.test.ts`
 * le couvre en douze tests contre le vrai serveur — la chaîne y apparaît dans
 * `describe('POST /webhooks/:slug/:secret — …')`, donc ni entre quotes
 * immédiates, ni précédée d'une frontière de mot (`\b` ne s'arme pas devant `/`).
 * Un chemin de route est assez spécifique pour que la sous-chaîne suffise.
 *
 * `scope` restreint le corpus aux fichiers dont le chemin le contient. Sans lui,
 * la sous-chaîne compte n'importe quelle citation : un test du dashboard qui
 * vérifie l'URL appelée par `fetch` faisait passer `/api/skills/uninstall` pour
 * une route testée, alors que le handler du runner n'était jamais monté. Les
 * routes sont donc mesurées sur `apps/runner` uniquement.
 *
 * Ce croisement reste une mesure de CITATION, pas de preuve : il dit qu'un test
 * parle de cette capacité, jamais qu'il en éprouve le comportement.
 */
function testStatus(needle, scope) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = needle.includes('/')
    ? { test: (txt) => txt.includes(needle) }
    : new RegExp(`['"\`]${esc}['"\`]|\\b${esc}\\b`);
  const inScope = (b) => !scope || b.f.split('\\').join('/').includes(scope);
  const unit = testBlobs
    .filter(inScope)
    .filter((b) => re.test(b.txt))
    .map((b) => b.f);
  const e2e = e2eBlobs.filter((b) => re.test(b.txt)).map((b) => b.f);
  return {
    unit: unit.length,
    e2e: e2e.length,
    files: [...unit, ...e2e].slice(0, 4).map((f) => f.replace(ROOT, '').split('\\').join('/')),
  };
}

const inv = {};

// ── 1. Outils intégrés ────────────────────────────────────────────────────────
{
  const files = walk(join(ROOT, 'packages/tools/src/builtin'), isSrc);
  const seen = new Map();
  for (const f of files) {
    const txt = readFileSync(f, 'utf-8');
    for (const m of txt.matchAll(/^\s*name: '([a-z_0-9]+)',/gm)) {
      const name = m[1];
      if (!seen.has(name)) {
        const risk = (txt.match(new RegExp(`name: '${name}'[\\s\\S]{0,600}?riskLevel: '(\\w+)'`)) ??
          [])[1];
        const gated = new RegExp(`name: '${name}'[\\s\\S]{0,900}?defaultApproval`).test(txt);
        seen.set(name, {
          name,
          file: f.replace(ROOT, '').split('\\').join('/'),
          risk: risk ?? '—',
          gated,
          test: testStatus(name),
        });
      }
    }
  }
  inv.builtinTools = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── 2. Outils connecteurs (adaptateurs) ───────────────────────────────────────
{
  const out = [];
  const base = join(ROOT, 'packages/adapters');
  for (const pkg of readdirSync(base)) {
    const src = join(base, pkg, 'src');
    if (!existsSync(src)) continue;
    const seen = new Set();
    for (const f of walk(src, isSrc)) {
      const txt = readFileSync(f, 'utf-8');
      for (const m of txt.matchAll(/name: '([a-z_0-9]+)'/g)) {
        const n = m[1];
        if (n.length < 4 || seen.has(n)) continue;
        seen.add(n);
      }
    }
    if (seen.size > 0) {
      out.push({
        adapter: pkg,
        tools: [...seen].sort(),
        count: seen.size,
        test: testStatus(pkg),
      });
    }
  }
  inv.connectors = out.sort((a, b) => a.adapter.localeCompare(b.adapter));
}

// ── 3. Commandes CLI ──────────────────────────────────────────────────────────
{
  const txt = readFileSync(join(ROOT, 'apps/cli/src/index.ts'), 'utf-8');
  inv.cliCommands = [...txt.matchAll(/\.command\('([^']+)'\)/g)].map((m) => ({
    name: m[1],
    test: testStatus(m[1].split(' ')[0]),
  }));
}

// ── 4. Routes HTTP du runner ──────────────────────────────────────────────────
{
  const txt = readFileSync(join(ROOT, 'apps/runner/src/server.ts'), 'utf-8');
  inv.routes = [...txt.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)].map((m) => ({
    method: m[1].toUpperCase(),
    path: m[2],
    // Portée : seul un test qui monte le serveur du runner éprouve une route.
    test: testStatus(m[2], 'apps/runner'),
  }));
}

// ── 5. Server actions du dashboard ────────────────────────────────────────────
{
  const txt = readFileSync(join(ROOT, 'apps/web/src/lib/actions.ts'), 'utf-8');
  const names = [...txt.matchAll(/export async function (\w+Action)\(/g)].map((m) => m[1]);
  inv.serverActions = [...new Set(names)].sort().map((n) => ({ name: n, test: testStatus(n) }));
}

// ── 6. Pages du dashboard ─────────────────────────────────────────────────────
{
  const base = join(ROOT, 'apps/web/src/app/(dashboard)');
  const pages = walk(base, (f) => /page\.tsx$/.test(f)).map((f) => {
    const rel = f.replace(base, '').split('\\').join('/').replace('/page.tsx', '') || '/';
    return {
      route: rel === '' ? '/' : rel,
      test: testStatus(rel.split('/').filter(Boolean)[0] ?? 'dashboard'),
    };
  });
  inv.pages = pages.sort((a, b) => a.route.localeCompare(b.route));
}

// ── 7. Canaux ─────────────────────────────────────────────────────────────────
{
  const base = join(ROOT, 'apps/runner/src/channels');
  const dirs = existsSync(base)
    ? readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory())
    : [];
  const all = [...dirs, 'telegram'];
  inv.channels = [...new Set(all)].sort().map((c) => ({ name: c, test: testStatus(c) }));
}

// ── 8. Fournisseurs LLM ───────────────────────────────────────────────────────
{
  const base = join(ROOT, 'packages/llm/src/providers');
  inv.providers = walk(base, isSrc)
    .map((f) => f.split('\\').pop().replace('.ts', ''))
    .filter((n) => !n.includes('cache') && n !== 'index')
    .sort()
    .map((n) => ({ name: n, test: testStatus(n) }));
}

// ── 9. Catalogue de modèles ───────────────────────────────────────────────────
{
  const txt = readFileSync(join(ROOT, 'packages/shared/src/model-catalog.ts'), 'utf-8');
  const lines = txt.split('\n');
  let prov = null;
  const byProv = {};
  for (const l of lines) {
    const p = l.match(/^  ([a-z-]+): \[/);
    if (p) {
      prov = p[1];
      byProv[prov] = [];
    }
    const m = l.match(/modelId: '([^']+)'/);
    if (m && prov) byProv[prov].push(m[1]);
  }
  inv.models = Object.entries(byProv).map(([p, ms]) => ({
    provider: p,
    models: ms,
    count: ms.length,
  }));
}

// ── 10. Skills du catalogue ───────────────────────────────────────────────────
{
  const base = join(ROOT, 'packages/catalog/src/skills');
  inv.skills = walk(base, isSrc)
    .map((f) => f.split('\\').pop().replace('.ts', ''))
    .filter((n) => n !== 'index')
    .sort()
    .map((n) => ({ name: n, test: testStatus(n) }));
}

// ── 11. Serveurs MCP du catalogue ─────────────────────────────────────────────
{
  const txt = readFileSync(join(ROOT, 'packages/shared/src/mcp-catalog.ts'), 'utf-8');
  inv.mcpCatalog = [...txt.matchAll(/slug: '([^']+)'/g)].map((m) => ({
    slug: m[1],
    test: testStatus(m[1]),
  }));
}

// ── 12. Sections du banc ──────────────────────────────────────────────────────
{
  const base = join(ROOT, 'bench/baselines');
  inv.bench = existsSync(base)
    ? readdirSync(base)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const j = JSON.parse(readFileSync(join(base, f), 'utf-8'));
          // 'why' vient de la définition de la section — ce qu'elle garde.
          const srcPath = join(ROOT, 'packages/bench/src/sections', j.sectionId + '.ts');
          const why = existsSync(srcPath)
            ? ((readFileSync(srcPath, 'utf-8').match(/why:\s*'([^']+)'/) ?? [])[1] ?? '')
            : '';
          return {
            id: j.sectionId,
            why,
            gitSha: j.gitSha,
            acceptedAt: j.acceptedAt,
            metrics: j.metrics.map((m) => ({
              id: m.id,
              label: m.label,
              value: m.value,
              unit: m.unit,
              direction: m.direction,
            })),
          };
        })
    : [];
}

// ── 13. Compteurs globaux de tests ────────────────────────────────────────────
inv.meta = {
  generatedFor: 'nodal-agents',
  testFiles: testFiles.length,
  e2eFiles: e2eFiles.length,
  archTests:
    walk(join(ROOT, 'packages'), (f) => /architecture\.test\.ts$/.test(f)).length +
    walk(join(ROOT, 'apps'), (f) => /architecture\.test\.ts$/.test(f)).length,
};

writeFileSync(OUT, JSON.stringify(inv, null, 2), 'utf-8');

const untested = (arr, key = 'test') =>
  arr.filter((x) => x[key] && x[key].unit === 0 && x[key].e2e === 0).length;

console.log(
  'outils intégrés    :',
  inv.builtinTools.length,
  '| sans test:',
  untested(inv.builtinTools),
);
console.log(
  'adaptateurs        :',
  inv.connectors.length,
  '| outils:',
  inv.connectors.reduce((s, c) => s + c.count, 0),
);
console.log(
  'commandes CLI      :',
  inv.cliCommands.length,
  '| sans test:',
  untested(inv.cliCommands),
);
console.log('routes runner      :', inv.routes.length, '| sans test:', untested(inv.routes));
console.log(
  'server actions     :',
  inv.serverActions.length,
  '| sans test:',
  untested(inv.serverActions),
);
console.log('pages dashboard    :', inv.pages.length);
console.log('canaux             :', inv.channels.length);
console.log('fournisseurs LLM   :', inv.providers.length);
console.log(
  'modèles            :',
  inv.models.reduce((s, p) => s + p.count, 0),
  'sur',
  inv.models.length,
  'fournisseurs',
);
console.log('skills catalogue   :', inv.skills.length, '| sans test:', untested(inv.skills));
console.log('serveurs MCP       :', inv.mcpCatalog.length);
console.log('sections banc      :', inv.bench.length);
console.log(
  'fichiers de test   :',
  inv.meta.testFiles,
  '| e2e:',
  inv.meta.e2eFiles,
  '| archi:',
  inv.meta.archTests,
);
