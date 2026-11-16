// render-pdf.test.ts — `render_pdf` par le VRAI `executeTool` (#1082) : la porte
// d'approbation, le seam qui photographie et constate, l'outil, et le vrai
// moteur épinglé.
//
// Les assertions portent sur le PDF écrit (relu sur le disque, ses pages et
// son format lus par pdf-lib), sur le texte que l'agent reçoit, sur les lignes
// de constat et d'approbation relues en base — jamais sur un compte d'appels.
// Le moteur manquant fait ROUGIR ces tests, avec la commande qui l'installe.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPdfFacts, readRendererStatus } from '@nodal-agents/page-render';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agents, approvalRequests, constatedWrites, eq } from '@nodal-agents/db';
import { cheminConstate } from '../verification/record-constat';
import { executeTool } from '../execute';
import { SHARED_WORKSPACE_LABEL } from './file-ops/workspace';
import { renderPdfTool, type RenderPdfOutput } from './render-pdf';
import type { ExecuteOptions, ToolContext } from '../types';
import { rowsAsWritten } from '../tests/autonomy-rows-fixture';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const REAL_RENDERER =
  process.env['NODALAI_RENDERER_DIR'] ?? join(repoRoot, '.cache', 'page-renderer');

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let racine: string;
let DOCS: string;
let SHARED: string;

beforeAll(async () => {
  const status = await readRendererStatus({ dir: REAL_RENDERER });
  if (status.kind !== 'ready') {
    throw new Error(
      `REAL_RENDERER_MISSING: the pinned page renderer is not installed in ${REAL_RENDERER} ` +
        `(${status.kind}). Install it there: NODALAI_RENDERER_DIR=${REAL_RENDERER} ` +
        'pnpm --filter nodal-agents exec tsx src/index.ts renderer install',
    );
  }
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  vi.stubEnv('NODALAI_RENDERER_DIR', REAL_RENDERER);
  racine = await mkdtemp(join(tmpdir(), 'nodal-render-pdf-'));
  DOCS = join(racine, 'docs');
  SHARED = join(racine, 'shared');
  for (const d of [DOCS, SHARED]) await mkdir(d, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(racine, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
});

async function jobNeuf(agentId = seed.agentId, parentJobId?: string): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId,
      channel: 'api',
      task: '#1082',
      ...(parentJobId !== undefined ? { parentJobId } : {}),
    })
    .returning();
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function ctx(jobId: string = seed.jobId, agentId = seed.agentId, docs = DOCS): ToolContext {
  return {
    jobId,
    agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    turn: 1,
    workspaces: [
      { label: 'docs', path: docs },
      { label: SHARED_WORKSPACE_LABEL, path: SHARED },
    ],
  };
}

/** Les lignes qu'un agent neuf tient (#917) : celle de `render_pdf` et le réglage « shared file ». */
function rules(agentId = seed.agentId): ExecuteOptions {
  return {
    approvalRules: rowsAsWritten({ agentId, entityId: seed.entityId }, [renderPdfTool]),
    onApprovalRequired: async () => {},
  };
}

async function rendre(
  input: Record<string, unknown>,
  c: ToolContext = ctx(),
  r: ExecuteOptions = rules(),
): Promise<RenderPdfOutput> {
  const res = await executeTool(renderPdfTool, input as never, c, r);
  if (res.outcome !== 'success') throw new Error(`call did not run: ${JSON.stringify(res)}`);
  return res.output as RenderPdfOutput;
}

/** Une page de `px` pixels CSS de haut ; une page A4 à 10 mm de marges imprime 1047 px. */
function tall(px: number): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}` +
    `.b{height:${px}px;font:16px serif}</style></head><body><div class="b">` +
    `${'Le texte de la personne, tel quel. '.repeat(40)}<img src="photo.svg"></div></body></html>`
  );
}

beforeEach(async () => {
  await writeFile(
    join(DOCS, 'photo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>',
  );
});

describe('render_pdf — the page count held, in one call @cap:travailler-sur-des-fichiers/moteur', () => {
  it('about 1.3 pages asked on 1: one page written, scale below 1, said in the result', async () => {
    await writeFile(join(DOCS, 'page.html'), tall(1361));
    const out = await rendre({ source: 'docs/page.html', output: 'docs/page.pdf', pages: 1 });
    if (!out.ok) throw new Error(out.reason);

    const written = await readFile(join(DOCS, 'page.pdf'));
    const facts = await readPdfFacts(written);
    expect(facts.pages).toBe(1);
    expect(out.pages).toBe(1);
    expect(out.pages_asked).toBe(1);
    expect(out.pages_at_scale_1).toBe(2);
    expect(out.scale).toBeLessThan(1);
    expect(out.scale).toBeGreaterThanOrEqual(0.6);
    expect(out.bytes).toBe(written.length);
    expect(out.paper).toEqual(facts.paper);
    expect(out.summary).toBe(
      `1 page, A4 portrait (${facts.paper.width_mm} × ${facts.paper.height_mm} mm), shrunk to ` +
        `scale ${out.scale} to fit on 1 page(s) (2 page(s) at scale 1).`,
    );
    // The page's own image loaded: nothing is reported missing.
    expect(out.not_loaded).toBeUndefined();
  });

  it('the same page asked on 2: two pages, scale 1', async () => {
    await writeFile(join(DOCS, 'page.html'), tall(1361));
    const out = await rendre({ source: 'docs/page.html', output: 'docs/two.pdf', pages: 2 });
    if (!out.ok) throw new Error(out.reason);
    expect((await readPdfFacts(await readFile(join(DOCS, 'two.pdf')))).pages).toBe(2);
    expect(out.scale).toBe(1);
  });

  it('a page shorter than one page asked on 1: scale 1, nothing shrunk', async () => {
    await writeFile(join(DOCS, 'short.html'), tall(300));
    const out = await rendre({ source: 'docs/short.html', output: 'docs/short.pdf', pages: 1 });
    if (!out.ok) throw new Error(out.reason);
    expect(out.scale).toBe(1);
    expect(out.summary).toMatch(
      /at scale 1: it already fits on 1 page\(s\), nothing was shrunk\.$/,
    );
  });

  it('a page that cannot fit at the minimum scale: loud, with the numbers, and nothing written', async () => {
    await writeFile(join(DOCS, 'huge.html'), tall(1047 * 4));
    const out = await rendre({ source: 'docs/huge.html', output: 'docs/huge.pdf', pages: 1 });
    expect(out).toEqual({
      ok: false,
      reason:
        'The page does not fit on 1 page(s): it takes 4 page(s) at scale 1, and still 3 at 0.6, ' +
        'the smallest scale at which text stays readable. Nothing was written. Shorten the ' +
        'content or ask for more pages.',
    });
    expect(await readFile(join(DOCS, 'huge.pdf')).catch(() => null)).toBeNull();
  });

  it('explicit paper: Letter landscape, read from the written file', async () => {
    await writeFile(join(DOCS, 'l.html'), tall(200));
    const out = await rendre({
      source: 'docs/l.html',
      output: 'docs/l',
      paper: 'Letter',
      orientation: 'landscape',
      margins_mm: 15,
    });
    if (!out.ok) throw new Error(out.reason);
    // `output` without an extension gets .pdf.
    const facts = await readPdfFacts(await readFile(join(DOCS, 'l.pdf')));
    expect(facts.paper).toMatchObject({ name: 'Letter', orientation: 'landscape' });
  });
});

describe('render_pdf — the perimeter of file_read and file_write @cap:travailler-sur-des-fichiers/moteur', () => {
  it('a source outside the readable folders is refused before any render', async () => {
    const dehors = join(racine, 'dehors.html');
    await writeFile(dehors, tall(100));
    const out = await rendre({ source: dehors, output: 'docs/x.pdf' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(/outside|workspace/i);
  });

  it('an output outside the writable folders is refused, and nothing is written there', async () => {
    await writeFile(join(DOCS, 'p.html'), tall(100));
    const dehors = join(racine, 'dehors.pdf');
    const out = await rendre({ source: 'docs/p.html', output: dehors });
    expect(out.ok).toBe(false);
    expect(await readFile(dehors).catch(() => null)).toBeNull();
  });

  it('a sub-resource outside the perimeter is not loaded, and the result lists it', async () => {
    await writeFile(join(racine, 'secret.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(DOCS, 'p.html'), '<!doctype html><p>x</p><img src="../secret.svg">');
    const out = await rendre({ source: 'docs/p.html', output: 'docs/p.pdf' });
    if (!out.ok) throw new Error(out.reason);
    expect(out.not_loaded).toHaveLength(1);
    // The real path: under Windows `tmpdir()` may give the short 8.3 form.
    expect(out.not_loaded?.[0]?.url).toBe(join(await realpath(DOCS), '..', 'secret.svg'));
    expect(out.not_loaded?.[0]?.reason).toMatch(/^outside the folders this agent can read/);
  });

  it('a loopback address is not loaded', async () => {
    await writeFile(
      join(DOCS, 'p.html'),
      '<!doctype html><p>x</p><img src="http://127.0.0.1:3001/api/health">',
    );
    const out = await rendre({ source: 'docs/p.html', output: 'docs/p.pdf' });
    if (!out.ok) throw new Error(out.reason);
    expect(out.not_loaded).toEqual([
      {
        url: 'http://127.0.0.1:3001/api/health',
        reason:
          '127.0.0.1 is a local or private address (127.0.0.1); the page renderer only loads the public internet',
      },
    ]);
  });

  it('replacing a shared file this agent did not write asks first, and the file is kept', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(DOCS, 'p.html'), tall(100));
    await writeFile(join(SHARED, 'rapport.pdf'), 'le travail d’un autre');
    const res = await executeTool(
      renderPdfTool,
      {
        source: 'docs/p.html',
        output: 'shared/rapport.pdf',
        purpose: 'Le rapport du jour.',
      } as never,
      ctx(jobId),
      rules(),
    );
    expect(res.outcome).toBe('awaiting_approval');
    expect(await readFile(join(SHARED, 'rapport.pdf'), 'utf8')).toBe('le travail d’un autre');
    const demandes = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, jobId));
    expect(demandes.map((d) => d.toolName)).toEqual(['render_pdf']);
  });

  it('a new file in the shared folder asks nothing, and is recorded as created by the job', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(DOCS, 'p.html'), tall(100));
    const out = await rendre({ source: 'docs/p.html', output: 'shared/neuf.pdf' }, ctx(jobId));
    expect(out.ok).toBe(true);
    const lignes = await db.select().from(constatedWrites).where(eq(constatedWrites.jobId, jobId));
    expect(lignes.map((l) => ({ path: l.path, kind: l.changeKind }))).toEqual([
      { path: await cheminConstate(join(SHARED, 'neuf.pdf')), kind: 'added' },
    ]);
  });

  it('an output that is not a .pdf is refused', async () => {
    await writeFile(join(DOCS, 'p.html'), tall(100));
    const out = await rendre({ source: 'docs/p.html', output: 'docs/p.png' });
    expect(out).toEqual({
      ok: false,
      reason: 'The output is a PDF: "docs/p.png" must end in .pdf (or have no extension).',
    });
  });
});

describe('render_pdf — no renderer, being installed, broken @cap:travailler-sur-des-fichiers/moteur', () => {
  let ailleurs: string;
  beforeEach(async () => {
    ailleurs = await mkdtemp(join(tmpdir(), 'nodal-render-pdf-none-'));
    vi.stubEnv('NODALAI_RENDERER_DIR', ailleurs);
    await writeFile(join(DOCS, 'p.html'), tall(100));
  });
  afterEach(async () => {
    await rm(ailleurs, { recursive: true, force: true });
  });

  const state = (v: unknown) => writeFile(join(ailleurs, 'state.json'), JSON.stringify(v));

  it('never installed: says so, and how to install it', async () => {
    const out = await rendre({ source: 'docs/p.html', output: 'docs/p.pdf' });
    expect(out).toEqual({
      ok: false,
      reason:
        "Nodal's page renderer is not installed (no install has run on this machine yet). " +
        'Nothing was written. Install it with `nodal-agents renderer install` (or restart ' +
        'Nodal, which downloads it at start unless that is turned off).',
    });
  });

  it('being installed: says so, with the progress', async () => {
    await state({
      status: 'installing',
      pid: process.pid,
      buildId: 'x',
      startedAt: '2026-11-16T10:00:00.000Z',
      downloadedBytes: 60 * 1024 * 1024,
      totalBytes: 120 * 1024 * 1024,
    });
    const out = await rendre({ source: 'docs/p.html', output: 'docs/p.pdf' });
    expect(out).toEqual({
      ok: false,
      reason:
        "Nodal's page renderer is being installed right now (started 2026-11-16T10:00:00.000Z by " +
        `process ${process.pid}, 60 MB of 120 MB downloaded). Nothing was written. Call again once it is installed.`,
    });
  });

  it('its install failed: says why', async () => {
    const { RENDERER_BUILD_ID } = await import('@nodal-agents/page-render');
    await state({
      status: 'failed',
      buildId: RENDERER_BUILD_ID,
      reason:
        'downloading chrome-headless-shell failed (getaddrinfo ENOTFOUND storage.googleapis.com)',
      at: '2026-11-16T10:00:00.000Z',
    });
    const out = await rendre({ source: 'docs/p.html', output: 'docs/p.pdf' });
    expect(!out.ok && out.reason).toBe(
      "Nodal's page renderer is not installed: its install failed (downloading " +
        'chrome-headless-shell failed (getaddrinfo ENOTFOUND storage.googleapis.com), ' +
        '2026-11-16T10:00:00.000Z). Nothing was written. Install it with `nodal-agents ' +
        'renderer install` (or restart Nodal, which downloads it at start unless that is turned off).',
    );
  });

  it('turned off at start: says by what', async () => {
    await state({ status: 'off', how: 'nodal-agents up --skip-renderer-install', at: 'now' });
    const out = await rendre({ source: 'docs/p.html', output: 'docs/p.pdf' });
    expect(!out.ok && out.reason).toBe(
      "Nodal's page renderer is not installed: its download at start is turned off " +
        '(nodal-agents up --skip-renderer-install). Nothing was written. Install it with ' +
        '`nodal-agents renderer install`.',
    );
  });

  it('broken (its program is not a program): says it did not start', async () => {
    const { RENDERER_BUILD_ID } = await import('@nodal-agents/page-render');
    const fake = join(ailleurs, process.platform === 'win32' ? 'broken.exe' : 'broken');
    await writeFile(fake, 'not a program');
    await writeFile(
      join(ailleurs, 'installed.json'),
      JSON.stringify({
        buildId: RENDERER_BUILD_ID,
        platform: 'x',
        executablePath: fake,
        installedAt: 'now',
      }),
    );
    const out = await rendre({ source: 'docs/p.html', output: 'docs/p.pdf' });
    expect(!out.ok && out.reason).toMatch(/^Nodal's page renderer did not start: /);
  });
});

describe('render_pdf — every agent, a head job and a delegated one @cap:travailler-sur-des-fichiers/moteur', () => {
  it('two agents render in their own folders; the delegated one cannot read the other’s', async () => {
    const [second] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Second',
        slug: `second-${Date.now()}`,
        personality: 'x',
        llmKeyId: null,
      })
      .returning();
    if (!second) throw new Error('agent insert failed');
    const DOCS_B = join(racine, 'docs-b');
    await mkdir(DOCS_B);
    const head = await jobNeuf();
    const delegated = await jobNeuf(second.id, head);

    await writeFile(join(DOCS, 'a.html'), tall(1361));
    await writeFile(join(DOCS_B, 'b.html'), tall(1361));
    const a = await rendre({ source: 'docs/a.html', output: 'docs/a.pdf', pages: 1 }, ctx(head));
    const b = await rendre(
      { source: 'docs/b.html', output: 'docs/b.pdf', pages: 2 },
      ctx(delegated, second.id, DOCS_B),
      rules(second.id),
    );
    expect(a.ok && a.pages).toBe(1);
    expect(b.ok && b.pages).toBe(2);
    expect((await readPdfFacts(await readFile(join(DOCS, 'a.pdf')))).pages).toBe(1);
    expect((await readPdfFacts(await readFile(join(DOCS_B, 'b.pdf')))).pages).toBe(2);

    const peek = await rendre(
      { source: join(DOCS, 'a.html'), output: 'docs/peek.pdf' },
      ctx(delegated, second.id, DOCS_B),
      rules(second.id),
    );
    expect(peek.ok).toBe(false);
  });
});
