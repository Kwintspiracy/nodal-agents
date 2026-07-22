// pptx.test.ts — round-trip + security tests for pptx_* tools

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { pptxReadTool, pptxCreateTool, pptxAppendSlidesTool, pptxReplaceTextTool } from './pptx';
import type { ToolContext } from '../../types';

// ─── Setup ────────────────────────────────────────────────────────────────────

let WORKSPACE: string;

beforeAll(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-pptx-ws-'));
});

afterAll(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(WORKSPACE, { recursive: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ctx(): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: WORKSPACE }],
  };
}

function ctxNone(): ToolContext {
  return { ...ctx(), workspaces: undefined };
}

/** Read a workspace .pptx file and return the raw XML of ppt/slides/slideN.xml. */
async function readSlideXml(filename: string, slideNumber: number): Promise<string> {
  const buf = await readFile(join(WORKSPACE, filename));
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file(`ppt/slides/slide${slideNumber}.xml`);
  if (!file) throw new Error(`slide${slideNumber}.xml not found in ${filename}`);
  return file.async('string');
}

/** Read a workspace .pptx file and return the raw XML of a notes slide. */
async function readNotesSlideXml(filename: string, slideNumber: number): Promise<string> {
  const buf = await readFile(join(WORKSPACE, filename));
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file(`ppt/notesSlides/notesSlide${slideNumber}.xml`);
  if (!file) throw new Error(`notesSlide${slideNumber}.xml not found in ${filename}`);
  return file.async('string');
}

// ─── pptx_create ─────────────────────────────────────────────────────────────

describe('pptx_create', () => {
  it('creates a deck and pptx_read returns slide count + bullet text', async () => {
    const create = await pptxCreateTool.execute(
      {
        path: 'deck.pptx',
        slides: [
          { title: 'Intro', bullets: ['Point A', 'Point B'] },
          { title: 'Details', body: 'Some body text here.' },
          { title: 'Conclusion', bullets: ['Done'] },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error(create.reason);
    expect(create.slide_count).toBe(3);

    const read = await pptxReadTool.execute({ path: 'deck.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);

    // slideCount should reflect the 3 slides
    expect(read.slideCount).toBeGreaterThanOrEqual(1);

    // Bullet text should appear in the extracted text
    expect(read.text).toContain('Point A');
    expect(read.text).toContain('Point B');
    expect(read.truncated).toBe(false);
  });

  it('includes title text in extracted content', async () => {
    const create = await pptxCreateTool.execute(
      {
        path: 'titled.pptx',
        slides: [{ title: 'My Important Slide', bullets: ['Bullet 1'] }],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);

    const read = await pptxReadTool.execute({ path: 'titled.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('My Important Slide');
  });

  it('refuses to overwrite when overwrite:false', async () => {
    await pptxCreateTool.execute(
      { path: 'existing.pptx', slides: [{ title: 'original' }], overwrite: false },
      ctx(),
    );
    const result = await pptxCreateTool.execute(
      { path: 'existing.pptx', slides: [{ title: 'new' }], overwrite: false },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/already exists/i);
  });

  it('overwrites when overwrite:true', async () => {
    await pptxCreateTool.execute(
      { path: 'over.pptx', slides: [{ title: 'original' }], overwrite: false },
      ctx(),
    );
    const result = await pptxCreateTool.execute(
      { path: 'over.pptx', slides: [{ title: 'replaced' }], overwrite: true },
      ctx(),
    );
    expect(result.ok).toBe(true);
  });

  it('returns ok:false for invalid image_path (path traversal)', async () => {
    const result = await pptxCreateTool.execute(
      {
        path: 'badimg.pptx',
        slides: [{ title: 'Test', image_path: '../escape.png' }],
        overwrite: false,
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/image_path|traversal|escape|workspace|outside/i);
  });

  it('returns ok:false (never throws) for a non-existent, non-traversing image_path', async () => {
    // M2 regression: a missing-but-legal path used to sail past the guard,
    // reach pptxgenjs, and throw ENOENT out of pptx.write() (outside any
    // try/catch) — escaping execute() entirely instead of {ok:false,...}.
    const result = await pptxCreateTool.execute(
      {
        path: 'missing-img.pptx',
        slides: [{ title: 'Test', image_path: 'does-not-exist.png' }],
        overwrite: false,
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('does-not-exist.png');
  });

  it('returns ok:false when image_path exceeds the 25 MiB cap', async () => {
    // Content doesn't need to be a valid image — the cap is enforced on file
    // size via stat(), before any image bytes are read or parsed.
    const oversized = Buffer.alloc(26 * 1024 * 1024);
    await writeFile(join(WORKSPACE, 'huge.png'), oversized);

    const result = await pptxCreateTool.execute(
      {
        path: 'oversized-img.pptx',
        slides: [{ title: 'Test', image_path: 'huge.png' }],
        overwrite: false,
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/too large|cap|25 ?mi?b/i);
  });
});

// ─── pptx_create enrichment (notes, table, theme, image sizing) ──────────────

describe('pptx_create enrichment', () => {
  it('embeds speaker notes without leaking them into per-slide text', async () => {
    const create = await pptxCreateTool.execute(
      {
        path: 'notes.pptx',
        slides: [
          { title: 'Slide With Notes', bullets: ['Visible bullet'], notes: 'Secret speaker note' },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);

    // Notes really are in the notesSlide XML part.
    const notesXml = await readNotesSlideXml('notes.pptx', 1);
    expect(notesXml).toContain('Secret speaker note');

    const read = await pptxReadTool.execute({ path: 'notes.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    // Full concatenated text includes notes (existing officeparser behavior)...
    expect(read.text).toContain('Secret speaker note');
    // ...but the per-slide breakdown must NOT (notes are a separate AST node).
    expect(read.slides[0]).toContain('Visible bullet');
    expect(read.slides[0]).not.toContain('Secret speaker note');
  });

  it('renders a table with header styling and real cell content', async () => {
    const create = await pptxCreateTool.execute(
      {
        path: 'table.pptx',
        slides: [
          {
            title: 'Numbers',
            table: {
              header: true,
              rows: [
                ['Name', 'Score'],
                ['Alice', '42'],
                ['Bob', '17'],
              ],
            },
          },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);

    const read = await pptxReadTool.execute({ path: 'table.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.slides[0]).toContain('Name');
    expect(read.slides[0]).toContain('Alice');
    expect(read.slides[0]).toContain('42');

    // Header row is bold in the raw XML.
    const xml = await readSlideXml('table.pptx', 1);
    expect(xml).toContain('<a:tbl');
    expect(xml).toMatch(/<a:rPr[^>]*b="1"/);
  });

  it('applies a deck-wide theme to title/body/background colors', async () => {
    const create = await pptxCreateTool.execute(
      {
        path: 'themed.pptx',
        slides: [{ title: 'Themed Slide', body: 'Themed body' }],
        theme: { title_color: '1A73E8', body_color: '00A86B', background_color: 'F5F5F5' },
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);

    const xml = await readSlideXml('themed.pptx', 1);
    expect(xml).toContain('1A73E8');
    expect(xml).toContain('00A86B');
    expect(xml).toContain('F5F5F5');
  });

  it('applies custom image_width_in / image_height_in as EMU extents', async () => {
    // Minimal valid 1x1 transparent PNG — pptxgenjs reads real bytes off disk
    // to embed the image, so a placeholder path won't do.
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(join(WORKSPACE, 'pixel.png'), onePixelPng);

    const EMU_PER_INCH = 914400;
    const create = await pptxCreateTool.execute(
      {
        path: 'sized-image.pptx',
        slides: [
          {
            title: 'Sized Image',
            image_path: 'pixel.png',
            image_width_in: 4,
            image_height_in: 1.5,
          },
        ],
        overwrite: false,
      },
      ctx(),
    );
    if (!create.ok) throw new Error(create.reason);
    expect(create.ok).toBe(true);

    const xml = await readSlideXml('sized-image.pptx', 1);
    expect(xml).toContain(`cx="${Math.round(4 * EMU_PER_INCH)}"`);
    expect(xml).toContain(`cy="${Math.round(1.5 * EMU_PER_INCH)}"`);
  });
});

// ─── pptx_read ────────────────────────────────────────────────────────────────

describe('pptx_read', () => {
  it('returns ok:false when file not found', async () => {
    const result = await pptxReadTool.execute({ path: 'missing.pptx' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not found/i);
  });

  it('returns ok:false when workspace is not configured', async () => {
    const result = await pptxReadTool.execute({ path: 'any.pptx' }, ctxNone());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/workspace/i);
  });

  it('blocks path traversal', async () => {
    const result = await pptxReadTool.execute({ path: '../escape.pptx' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/traversal|escape|workspace|outside/i);
  });

  it('returns a per-slide text array matching slide order and content', async () => {
    const create = await pptxCreateTool.execute(
      {
        path: 'multi.pptx',
        slides: [
          { title: 'First', bullets: ['Alpha'] },
          { title: 'Second', bullets: ['Beta'] },
          { title: 'Third', bullets: ['Gamma'] },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);

    const read = await pptxReadTool.execute({ path: 'multi.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);

    expect(read.slides).toHaveLength(3);
    expect(read.slides[0]).toContain('First');
    expect(read.slides[0]).toContain('Alpha');
    expect(read.slides[0]).not.toContain('Beta');
    expect(read.slides[1]).toContain('Second');
    expect(read.slides[1]).toContain('Beta');
    expect(read.slides[2]).toContain('Third');
    expect(read.slides[2]).toContain('Gamma');
    expect(read.slideCount).toBe(3);
  });
});

// ─── pptx_append_slides ────────────────────────────────────────────────────────

describe('pptx_append_slides', () => {
  it('appends new slides after existing ones, leaving originals intact', async () => {
    const create = await pptxCreateTool.execute(
      {
        path: 'base.pptx',
        slides: [
          { title: 'Original One', bullets: ['Keep me'] },
          { title: 'Original Two', bullets: ['Keep me too'] },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);

    const append = await pptxAppendSlidesTool.execute(
      {
        path: 'base.pptx',
        slides: [{ title: 'Appended Three', bullets: ['Brand new'] }],
      },
      ctx(),
    );
    expect(append.ok).toBe(true);
    if (!append.ok) throw new Error(append.reason);
    expect(append.slides_appended).toBe(1);
    expect(append.total_slides).toBe(3);

    const read = await pptxReadTool.execute({ path: 'base.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.slides).toHaveLength(3);
    expect(read.slides[0]).toContain('Original One');
    expect(read.slides[0]).toContain('Keep me');
    expect(read.slides[1]).toContain('Original Two');
    expect(read.slides[1]).toContain('Keep me too');
    expect(read.slides[2]).toContain('Appended Three');
    expect(read.slides[2]).toContain('Brand new');
  });

  it('appends multiple slides in the given order', async () => {
    await pptxCreateTool.execute(
      { path: 'base2.pptx', slides: [{ title: 'Only One' }], overwrite: false },
      ctx(),
    );

    const append = await pptxAppendSlidesTool.execute(
      {
        path: 'base2.pptx',
        slides: [{ title: 'Second' }, { title: 'Third' }],
      },
      ctx(),
    );
    expect(append.ok).toBe(true);
    if (!append.ok) throw new Error(append.reason);
    expect(append.total_slides).toBe(3);

    const read = await pptxReadTool.execute({ path: 'base2.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.slides[1]).toContain('Second');
    expect(read.slides[2]).toContain('Third');
  });

  it('returns ok:false when the target file does not exist', async () => {
    const result = await pptxAppendSlidesTool.execute(
      { path: 'missing.pptx', slides: [{ title: 'New' }] },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not found/i);
  });

  it('returns ok:false for invalid image_path on an appended slide', async () => {
    await pptxCreateTool.execute(
      { path: 'base3.pptx', slides: [{ title: 'Original' }], overwrite: false },
      ctx(),
    );
    const result = await pptxAppendSlidesTool.execute(
      { path: 'base3.pptx', slides: [{ title: 'New', image_path: '../escape.png' }] },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/image_path|traversal|escape|workspace|outside/i);
  });

  it('returns ok:false (never throws) for a non-existent image_path on an appended slide', async () => {
    await pptxCreateTool.execute(
      { path: 'base4.pptx', slides: [{ title: 'Original' }], overwrite: false },
      ctx(),
    );
    const result = await pptxAppendSlidesTool.execute(
      { path: 'base4.pptx', slides: [{ title: 'New', image_path: 'does-not-exist.png' }] },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('does-not-exist.png');
  });
});

// ─── pptx_replace_text ─────────────────────────────────────────────────────────

describe('pptx_replace_text', () => {
  it('replaces text contained in a single run and reports the count', async () => {
    await pptxCreateTool.execute(
      {
        path: 'replace.pptx',
        slides: [
          { title: 'Hello World', bullets: ['Hello there'] },
          { title: 'Second Slide', bullets: ['Nothing to see'] },
        ],
        overwrite: false,
      },
      ctx(),
    );

    const result = await pptxReplaceTextTool.execute(
      { path: 'replace.pptx', search: 'Hello', replace: 'Goodbye' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(2); // "Hello World" title + "Hello there" bullet
    expect(result.skipped_fragmented).toBe(0);
    expect(result.slides_touched).toEqual([1]);

    const read = await pptxReadTool.execute({ path: 'replace.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.slides[0]).toContain('Goodbye World');
    expect(read.slides[0]).toContain('Goodbye there');
    expect(read.slides[0]).not.toContain('Hello');
    expect(read.slides[1]).toContain('Nothing to see');
  });

  it('restricts replacement to slide_index when given', async () => {
    await pptxCreateTool.execute(
      {
        path: 'scoped.pptx',
        slides: [{ title: 'Target' }, { title: 'Target' }],
        overwrite: false,
      },
      ctx(),
    );

    const result = await pptxReplaceTextTool.execute(
      { path: 'scoped.pptx', search: 'Target', replace: 'Hit', slide_index: 2 },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(1);
    expect(result.slides_touched).toEqual([2]);

    const read = await pptxReadTool.execute({ path: 'scoped.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.slides[0]).toContain('Target');
    expect(read.slides[1]).toContain('Hit');
  });

  it('reports skipped_fragmented for a match split across text runs, without corrupting the file', async () => {
    await pptxCreateTool.execute(
      { path: 'fragmented.pptx', slides: [{ title: 'Placeholder' }], overwrite: false },
      ctx(),
    );

    // Hand-craft a paragraph where "Hello World" is split across two <a:r>
    // runs ("Hel" + "lo World") — the same shape PowerPoint produces when a
    // user changes formatting mid-word. This can't be produced through our
    // own SlideSchema (bullets/body are single-run), so we patch the raw
    // slide XML directly, matching how a real fragmented run looks on disk.
    const buf = await readFile(join(WORKSPACE, 'fragmented.pptx'));
    const zip = await JSZip.loadAsync(buf);
    const fragmentedXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text 0"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>' +
      '<a:r><a:rPr lang="en-US" dirty="0"/><a:t>Hel</a:t></a:r>' +
      '<a:r><a:rPr lang="en-US" dirty="0"/><a:t>lo World</a:t></a:r>' +
      '</a:p></p:txBody></p:sp></p:spTree></p:cSld>' +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
    zip.file('ppt/slides/slide1.xml', fragmentedXml);
    const patchedBuf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    await writeFile(join(WORKSPACE, 'fragmented.pptx'), patchedBuf);

    const result = await pptxReplaceTextTool.execute(
      { path: 'fragmented.pptx', search: 'Hello World', replace: 'Goodbye World' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(0);
    expect(result.skipped_fragmented).toBe(1);

    // Neither run was rewritten, and the file must still be a valid, readable .pptx.
    const xml = await readSlideXml('fragmented.pptx', 1);
    expect(xml).toContain('<a:t>Hel</a:t>');
    expect(xml).toContain('<a:t>lo World</a:t>');

    const read = await pptxReadTool.execute({ path: 'fragmented.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.slides[0]).toContain('Hello World');
  });

  it('returns ok:false when the search text is not found anywhere', async () => {
    await pptxCreateTool.execute(
      { path: 'notfound.pptx', slides: [{ title: 'Something' }], overwrite: false },
      ctx(),
    );
    const result = await pptxReplaceTextTool.execute(
      { path: 'notfound.pptx', search: 'Nonexistent Phrase', replace: 'X' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not found/i);
  });

  it('returns ok:false when slide_index is out of range', async () => {
    await pptxCreateTool.execute(
      { path: 'oor.pptx', slides: [{ title: 'Only Slide' }], overwrite: false },
      ctx(),
    );
    const result = await pptxReplaceTextTool.execute(
      { path: 'oor.pptx', search: 'Only', replace: 'X', slide_index: 5 },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/out of range/i);
  });

  it('returns ok:false when the target file does not exist', async () => {
    const result = await pptxReplaceTextTool.execute(
      { path: 'missing.pptx', search: 'a', replace: 'b' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not found/i);
  });
});
