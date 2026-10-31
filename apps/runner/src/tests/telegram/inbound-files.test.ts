// inbound-files.test.ts — les fichiers envoyés à un agent sur Telegram arrivent
// jusqu'à lui (#899) : écrits sur le disque sous leur nom d'origine, et nommés
// dans le premier message de son job ; un fichier qui n'a pas pu être obtenu y
// est dit, jamais abandonné.
//
// Le parcours réel, de la mise à jour Telegram au disque : handleTelegramUpdate
// (la base de test) puis attachInboundFiles. Seul le Bot API est remplacé
// (getTelegramFile) ; le disque est un vrai dossier temporaire.

import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelMessage } from 'ai';
import { createLlmClient } from '@nodal-agents/llm';
import type { NodalLlmClient } from '@nodal-agents/llm';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agentJobs,
  channelAllowedConversations,
  conversationHandleFor,
  conversations,
  telegramAllowedChats,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  createToolRegistry,
  executeTool,
  registerBuiltins,
  resolveRunWorkspaces,
} from '@nodal-agents/tools';
import type { ModelImageInput, ToolContext } from '@nodal-agents/tools';
import type { TelegramUpdate } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import { hydrateForLlm } from '../../job/model-images.ts';
import { addressedByHandle } from '../../llm/addressed-by-handle.ts';

// Provider calls leave through packages/llm's own transport (#609): routed to
// the global fetch stubbed in `wireBody`, the network boundary.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

/** Ce que le Bot API rend pour chaque file_id : des octets, ou une erreur. */
const telegramFiles = new Map<string, Uint8Array | Error>();

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getTelegramFile: vi.fn(async (_token: string, fileId: string) => {
      const found = telegramFiles.get(fileId);
      if (found === undefined) throw new Error(`test: no stub for file_id ${fileId}`);
      if (found instanceof Error) throw found;
      return { bytes: found, ext: 'bin' };
    }),
  };
});

import { handleTelegramUpdate, attachInboundFiles } from '../../telegram/handler.ts';
import {
  receiveInboundFiles,
  safeFileName,
  pruneInboundFolder,
} from '../../channels/inbound-files.ts';
import { pruneJobMediaFiles } from '../../cron/prune-media.ts';
import { attachInboundImage } from '../../channels/discord/handler.ts';

const CHAT = 4242;
let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let root: string;
const previousRoot = process.env['NODALAI_WORKSPACES_ROOT'];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-inbound-files-'));
  process.env['NODALAI_WORKSPACES_ROOT'] = root;
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

afterAll(async () => {
  if (previousRoot === undefined) delete process.env['NODALAI_WORKSPACES_ROOT'];
  else process.env['NODALAI_WORKSPACES_ROOT'] = previousRoot;
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  telegramFiles.clear();
  await db.delete(agentJobs);
  await db.delete(conversations);
  await db.delete(telegramAllowedChats);
  await db.insert(telegramAllowedChats).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: String(CHAT),
      role: 'owner',
      status: 'active',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '-100777',
      role: 'member',
      status: 'active',
    },
  ]);
});

type Msg = NonNullable<TelegramUpdate['message']>;

function update(fields: Partial<Msg>, chat: Msg['chat'] = { id: CHAT, type: 'private' }) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat,
      from: { id: 7, first_name: 'Quentin', is_bot: false },
      ...fields,
    },
  } satisfies TelegramUpdate;
}

/** Une mise à jour, de bout en bout : le job créé, puis ses fichiers reçus. */
async function deliver(u: TelegramUpdate) {
  const result = await handleTelegramUpdate({
    update: u,
    receivingAgentId: seed.agentId,
    receivingAgentEntityId: seed.entityId,
    receivingAgentBotUsername: 'nodal_bot',
    tx: db as unknown as RunnerDeps['db'],
  });
  expect(result.jobId).toBeDefined();
  const jobId = result.jobId!;
  expect(result.files).toBeDefined();
  const outcomes = await attachInboundFiles({
    jobId,
    entityId: seed.entityId,
    botToken: '123:fake',
    inbound: result.files!,
    db: db as unknown as RunnerDeps['db'],
  });
  const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
  const messages = job!.messages as Array<{ role: string; content: unknown }>;
  expect(messages).toHaveLength(1);
  expect(messages[0]!.role).toBe('user');
  const parts = messages[0]!.content as Array<{ type: string; text?: string; image?: string }>;
  return { jobId, job: job!, parts, outcomes };
}

/** Le dossier d'arrivée de Telegram : un dossier par job, aucune adresse de chat (#910). */
function telegramFolder(): string {
  return join(root, seed.entityId, 'shared', 'telegram');
}

const PDF = new Uint8Array(Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n'));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);

describe('Telegram files reach the agent (#899) @cap:parler-par-canal-externe/moteur', () => {
  it('a PDF with a caption: written under its own name, named in the job beside the caption', async () => {
    telegramFiles.set('pdf-1', PDF);
    const { jobId, job, parts } = await deliver(
      update({
        caption: 'Range moi ça , merci',
        document: {
          file_id: 'pdf-1',
          file_name: 'Facture EDF.pdf',
          mime_type: 'application/pdf',
          file_size: PDF.byteLength,
        },
      }),
    );

    const onDisk = join(telegramFolder(), jobId, 'Facture EDF.pdf');
    expect(new Uint8Array(await readFile(onDisk))).toEqual(PDF);

    expect(job.task).toBe('Range moi ça , merci');
    expect(parts[0]).toEqual({ type: 'text', text: 'Range moi ça , merci' });
    expect(parts).toHaveLength(2);
    const note = parts[1]!.text!;
    expect(parts[1]!.type).toBe('text');
    expect(note).toContain(`shared/telegram/${jobId}/Facture EDF.pdf`);
    expect(note).toContain(onDisk);
    expect(note).toContain('"Facture EDF.pdf"');
    expect(note).toContain('application/pdf');
    expect(note).toContain(`${PDF.byteLength} B`);
    // Un PDF n'est pas une image : aucune partie image.
    expect(parts.some((p) => p.type === 'image')).toBe(false);
  });

  it.each([
    {
      kind: 'audio',
      fields: {
        audio: { file_id: 'a-1', file_name: 'memo.mp3', mime_type: 'audio/mpeg', file_size: 4 },
      },
      bytes: new Uint8Array([0x49, 0x44, 0x33, 4]),
      saved: 'memo.mp3',
      type: 'audio/mpeg',
    },
    {
      // Un message vocal n'a pas de nom : il prend celui de son type.
      kind: 'voice',
      fields: { voice: { file_id: 'v-1', mime_type: 'audio/ogg', file_size: 4 } },
      bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
      saved: 'audio.ogg',
      type: 'audio/ogg',
    },
    {
      kind: 'video',
      fields: {
        video: { file_id: 'vd-1', file_name: 'clip.mov', mime_type: 'video/quicktime' },
      },
      bytes: new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74]),
      saved: 'clip.mov',
      type: 'video/quicktime',
    },
    {
      // Une vidéo ronde : ni nom ni type déclarés, toujours du MP4.
      kind: 'video_note',
      fields: { video_note: { file_id: 'vn-1', file_size: 3 } },
      bytes: new Uint8Array([1, 2, 3]),
      saved: 'video.mp4',
      type: 'video/mp4',
    },
    {
      // Telegram envoie une animation AUSSI comme document, même file_id : un seul fichier.
      kind: 'animation',
      fields: {
        animation: { file_id: 'an-1', file_name: 'dance.mp4', mime_type: 'video/mp4' },
        document: { file_id: 'an-1', file_name: 'dance.mp4', mime_type: 'video/mp4' },
      },
      bytes: new Uint8Array([9, 9, 9]),
      saved: 'dance.mp4',
      type: 'video/mp4',
    },
  ])('$kind: written with its bytes, named in the job', async ({ fields, bytes, saved, type }) => {
    for (const ref of Object.values(fields)) telegramFiles.set(ref.file_id, bytes);
    const { jobId, parts } = await deliver(update({ caption: 'tiens', ...fields }));

    expect(new Uint8Array(await readFile(join(telegramFolder(), jobId, saved)))).toEqual(bytes);
    expect(await readdir(join(telegramFolder(), jobId))).toEqual([saved]);
    expect(parts[0]).toEqual({ type: 'text', text: 'tiens' });
    const notes = parts.slice(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain(`shared/telegram/${jobId}/${saved}`);
    expect(notes[0]!.text).toContain(type);
  });

  it('a file with no caption still becomes a job, with a neutral task and its file part', async () => {
    telegramFiles.set('pdf-2', PDF);
    const { jobId, job, parts } = await deliver(
      update({
        document: { file_id: 'pdf-2', file_name: 'contrat.pdf', mime_type: 'application/pdf' },
      }),
    );
    expect(job.task).toBe('Fichier envoyé (sans légende).');
    expect(parts[0]).toEqual({ type: 'text', text: 'Fichier envoyé (sans légende).' });
    expect(parts[1]!.text).toContain(`shared/telegram/${jobId}/contrat.pdf`);
    expect(new Uint8Array(await readFile(join(telegramFolder(), jobId, 'contrat.pdf')))).toEqual(
      PDF,
    );
  });

  it('in a group, a file whose caption is only the bot mention still becomes a job', async () => {
    telegramFiles.set('pdf-3', PDF);
    const { jobId, parts } = await deliver(
      update(
        {
          caption: '@nodal_bot',
          document: { file_id: 'pdf-3', file_name: 'devis.pdf', mime_type: 'application/pdf' },
        },
        { id: -100777, type: 'group' },
      ),
    );
    expect(parts[0]!.text).toBe('[Message from Quentin]: Fichier envoyé (sans légende).');
    expect(parts[1]!.text).toContain(`shared/telegram/${jobId}/devis.pdf`);
  });

  it('a download that fails: the job exists, and a part names the file and the reason', async () => {
    telegramFiles.set('broken', new Error('telegram_request_failed: file download HTTP 502'));
    const { jobId, parts, outcomes } = await deliver(
      update({
        caption: 'voici',
        document: { file_id: 'broken', file_name: 'rapport.docx', file_size: 2048 },
      }),
    );
    expect(parts).toHaveLength(2);
    expect(parts[1]!.text).toContain('NOT received');
    expect(parts[1]!.text).toContain('"rapport.docx"');
    expect(parts[1]!.text).toContain('file download HTTP 502');
    expect(outcomes).toEqual([
      {
        received: false,
        name: 'rapport.docx',
        mediaType: null,
        size: 2048,
        reason: 'telegram_request_failed: file download HTTP 502',
      },
    ]);
    await expect(readdir(join(telegramFolder(), jobId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a file over the Bot API 20 MB limit: said with its size, never fetched', async () => {
    // Pas de stub pour ce file_id : un appel au Bot API lèverait « no stub »,
    // et la raison dite serait celle-là, pas la limite.
    const { parts } = await deliver(
      update({
        caption: 'la vidéo',
        video: {
          file_id: 'huge',
          file_name: 'vacances.mp4',
          mime_type: 'video/mp4',
          file_size: 48 * 1024 * 1024,
        },
      }),
    );
    const note = parts[1]!.text!;
    expect(note).toContain('NOT received');
    expect(note).toContain('"vacances.mp4"');
    expect(note).toContain('Telegram lets a bot download files up to 20.0 MiB');
    expect(note).toContain('48.0 MiB');
    expect(note).not.toContain('no stub');
  });

  it('a photo keeps its image part (the file: URL of the saved JPEG), plus its file part', async () => {
    telegramFiles.set('big', JPEG);
    const { jobId, parts } = await deliver(
      update({
        photo: [
          { file_id: 'small', width: 90, height: 90 },
          { file_id: 'big', width: 1280, height: 1280 },
        ],
      }),
    );
    const onDisk = join(telegramFolder(), jobId, 'image.jpg');
    expect(new Uint8Array(await readFile(onDisk))).toEqual(JPEG);
    expect(parts[0]).toEqual({ type: 'text', text: 'Image envoyée (sans légende).' });
    expect(parts[1]!.text).toContain(`shared/telegram/${jobId}/image.jpg`);
    expect(parts[2]).toEqual({ type: 'image', image: pathToFileURL(onDisk).href });
  });

  it('an image sent as a document gets an image part too: its bytes decide, not its kind', async () => {
    telegramFiles.set('png-doc', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { jobId, parts } = await deliver(
      update({ caption: 'en qualité', document: { file_id: 'png-doc', file_name: 'scan' } }),
    );
    // Sans extension, le nom prend celle de son type.
    const onDisk = join(telegramFolder(), jobId, 'scan.png');
    expect(parts[2]).toEqual({ type: 'image', image: pathToFileURL(onDisk).href });
  });

  // Revue de #902 (F2) : le chemin nu n'était lu comme un fichier que s'il
  // finissait par une extension de 2 à 5 caractères ; `capture.20261031` en a
  // une de 8, et l'image tombait en « illisible » avant le modèle.
  it('an image whose name ends in an extension of any length reaches the model, in the request body', async () => {
    const PNG = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...Buffer.from('a capture of a bill'),
    ]);
    telegramFiles.set('capture', PNG);
    const { job, parts } = await deliver(
      update({
        caption: 'range-la',
        document: { file_id: 'capture', file_name: 'capture.20261031' },
      }),
    );
    expect(parts[1]!.text).toContain('/capture.20261031');

    const hydrated = await hydrateForLlm(job.messages as ModelMessage[], { sees: true }, new Map());
    const body = await wireBody(hydrated);
    const b64 = Buffer.from(PNG).toString('base64');
    expect(body).toContain(
      `"type":"image","source":{"type":"base64","media_type":"image/png","data":"${b64}"}`,
    );
    expect(body).not.toContain('holds no image Nodal can read');
  });

  it('a job already claimed while the file downloaded keeps its transcript (G1), the file stays on disk', async () => {
    telegramFiles.set('late', PDF);
    const result = await handleTelegramUpdate({
      update: update({
        caption: 'tard',
        document: { file_id: 'late', file_name: 'tard.pdf', mime_type: 'application/pdf' },
      }),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'nodal_bot',
      tx: db as unknown as RunnerDeps['db'],
    });
    const jobId = result.jobId!;
    await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, jobId));
    const [before] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));

    await attachInboundFiles({
      jobId,
      entityId: seed.entityId,
      botToken: '123:fake',
      inbound: result.files!,
      db: db as unknown as RunnerDeps['db'],
    });

    const [after] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    expect(after!.messages).toEqual(before!.messages);
    expect(await readdir(join(telegramFolder(), jobId))).toEqual(['tard.pdf']);
  });
});

describe('receiveInboundFiles — never overwrites @cap:parler-par-canal-externe/moteur', () => {
  it('two files of the same name in one message: both kept, the second suffixed', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 't',
        chatId: '1',
        status: 'pending',
        messages: [{ role: 'user', content: 't' }],
      })
      .returning({ id: agentJobs.id });
    const first = new Uint8Array([1, 1, 1]);
    const second = new Uint8Array([2, 2, 2]);
    const { outcomes } = await receiveInboundFiles({
      db: db as unknown as RunnerDeps['db'],
      jobId: job!.id,
      entityId: seed.entityId,
      channel: 'telegram',
      text: 't',
      files: [
        { name: 'Facture.pdf', mediaType: 'application/pdf', size: 3, download: async () => first },
        {
          name: 'Facture.pdf',
          mediaType: 'application/pdf',
          size: 3,
          download: async () => second,
        },
      ],
    });
    const dir = join(telegramFolder(), job!.id);
    expect((await readdir(dir)).sort()).toEqual(['Facture (2).pdf', 'Facture.pdf']);
    expect(new Uint8Array(await readFile(join(dir, 'Facture.pdf')))).toEqual(first);
    expect(new Uint8Array(await readFile(join(dir, 'Facture (2).pdf')))).toEqual(second);
    expect(outcomes.map((o) => (o.received ? o.workspacePath : null))).toEqual([
      `shared/telegram/${job!.id}/Facture.pdf`,
      `shared/telegram/${job!.id}/Facture (2).pdf`,
    ]);
  });

  // Revue de #902 (F1) : sous Windows, une écriture vers `con .txt` part dans
  // la console et ne laisse rien sur le disque, alors que le job disait « Saved ».
  it.each([
    'con .txt',
    'nul .pdf',
    'aux .mp3',
    'com1 .docx',
    'conin$.log',
    'conout$ .txt',
    'CONOUT$',
  ])(
    'a file named like a Windows device (%j) is written, with its bytes, under a name that is not one',
    async (name) => {
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram',
          task: 't',
          chatId: '3',
          status: 'pending',
        })
        .returning({ id: agentJobs.id });
      const bytes = new Uint8Array(Buffer.from(`content of ${name}`));
      const { outcomes } = await receiveInboundFiles({
        db: db as unknown as RunnerDeps['db'],
        jobId: job!.id,
        entityId: seed.entityId,
        channel: 'telegram',
        text: 't',
        files: [{ name, mediaType: null, size: bytes.byteLength, download: async () => bytes }],
      });
      const dir = join(telegramFolder(), job!.id);
      expect(await readdir(dir)).toEqual([`_${name}`]);
      expect(new Uint8Array(await readFile(join(dir, `_${name}`)))).toEqual(bytes);
      expect(outcomes[0]).toMatchObject({ received: true, path: join(dir, `_${name}`) });
    },
  );

  // CLOCK$ n'est dans aucune liste de Microsoft : il garde son nom, et son
  // écriture réelle (sur la CI Windows aussi) laisse bien le fichier et ses octets.
  it.each(['CLOCK$', 'clock$.txt', 'conin$x.txt'])(
    'a name Windows does not resolve to a device (%j) keeps its name, and its bytes land on disk',
    async (name) => {
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram',
          task: 't',
          chatId: '4',
          status: 'pending',
        })
        .returning({ id: agentJobs.id });
      const bytes = new Uint8Array(Buffer.from(`content of ${name}`));
      await receiveInboundFiles({
        db: db as unknown as RunnerDeps['db'],
        jobId: job!.id,
        entityId: seed.entityId,
        channel: 'telegram',
        text: 't',
        files: [{ name, mediaType: null, size: bytes.byteLength, download: async () => bytes }],
      });
      const dir = join(telegramFolder(), job!.id);
      expect(await readdir(dir)).toEqual([name]);
      expect(new Uint8Array(await readFile(join(dir, name)))).toEqual(bytes);
    },
  );

  it('a file already in the folder under the same name is not overwritten', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 't',
        chatId: '2',
        status: 'pending',
      })
      .returning({ id: agentJobs.id });
    const dir = join(telegramFolder(), job!.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'notes.txt'), 'already here');
    await receiveInboundFiles({
      db: db as unknown as RunnerDeps['db'],
      jobId: job!.id,
      entityId: seed.entityId,
      channel: 'telegram',
      text: 't',
      files: [
        {
          name: 'NOTES.txt',
          mediaType: 'text/plain',
          size: 3,
          download: async () => new Uint8Array(Buffer.from('new')),
        },
      ],
    });
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('already here');
    const names = await readdir(dir);
    expect(names).toHaveLength(2);
    const added = names.find((n) => n !== 'notes.txt')!;
    expect(await readFile(join(dir, added), 'utf8')).toBe('new');
  });
});

/** The body the Anthropic builder sends for these messages; nothing is downloaded. */
async function wireBody(messages: ModelMessage[]): Promise<string> {
  const bodies: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string')
        throw new Error(`a download was attempted: ${String(input)}`);
      bodies.push(init.body);
      return new Response(JSON.stringify({ error: { message: 'stub' } }), { status: 400 });
    }),
  );
  try {
    await createLlmClient({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' })
      .generateText({ system: 's', messages })
      .catch(() => undefined);
  } finally {
    vi.unstubAllGlobals();
  }
  const body = bodies[0];
  if (body === undefined) throw new Error('no request was sent');
  return body;
}

describe('safeFileName — a name every OS accepts, as close to the original as possible', () => {
  it.each([
    ['Facture EDF.pdf', 'application/pdf', 'Facture EDF.pdf'],
    ['Résumé été.docx', null, 'Résumé été.docx'],
    // Un nom ne remonte jamais l'arborescence.
    ['../../etc/passwd', null, 'passwd'],
    ['..\\..\\Windows\\win.ini', null, 'win.ini'],
    ['a<b>c:d"e|f?g*h.txt', null, 'a_b_c_d_e_f_g_h.txt'],
    ['trailing dots...', null, 'trailing dots'],
    ['CON', null, '_CON'],
    ['nul.txt', null, '_nul.txt'],
    ['com1.pdf', null, '_com1.pdf'],
    ['console.log', null, 'console.log'],
    // Windows retire l'espace avant le point : ces noms SONT des périphériques (revue de #902).
    ['con .txt', null, '_con .txt'],
    ['nul .pdf', null, '_nul .pdf'],
    ['aux .mp3', null, '_aux .mp3'],
    ['com1 .docx', null, '_com1 .docx'],
    ['LPT¹.txt', null, '_LPT¹.txt'],
    ['conin$.log', null, '_conin$.log'],
    ['conout$ .txt', null, '_conout$ .txt'],
    ['CONOUT$', null, '_CONOUT$'],
    ['conin$x.txt', null, 'conin$x.txt'],
    ['CLOCK$', null, 'CLOCK$'],
    ['context .txt', null, 'context .txt'],
    ['', 'image/jpeg', 'image.jpg'],
    [null, 'audio/ogg', 'audio.ogg'],
    [null, null, 'file'],
    ['..', null, 'file'],
    ['scan', 'image/png', 'scan.png'],
    ['invoice‮fdp.exe', null, 'invoicefdp.exe'],
    ['a\u0000b\nc.txt', null, 'abc.txt'],
  ])('%j (%s) → %j', (raw, type, expected) => {
    expect(safeFileName(raw, type)).toBe(expected);
  });

  it('cuts a long name to 150 UTF-8 bytes, keeping its extension and whole characters', () => {
    const name = safeFileName(`${'é'.repeat(200)}.pdf`, null);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(150);
    expect(name).toBe(`${'é'.repeat(73)}.pdf`);
  });
});

describe('pruneInboundFolder / pruneJobMediaFiles — a folder per job (#899)', () => {
  it('keeps the folder of a live job and of a name it did not write; removes an old finished one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nodal-inbound-prune-'));
    try {
      const [live] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram',
          task: 'l',
          status: 'pending',
        })
        .returning({ id: agentJobs.id });
      const [done] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram',
          task: 'd',
          status: 'completed',
        })
        .returning({ id: agentJobs.id });
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      for (const name of [live!.id, done!.id, 'Classement']) {
        await mkdir(join(dir, name));
        await writeFile(join(dir, name, 'x.pdf'), 'x');
        await utimes(join(dir, name), old, old);
      }

      await pruneInboundFolder(dir, db as unknown as RunnerDeps['db']);

      expect((await readdir(dir)).sort()).toEqual([live!.id, 'Classement'].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the retention cron removes the folder of a pruned job with its files', async () => {
    const cronRoot = await mkdtemp(join(tmpdir(), 'nodal-inbound-cron-'));
    try {
      const pruned = '11111111-1111-4111-8111-111111111111';
      const kept = '22222222-2222-4222-8222-222222222222';
      const chat = join(cronRoot, 'entity-1', 'shared', 'telegram', '42');
      for (const id of [pruned, kept]) {
        await mkdir(join(chat, id), { recursive: true });
        await writeFile(join(chat, id, 'a.pdf'), 'a');
        await writeFile(join(chat, id, 'b.ogg'), 'b');
      }

      const result = await pruneJobMediaFiles(cronRoot, [pruned]);

      expect(result.filesDeleted).toBe(2);
      expect(await readdir(chat)).toEqual([kept]);
      expect((await readdir(join(chat, kept))).sort()).toEqual(['a.pdf', 'b.ogg']);
    } finally {
      await rm(cronRoot, { recursive: true, force: true });
    }
  });
});

// #910 : les fichiers reçus vivent sous <shared>/<canal>/<jobId>/ (Discord :
// <shared>/discord/<jobId>.<ext>), et ce qui a été écrit avant, un niveau plus
// bas sous l'adresse de la conversation, se vide toujours.
//
// Mutations vérifiées : `pruneInboundFolder` qui ne descend plus dans les
// sous-dossiers → « the old conversation folders » rougit ; le cron qui ne lit
// plus les entrées du dossier du canal lui-même → « the retention cron, both
// layouts » rougit.
describe('the inbound folder of a channel, keyed by job, and the layout before it (#910) @cap:parler-par-canal-externe/moteur', () => {
  async function jobWith(status: string): Promise<string> {
    const [row] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 't',
        status,
      })
      .returning({ id: agentJobs.id });
    return row!.id;
  }
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  async function oldFolder(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'x.pdf'), 'x');
    await utimes(path, old, old);
  }
  async function oldFile(path: string): Promise<void> {
    await writeFile(path, 'x');
    await utimes(path, old, old);
  }

  it('the old conversation folders are pruned like the channel folder, and nothing deeper', async () => {
    const channel = await mkdtemp(join(tmpdir(), 'nodal-inbound-channel-'));
    try {
      const live = await jobWith('pending');
      const done = await jobWith('completed');
      const alsoDone = await jobWith('failed');
      const deepDone = await jobWith('completed');
      // Le dossier du canal (depuis #910).
      await oldFolder(join(channel, done));
      await oldFolder(join(channel, live));
      // Un fil d'avant #910, avec ses deux formes d'entrée, et un dossier de l'agent.
      const chat = join(channel, '4242');
      await mkdir(chat);
      await oldFolder(join(chat, alsoDone));
      await oldFile(join(chat, `${done}.jpg`));
      await oldFolder(join(chat, live));
      await oldFolder(join(chat, 'Archives', deepDone));

      await pruneInboundFolder(channel, db as unknown as RunnerDeps['db']);

      expect((await readdir(channel)).sort()).toEqual(['4242', live].sort());
      expect((await readdir(chat)).sort()).toEqual(['Archives', live].sort());
      expect(await readdir(join(chat, 'Archives'))).toEqual([deepDone]);
    } finally {
      await rm(channel, { recursive: true, force: true });
    }
  });

  it('the retention cron, both layouts: a pruned job leaves nothing, at either level', async () => {
    const cronRoot = await mkdtemp(join(tmpdir(), 'nodal-inbound-cron-'));
    try {
      const pruned = '11111111-1111-4111-8111-111111111111';
      const kept = '22222222-2222-4222-8222-222222222222';
      const shared = join(cronRoot, 'entity-1', 'shared');
      const legacyChat = join(shared, 'telegram', '42');
      const legacyChannel = join(shared, 'discord', '998877');
      for (const id of [pruned, kept]) {
        await mkdir(join(shared, 'telegram', id), { recursive: true });
        await writeFile(join(shared, 'telegram', id, 'a.pdf'), 'a');
        await mkdir(join(legacyChat, id), { recursive: true });
        await writeFile(join(legacyChat, id, 'b.pdf'), 'b');
        await mkdir(legacyChannel, { recursive: true });
        await writeFile(join(shared, 'discord', `${id}.png`), 'p');
        await writeFile(join(legacyChannel, `${id}.png`), 'p');
      }

      const result = await pruneJobMediaFiles(cronRoot, [pruned]);

      expect(result.filesDeleted).toBe(4);
      expect((await readdir(join(shared, 'telegram'))).sort()).toEqual(['42', kept].sort());
      expect(await readdir(join(shared, 'telegram', kept))).toEqual(['a.pdf']);
      expect(await readdir(legacyChat)).toEqual([kept]);
      expect((await readdir(join(shared, 'discord'))).sort()).toEqual(
        ['998877', `${kept}.png`].sort(),
      );
      expect(await readdir(legacyChannel)).toEqual([`${kept}.png`]);
    } finally {
      await rm(cronRoot, { recursive: true, force: true });
    }
  });
});

// ─── #910 : le chemin que lit le MODÈLE est celui du disque ───────────────────
//
// Le 31/10, le PDF était écrit sous shared/telegram/<chat id>/<jobId>/, et le
// modèle lisait shared/telegram/conv_<handle>/<jobId>/ : la frontière vers le
// fournisseur (`addressedByHandle`, #824) remplace chaque identifiant de
// conversation connu par son handle dans TOUT ce que le modèle lit, et rien ne
// relit les entrées des outils. Trois `file_read` en « File not found ».
//
// Le parcours entier, pour chaque canal qui écrit des fichiers reçus : la
// réception réelle, puis la requête TELLE QUE LE FOURNISSEUR LA REÇOIT (la vraie
// frontière, au-dessus d'un client qui ne fait que la garder), puis les VRAIS
// outils fichiers (registre, `executeTool`, dossiers du run), appelés avec
// exactement le chemin que le modèle a lu.
//
// Mutation vérifiée : remettre l'adresse de la conversation dans le chemin
// (`inboundFolder` et `workspaceFolder`, ou le dossier de Discord) → chaque cas
// rougit, sur « File not found ».

const DISCORD_CHANNEL = '998877665544332211';

/**
 * Le chemin d'une image qu'un modèle ne voit pas, dans sa note
 * (`visionRoutingNote`). La note dit aujourd'hui « saved at saved at » : la
 * phrase et son `where` portent chacun les mots.
 */
const ROUTING_NOTE_PATH = /IMAGE \((?:saved at )+(.+?)\)\. It was not passed to you/;

/** La requête que le fournisseur reçoit : `hydrateForLlm` puis la frontière des handles. */
async function requestAsTheProviderGetsIt(
  messages: ModelMessage[],
  input: ModelImageInput,
): Promise<{ system: string; text: string }> {
  const sent: Array<{ system?: unknown; messages?: unknown }> = [];
  const provider = {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {},
    generateText: async (args: { system?: unknown; messages?: unknown }) => {
      sent.push(args);
      return { text: 'ok' };
    },
    generateObject: async () => {
      throw new Error('not used');
    },
    streamText: () => {
      throw new Error('not used');
    },
  } as unknown as NodalLlmClient;
  const client = addressedByHandle(provider, db as unknown as AnyDrizzleDb, {
    entityId: seed.entityId,
  });
  await client.generateText({
    // Le prompt d'un job de canal nomme sa conversation : il prouve que la
    // frontière a bien réécrit CETTE requête.
    system: `Conversation telegram ${CHAT}, discord ${DISCORD_CHANNEL}.`,
    messages: await hydrateForLlm(messages, input, new Map()),
  });
  const request = sent[0]!;
  return { system: String(request.system), text: JSON.stringify(request.messages) };
}

/** Un vrai outil du registre, par le vrai seam, dans les dossiers du run. */
async function callFileTool(
  jobId: string,
  name: string,
  input: Record<string, unknown>,
  autonomy?: 'fully_autonomous',
) {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  const tool = registry.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  const { workspaces } = await resolveRunWorkspaces(
    db as unknown as AnyDrizzleDb,
    seed.agentId,
    seed.entityId,
  );
  const ctx: ToolContext = {
    jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: String(CHAT),
    turn: 1,
    workspaces,
  };
  const res = await executeTool(tool, input as never, ctx, {
    approvalRules: [],
    ...(autonomy ? { autonomy } : {}),
    onApprovalRequired: async () => {},
  });
  if (res.outcome !== 'success') throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.output as { ok: boolean; reason?: string; content?: string };
}

/** Les deux chemins que la note d'un fichier reçu donne au modèle (le JSON de la requête). */
function pathsTheModelReads(requestText: string): { workspacePath: string; absolutePath: string } {
  const m = /Saved at (.+?) for the file tools \(absolute path: (.+?)\)\./.exec(requestText);
  if (!m) throw new Error(`no file note in the request: ${requestText}`);
  // Les chemins sont lus dans du JSON : un antislash Windows y est doublé.
  const unjson = (s: string) => JSON.parse(`"${s}"`) as string;
  return { workspacePath: unjson(m[1]!), absolutePath: unjson(m[2]!) };
}

describe('a received file opens at the path the model is given (#910) @cap:parler-par-canal-externe/moteur', () => {
  beforeEach(async () => {
    await db.delete(channelAllowedConversations);
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      conversationId: DISCORD_CHANNEL,
      kind: 'channel',
      status: 'active',
    });
  });

  it.each([
    { chat: { id: CHAT, type: 'private' as const }, caption: 'Range moi ça' },
    { chat: { id: -100777, type: 'group' as const }, caption: '@nodal_bot range le' },
  ])(
    'Telegram $chat.type chat: file_read and file_move succeed on exactly the paths the model read',
    async ({ chat, caption }) => {
      telegramFiles.set('doc-910', PDF);
      const { jobId, job } = await deliver(
        update(
          {
            caption,
            document: {
              file_id: 'doc-910',
              file_name: 'Facture EDF.pdf',
              mime_type: 'application/pdf',
            },
          },
          chat,
        ),
      );

      const request = await requestAsTheProviderGetsIt(job.messages as ModelMessage[], {
        sees: true,
      });
      // La frontière a réécrit cette requête : l'adresse du chat est partie.
      const handle = await conversationHandleFor(db as unknown as AnyDrizzleDb, {
        entityId: seed.entityId,
        channel: 'telegram',
        conversationId: String(CHAT),
      });
      expect(request.system).toContain(handle);
      expect(request.system).not.toContain(String(CHAT));

      const { workspacePath, absolutePath } = pathsTheModelReads(request.text);

      const read = await callFileTool(jobId, 'file_read', { path: workspacePath });
      expect(read.reason ?? null).toBeNull();
      expect(read).toMatchObject({ ok: true });
      expect(read.content).toContain('%PDF-1.7');
      const readAbsolute = await callFileTool(jobId, 'file_read', { path: absolutePath });
      expect(readAbsolute.reason ?? null).toBeNull();
      expect(readAbsolute).toMatchObject({ ok: true });
      expect(readAbsolute.content).toContain('%PDF-1.7');

      const classement = join(root, seed.entityId, 'shared', 'Classement');
      const copied = await callFileTool(jobId, 'file_move', {
        source: workspacePath,
        destination: 'shared/Classement/copie.pdf',
        copy: true,
        create_dirs: true,
      });
      expect(copied.reason ?? null).toBeNull();
      expect(copied).toMatchObject({ ok: true, operation: 'copied' });
      expect(new Uint8Array(await readFile(join(classement, 'copie.pdf')))).toEqual(PDF);

      // Retirer un fichier du dossier partagé que le run n'a pas écrit passe
      // par une personne (la porte d'écrasement, #881) : le déplacement est
      // joué ici comme sous une autonomie complète, celle où la porte ne
      // demande rien. Ce qu'il prouve est le chemin, pas la porte.
      const moved = await callFileTool(
        jobId,
        'file_move',
        { source: workspacePath, destination: 'shared/Classement/Facture EDF.pdf' },
        'fully_autonomous',
      );
      expect(moved.reason ?? null).toBeNull();
      expect(moved).toMatchObject({ ok: true, operation: 'moved' });
      expect(new Uint8Array(await readFile(join(classement, 'Facture EDF.pdf')))).toEqual(PDF);
      await rm(classement, { recursive: true });

      // Et ce chemin est celui du dossier du job, sans adresse de conversation.
      expect(workspacePath).toBe(`shared/telegram/${jobId}/Facture EDF.pdf`);
    },
  );

  it('Telegram photo for a model that does not see: the routing note names a path the file tools open', async () => {
    telegramFiles.set('photo-910', JPEG);
    const { jobId, job } = await deliver(
      update({ caption: 'regarde', photo: [{ file_id: 'photo-910', width: 9, height: 9 }] }),
    );
    const request = await requestAsTheProviderGetsIt(job.messages as ModelMessage[], {
      sees: false,
      reason: 'this model does not take images',
    });
    const m = ROUTING_NOTE_PATH.exec(request.text);
    expect(m).not.toBeNull();
    const noted = JSON.parse(`"${m![1]!}"`) as string;
    // Le modèle qui ne voit pas en fait un fichier : une copie par le chemin de la note.
    // (`file_read` d'une image, pour lui, dit « image, not read » : il ne lit pas d'image.)
    const copied = await callFileTool(jobId, 'file_move', {
      source: noted,
      destination: 'shared/Classement/',
      copy: true,
      create_dirs: true,
    });
    expect(copied.reason ?? null).toBeNull();
    expect(copied).toMatchObject({ ok: true, operation: 'copied' });
    const classement = join(root, seed.entityId, 'shared', 'Classement');
    const [kept] = await readdir(classement);
    expect(new Uint8Array(await readFile(join(classement, kept!)))).toEqual(JPEG);
    await rm(classement, { recursive: true });
    expect(noted).toBe(join(telegramFolder(), jobId, 'image.jpg'));
  });

  it('Discord image for a model that does not see: the routing note names a path the file tools open', async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const [created] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'discord',
        chatId: DISCORD_CHANNEL,
        task: 'regarde',
        status: 'pending',
      })
      .returning({ id: agentJobs.id });
    const jobId = created!.id;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(PNG, { status: 200 })),
    );
    // Ce que le gateway lui passe, tel quel (un canal qui donnait son id le
    // garde ici : la réception doit l'ignorer).
    const attachment = {
      url: 'https://cdn.discordapp.test/a.png',
      contentType: 'image/png',
      size: PNG.byteLength,
      text: 'regarde',
      channelId: DISCORD_CHANNEL,
    };
    try {
      await attachInboundImage({
        jobId,
        entityId: seed.entityId,
        attachment,
        db: db as unknown as RunnerDeps['db'],
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    const request = await requestAsTheProviderGetsIt(job!.messages as ModelMessage[], {
      sees: false,
      reason: 'this model does not take images',
    });
    const discordHandle = await conversationHandleFor(db as unknown as AnyDrizzleDb, {
      entityId: seed.entityId,
      channel: 'discord',
      conversationId: DISCORD_CHANNEL,
    });
    expect(request.system).toContain(discordHandle);

    const m = ROUTING_NOTE_PATH.exec(request.text);
    expect(m).not.toBeNull();
    const noted = JSON.parse(`"${m![1]!}"`) as string;
    // Le modèle qui ne voit pas en fait un fichier : une copie par le chemin de la note.
    // (`file_read` d'une image, pour lui, dit « image, not read » : il ne lit pas d'image.)
    const copied = await callFileTool(jobId, 'file_move', {
      source: noted,
      destination: 'shared/Classement/',
      copy: true,
      create_dirs: true,
    });
    expect(copied.reason ?? null).toBeNull();
    expect(copied).toMatchObject({ ok: true, operation: 'copied' });
    const classement = join(root, seed.entityId, 'shared', 'Classement');
    const [kept] = await readdir(classement);
    expect(new Uint8Array(await readFile(join(classement, kept!)))).toEqual(PNG);
    await rm(classement, { recursive: true });
    expect(noted).toBe(join(root, seed.entityId, 'shared', 'discord', `${jobId}.png`));
  });
});
