// file-text-layer.test.ts — la couche texte sous les outils de fichiers.
//
// Ce qui est prouvé, toujours sur les OCTETS écrits sur le disque, par les vrais
// outils passés par le vrai `executeTool` (vraie base, vraies lignes de lecture
// et d'écriture) :
//
//  1. un remplacement ne change QUE les octets du texte remplacé, quel que soit
//     l'encodage du fichier (windows-1252, UTF-16 LE/BE avec BOM, UTF-8 avec
//     BOM, Shift-JIS, GBK) ;
//  2. lire puis réécrire sans rien changer redonne le fichier octet pour octet,
//     pour chaque encodage × BOM × fins de ligne ;
//  3. ce qui n'est pas du texte est refusé comme texte, en disant ce que c'est ;
//     un texte qui commence par les lettres d'une signature d'image est du texte ;
//  4. un remplacement ne s'applique qu'au contenu que le job a vu ;
//  5. un encodage qui ne s'établit pas est refusé, rien n'est écrit ;
//  6. la même chose par file_edit, file_write et skill_file_write.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import JSZip from 'jszip';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs } from '@nodal-agents/db';
import { executeTool } from '../execute';
import { fileReadTool } from '../builtin/file-ops/file-read';
import { fileWriteTool } from '../builtin/file-ops/file-write';
import { fileEditTool } from '../builtin/file-ops/file-edit';
import { fileSearchTool } from '../builtin/file-ops/file-search';
import { skillFileWriteTool, skillFileReadTool } from '../builtin/skill-ops/skill-files';
import type { ExecuteOptions, ToolContext } from '../types';
import { autonomousRows } from './autonomy-rows-fixture';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let ROOT: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'nodal-text-layer-'));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/** Un run neuf : ce qu'il a vu commence vide. */
async function newJob(): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'a run',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

function ctxOf(jobId: string): ToolContext {
  return {
    jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'work', path: ROOT }],
  };
}

const opts = (): ExecuteOptions => ({
  approvalRules: autonomousRows(seed),
  onApprovalRequired: async () => {},
});

/** Un appel par le vrai seam ; rend la sortie de l'outil. */
async function call<O>(
  tool: { readonly name: string },
  input: Record<string, unknown>,
  jobId: string,
): Promise<O> {
  const result = await executeTool(tool as never, input, ctxOf(jobId), opts());
  if (result.outcome !== 'success') throw new Error(`${tool.name}: ${JSON.stringify(result)}`);
  return result.output as O;
}

const BOMS: Record<string, Buffer> = {
  'utf-8': Buffer.from([0xef, 0xbb, 0xbf]),
  'utf-16le': Buffer.from([0xff, 0xfe]),
  'utf-16be': Buffer.from([0xfe, 0xff]),
};

/** Les octets d'un fichier écrit dans `encoding`, avec ou sans BOM. */
function bytesOf(text: string, encoding: string, bom: boolean): Buffer {
  const body = iconv.encode(text, encoding, { addBOM: false });
  return bom ? Buffer.concat([BOMS[encoding]!, body]) : body;
}

const FRENCH =
  'Nom;Ville;Commentaire\n' +
  'René;Liège;Très bien, à revoir\n' +
  'Zoë;Besançon;Déjà fait — 5 €\n' +
  'Ana;Málaga;Señal recibida, gracias\n';
const JAPANESE =
  '東京都の天気予報です。今日は晴れのち曇り、最高気温は二十度の見込みです。\n' +
  '明日は雨が降るでしょう。傘を忘れないでください。\n' +
  '週末は全国的に晴れる予報となっています。\n';
const CHINESE =
  '今天天气很好，我们去公园散步吧。\n' +
  '明天可能会下雨，记得带伞。\n' +
  '这个周末全国大部分地区都是晴天。\n';

type Case = {
  name: string;
  encoding: string;
  bom: boolean;
  text: string;
  old: string;
  replacement: string;
  /** Le nom sous lequel la couche le reconnaît, quand ce n'est pas `encoding`. */
  detected?: string;
};

const EDIT_CASES: Case[] = [
  {
    name: 'windows-1252 (B05-02)',
    encoding: 'windows-1252',
    bom: false,
    text: FRENCH,
    old: 'Très bien, à revoir',
    replacement: 'Très bien, validé',
  },
  {
    name: 'utf-16le with BOM',
    encoding: 'utf-16le',
    bom: true,
    text: FRENCH,
    old: 'Très bien, à revoir',
    replacement: 'Très bien, validé',
  },
  {
    name: 'utf-16be with BOM',
    encoding: 'utf-16be',
    bom: true,
    text: FRENCH,
    old: 'Très bien, à revoir',
    replacement: 'Très bien, validé',
  },
  {
    name: 'utf-8 with BOM',
    encoding: 'utf-8',
    bom: true,
    text: FRENCH,
    old: 'Très bien, à revoir',
    replacement: 'Très bien, validé',
  },
  {
    name: 'shift_jis',
    encoding: 'shift_jis',
    bom: false,
    text: JAPANESE,
    old: '傘を忘れないでください。',
    replacement: '傘を持って行きましょう。',
  },
  {
    name: 'gbk',
    encoding: 'gbk',
    // GB18030 contient GBK octet pour octet : c'est le nom que le détecteur donne.
    detected: 'gb18030',
    bom: false,
    text: CHINESE,
    old: '记得带伞。',
    replacement: '记得带雨衣。',
  },
];

describe('text layer: an edit changes only the edited bytes @cap:travailler-sur-des-fichiers/moteur', () => {
  for (const c of EDIT_CASES) {
    it(`file_edit on a ${c.name} file: every untouched byte identical, the file keeps its form`, async () => {
      const job = await newJob();
      const original = bytesOf(c.text, c.encoding, c.bom);
      await writeFile(join(ROOT, 'data.txt'), original);

      const read = await call<{ ok: true; content: string; encoding: string }>(
        fileReadTool as never,
        { path: 'data.txt' },
        job,
      );
      // Le modèle lit les VRAIS caractères, pas des U+FFFD.
      expect(read.content).toBe(c.text);
      const name = c.detected ?? c.encoding;
      expect(read.encoding).toBe(c.bom ? `${name}+bom` : name);

      const out = await call<{ ok: boolean }>(
        fileEditTool as never,
        { path: 'data.txt', old_string: c.old, new_string: c.replacement },
        job,
      );
      expect(out.ok).toBe(true);

      const after = await readFile(join(ROOT, 'data.txt'));
      expect(after.equals(bytesOf(c.text.replace(c.old, c.replacement), c.encoding, c.bom))).toBe(
        true,
      );
      // Avant et après le passage remplacé : les octets d'origine, à l'identique.
      const at = original.indexOf(iconv.encode(c.old, c.encoding, { addBOM: false }));
      expect(at).toBeGreaterThan(0);
      const oldLen = iconv.encode(c.old, c.encoding, { addBOM: false }).length;
      const newLen = iconv.encode(c.replacement, c.encoding, { addBOM: false }).length;
      expect(after.subarray(0, at).equals(original.subarray(0, at))).toBe(true);
      expect(after.subarray(at + newLen).equals(original.subarray(at + oldLen))).toBe(true);
    });
  }

  it('a multi-line edit quoted with LF in a CRLF file succeeds and keeps CRLF (B05-22)', async () => {
    const job = await newJob();
    const text = 'line one\r\nline two\r\nline three\r\n';
    await writeFile(join(ROOT, 'win.txt'), Buffer.from(text, 'utf8'));
    const out = await call<{ ok: boolean }>(
      fileEditTool as never,
      { path: 'win.txt', old_string: 'line one\nline two', new_string: 'first\nsecond\nthird' },
      job,
    );
    expect(out.ok).toBe(true);
    expect((await readFile(join(ROOT, 'win.txt'))).toString('utf8')).toBe(
      'first\r\nsecond\r\nthird\r\nline three\r\n',
    );
  });

  it('a quote with CRLF still matches, and in an LF file a CRLF quote matches too', async () => {
    const job = await newJob();
    await writeFile(join(ROOT, 'win.txt'), 'a\r\nb\r\nc\r\n');
    await writeFile(join(ROOT, 'unix.txt'), 'a\nb\nc\n');
    for (const file of ['win.txt', 'unix.txt']) {
      const out = await call<{ ok: boolean }>(
        fileEditTool as never,
        { path: file, old_string: 'b\r\nc', new_string: 'B\nC' },
        job,
      );
      expect(out.ok).toBe(true);
    }
    expect(await readFile(join(ROOT, 'win.txt'), 'utf8')).toBe('a\r\nB\r\nC\r\n');
    expect(await readFile(join(ROOT, 'unix.txt'), 'utf8')).toBe('a\nB\nC\n');
  });

  it('a character the encoding of the file cannot hold is refused, named, and nothing is written', async () => {
    const job = await newJob();
    const original = bytesOf(FRENCH, 'windows-1252', false);
    await writeFile(join(ROOT, 'data.csv'), original);
    const out = await call<{ ok: false; reason: string }>(
      fileEditTool as never,
      { path: 'data.csv', old_string: 'Liège', new_string: 'Liège 東京' },
      job,
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('windows-1252 cannot represent "東", "京"');
    expect((await readFile(join(ROOT, 'data.csv'))).equals(original)).toBe(true);
  });
});

describe('text layer: read then write gives the same bytes @cap:travailler-sur-des-fichiers/moteur', () => {
  const EOLS = {
    lf: 'alpha é\nbeta ü\ngamma à\n',
    crlf: 'alpha é\r\nbeta ü\r\ngamma à\r\n',
    mixed: 'alpha é\r\nbeta ü\ngamma à\r\n',
  };
  const FORMS: Array<{ encoding: string; bom: boolean; declared?: string }> = [
    { encoding: 'utf-8', bom: false },
    { encoding: 'utf-8', bom: true },
    { encoding: 'utf-16le', bom: true },
    { encoding: 'utf-16be', bom: true },
    // Sans BOM, l'UTF-16 ne se devine pas : il se lit et s'écrit quand il est donné.
    { encoding: 'utf-16le', bom: false, declared: 'utf-16le' },
    { encoding: 'windows-1252', bom: false },
  ];
  for (const f of FORMS) {
    for (const [eol, body] of Object.entries(EOLS)) {
      // Un texte assez long pour que l'encodage 8 bits se reconnaisse.
      const text =
        f.encoding === 'windows-1252'
          ? FRENCH.replace(/\n/g, eol === 'lf' ? '\n' : '\r\n') + body
          : body;
      it(`${f.encoding}${f.bom ? '+bom' : ''} × ${eol}: file_read then file_write of the same text is byte-identical`, async () => {
        const job = await newJob();
        const original = bytesOf(text, f.encoding, f.bom);
        await writeFile(join(ROOT, 'round.txt'), original);
        const enc = f.declared === undefined ? {} : { encoding: f.declared };
        const read = await call<{ ok: true; content: string }>(
          fileReadTool as never,
          { path: 'round.txt', ...enc },
          job,
        );
        expect(read.content).toBe(text);
        const out = await call<{ ok: boolean; replaced: boolean }>(
          fileWriteTool as never,
          { path: 'round.txt', content: read.content, ...enc },
          job,
        );
        expect(out).toMatchObject({ ok: true, replaced: true });
        expect((await readFile(join(ROOT, 'round.txt'))).equals(original)).toBe(true);
      });
    }
  }

  it('file_write keeps the form of the existing file when the model writes LF text', async () => {
    const job = await newJob();
    await writeFile(join(ROOT, 'w.txt'), bytesOf('old é\r\nold è\r\n', 'utf-16le', true));
    await call(fileReadTool as never, { path: 'w.txt' }, job);
    await call(fileWriteTool as never, { path: 'w.txt', content: 'new é\nnew è\n' }, job);
    expect(
      (await readFile(join(ROOT, 'w.txt'))).equals(bytesOf('new é\r\nnew è\r\n', 'utf-16le', true)),
    ).toBe(true);
  });

  it('a new file is UTF-8 without BOM, its line endings as given; "encoding" writes another one', async () => {
    const job = await newJob();
    const created = await call<{ ok: boolean; replaced: boolean; encoding: string }>(
      fileWriteTool as never,
      { path: 'new.txt', content: 'é\r\nà\n' },
      job,
    );
    expect(created).toMatchObject({ ok: true, replaced: false, encoding: 'utf-8' });
    expect((await readFile(join(ROOT, 'new.txt'))).equals(Buffer.from('é\r\nà\n', 'utf8'))).toBe(
      true,
    );
    await call(
      fileWriteTool as never,
      { path: 'legacy.txt', content: 'é', encoding: 'cp1252' },
      job,
    );
    expect((await readFile(join(ROOT, 'legacy.txt'))).equals(Buffer.from([0xe9]))).toBe(true);
  });
});

describe('text layer: what is not text is refused as text @cap:travailler-sur-des-fichiers/moteur', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(40, 7),
  ]);
  async function docx(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document/>');
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  it('file_read of a Word document is refused, naming it and the tool that reads it (B06-17)', async () => {
    const job = await newJob();
    await writeFile(join(ROOT, 'report.docx'), await docx());
    const out = await call<{ ok: false; reason: string }>(
      fileReadTool as never,
      { path: 'report.docx' },
      job,
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(
      /^"report\.docx" is not text \(it contains NUL bytes\): it is a Word document \(.*\); read it with docx_read\. Nothing was read\.$/,
    );
  });

  it('file_edit and file_write refuse an image, and its bytes stay as they were', async () => {
    const job = await newJob();
    await writeFile(join(ROOT, 'logo.png'), PNG);
    const edit = await call<{ ok: false; reason: string }>(
      fileEditTool as never,
      { path: 'logo.png', old_string: 'IHDR', new_string: 'XXXX' },
      job,
    );
    expect(edit.reason).toContain(
      '"logo.png" is not text (its signature declares another format): it is an image (image/png',
    );
    expect(edit.reason).toContain('Nothing was written.');
    const write = await call<{ ok: false; reason: string }>(
      fileWriteTool as never,
      { path: 'logo.png', content: 'hello' },
      job,
    );
    expect(write.reason).toContain('it is an image (image/png');
    expect((await readFile(join(ROOT, 'logo.png'))).equals(PNG)).toBe(true);
  });

  it('a PDF with no NUL byte is still not text: file_write does not replace it', async () => {
    const job = await newJob();
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n%'),
      Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]),
      Buffer.from('\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n'),
    ]);
    await writeFile(join(ROOT, 'invoice.pdf'), pdf);
    const write = await call<{ ok: false; reason: string }>(
      fileWriteTool as never,
      { path: 'invoice.pdf', content: 'rewritten' },
      job,
    );
    expect(write.reason).toContain(
      '"invoice.pdf" is not text (its signature declares another format): it is a PDF document',
    );
    expect((await readFile(join(ROOT, 'invoice.pdf'))).equals(pdf)).toBe(true);
  });

  it('file_search does not match inside a binary file', async () => {
    const job = await newJob();
    await writeFile(join(ROOT, 'logo.png'), PNG);
    await writeFile(join(ROOT, 'notes.md'), 'the IHDR chunk\n');
    const out = await call<{ ok: true; matches: Array<{ path: string }> }>(
      fileSearchTool as never,
      { pattern: 'IHDR' },
      job,
    );
    expect(out.matches.map((m) => m.path)).toEqual(['notes.md']);
  });

  it('a text file starting with "BM" is read as text, not taken for an image (B09-04)', async () => {
    const job = await newJob();
    await writeFile(join(ROOT, 'cars.txt'), 'BMW X5 2019 diesel, 120000 km\nBMI,age\n');
    const out = await call<{ ok: true; content: string }>(
      fileReadTool as never,
      { path: 'cars.txt' },
      job,
    );
    expect(out.content).toBe('BMW X5 2019 diesel, 120000 km\nBMI,age\n');
  });
});

describe('text layer: a replacement applies only to the content this job saw @cap:travailler-sur-des-fichiers/moteur', () => {
  it('file_edit: changed from outside since the read → refused, nothing written; read again → applied', async () => {
    const job = await newJob();
    const p = join(ROOT, 'plan.md');
    await writeFile(p, 'step one\nstep two\n');
    await call(fileReadTool as never, { path: 'plan.md' }, job);
    await writeFile(p, 'step one\nstep two\nstep added by someone else\n');

    const refused = await call<{ ok: false; reason: string }>(
      fileEditTool as never,
      { path: 'plan.md', old_string: 'step two', new_string: 'step 2' },
      job,
    );
    expect(refused.reason).toBe(
      '"plan.md" changed since this job last read or wrote it. Nothing was written. ' +
        'Read it again with file_read, then make the change on what it holds now.',
    );
    expect(await readFile(p, 'utf8')).toBe('step one\nstep two\nstep added by someone else\n');
    // Le refus n'a pas « rafraîchi » la vue du job : un nouvel essai sans relire est refusé.
    const again = await call<{ ok: boolean }>(
      fileEditTool as never,
      { path: 'plan.md', old_string: 'step two', new_string: 'step 2' },
      job,
    );
    expect(again.ok).toBe(false);

    await call(fileReadTool as never, { path: 'plan.md' }, job);
    const applied = await call<{ ok: boolean }>(
      fileEditTool as never,
      { path: 'plan.md', old_string: 'step two', new_string: 'step 2' },
      job,
    );
    expect(applied.ok).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('step one\nstep 2\nstep added by someone else\n');
  });

  it('file_write over a file changed since the read → refused; its own writes count as seen', async () => {
    const job = await newJob();
    const p = join(ROOT, 'notes.txt');
    await writeFile(p, 'v1\n');
    await call(fileReadTool as never, { path: 'notes.txt' }, job);
    // Ce que le job écrit lui-même, il l'a vu : deux écritures de suite passent.
    await call(fileWriteTool as never, { path: 'notes.txt', content: 'v2\n' }, job);
    await call(
      fileEditTool as never,
      { path: 'notes.txt', old_string: 'v2', new_string: 'v3' },
      job,
    );
    expect(await readFile(p, 'utf8')).toBe('v3\n');

    await writeFile(p, 'edited in an editor\n');
    const refused = await call<{ ok: false; reason: string }>(
      fileWriteTool as never,
      { path: 'notes.txt', content: 'v4\n' },
      job,
    );
    expect(refused.reason).toContain('"notes.txt" changed since this job last read or wrote it');
    expect(await readFile(p, 'utf8')).toBe('edited in an editor\n');
  });

  it('a file this job never read keeps the overwrite rule of before', async () => {
    const job = await newJob();
    await writeFile(join(ROOT, 'other.txt'), 'there before\n');
    const out = await call<{ ok: boolean; replaced: boolean }>(
      fileWriteTool as never,
      { path: 'other.txt', content: 'replaced\n' },
      job,
    );
    expect(out).toMatchObject({ ok: true, replaced: true });
    expect(await readFile(join(ROOT, 'other.txt'), 'utf8')).toBe('replaced\n');
  });

  it('what another job read does not count for this one', async () => {
    const first = await newJob();
    const second = await newJob();
    const p = join(ROOT, 'shared.txt');
    await writeFile(p, 'a\n');
    await call(fileReadTool as never, { path: 'shared.txt' }, first);
    await writeFile(p, 'b\n');
    // Le second job n'a rien lu : règle d'avant. Le premier a vu « a » : refusé.
    expect(
      (
        await call<{ ok: boolean }>(
          fileEditTool as never,
          { path: 'shared.txt', old_string: 'b', new_string: 'c' },
          second,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await call<{ ok: boolean }>(
          fileEditTool as never,
          { path: 'shared.txt', old_string: 'c', new_string: 'd' },
          first,
        )
      ).ok,
    ).toBe(false);
    expect(await readFile(p, 'utf8')).toBe('c\n');
  });
});

describe('text layer: an encoding that cannot be determined is refused @cap:travailler-sur-des-fichiers/moteur', () => {
  // Des octets sans NUL, invalides en UTF-8, et qu'aucun encodage ne reconnaît
  // avec confiance.
  const NOISE = Buffer.from([0x41, 0x81, 0x8d, 0x8f, 0x90, 0x9d, 0x42, 0x81, 0x8d, 0x0a]);

  it('file_read, file_edit and file_write refuse it, and nothing is written', async () => {
    const job = await newJob();
    const p = join(ROOT, 'odd.txt');
    await writeFile(p, NOISE);
    const read = await call<{ ok: false; reason: string }>(
      fileReadTool as never,
      { path: 'odd.txt' },
      job,
    );
    expect(read.reason).toContain(
      '"odd.txt" cannot be used as text: its encoding could not be determined with confidence',
    );
    expect(read.reason).toContain('call again with "encoding"');
    const edit = await call<{ ok: false; reason: string }>(
      fileEditTool as never,
      { path: 'odd.txt', old_string: 'A', new_string: 'Z' },
      job,
    );
    expect(edit.reason).toContain('Nothing was written.');
    const write = await call<{ ok: false; reason: string }>(
      fileWriteTool as never,
      { path: 'odd.txt', content: 'Z' },
      job,
    );
    expect(write.ok).toBe(false);
    expect((await readFile(p)).equals(NOISE)).toBe(true);
  });

  it('file_search names it in not_searched instead of searching it as UTF-8', async () => {
    const job = await newJob();
    await writeFile(join(ROOT, 'odd.txt'), NOISE);
    const out = await call<{ ok: true; not_searched?: string[] }>(
      fileSearchTool as never,
      { pattern: 'A' },
      job,
    );
    expect(out.not_searched).toEqual(['odd.txt']);
  });
});

describe('text layer: skill_file_write goes through the same layer @cap:travailler-sur-des-fichiers/moteur', () => {
  it('rewrites an existing windows-1252 CRLF skill file in its own form, and reads it decoded', async () => {
    const store = join(ROOT, 'skills');
    await mkdir(join(store, 'my-skill'), { recursive: true });
    const p = join(store, 'my-skill', 'notes.txt');
    await writeFile(p, bytesOf(FRENCH.replace(/\n/g, '\r\n'), 'windows-1252', false));
    const ctx: ToolContext = {
      ...ctxOf(await newJob()),
      skillStoreDir: store,
      assignedSkillSlugs: ['my-skill'],
      fileWritableSkillSlugs: ['my-skill'],
    };
    const read = await skillFileReadTool.execute({ skill: 'my-skill', path: 'notes.txt' }, ctx);
    expect(read).toMatchObject({ ok: true, encoding: 'windows-1252' });
    const next = FRENCH.replace('à revoir', 'validé');
    const out = await skillFileWriteTool.execute(
      { skill: 'my-skill', path: 'notes.txt', content: next, purpose: 'Mark the row as done.' },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(
      (await readFile(p)).equals(bytesOf(next.replace(/\n/g, '\r\n'), 'windows-1252', false)),
    ).toBe(true);
  });
});
