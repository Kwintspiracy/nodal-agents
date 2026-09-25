// media-route.test.ts — GET /api/runs/<jobId>/media : CE QUE LE NAVIGATEUR REÇOIT (#490).
//
// Un vrai fichier sur le disque, un vrai résolveur (`delivered-media.ts`) ;
// la session et la base sont pilotées, parce que le contrat porte ici sur le
// PROTOCOLE : les octets rendus, `Range` pour qu'une piste avance et recule,
// le type venu de la liste fermée, le téléchargement, et chaque refus avec
// son code HTTP.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditRowForChanges } from '../file-change-groups.ts';

vi.mock('server-only', () => ({}));

const JOB = '11111111-2222-4333-8444-555555555555';
let ROOT: string;
let audit: AuditRowForChanges[] | null;
let signedIn = true;
let dbDown = false;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => ({}),
  requireUserWithEntity: async () => {
    if (!signedIn) throw new Error('unauthorized');
    return { userId: 'u', entityId: 'e' };
  },
}));
vi.mock('@/lib/run-audit-rows.ts', () => ({
  loadRunAuditRows: async (_db: unknown, entityId: string, jobId: string) => {
    if (dbDown) throw new Error('connect ECONNREFUSED 127.0.0.1:25444');
    return entityId === 'e' && jobId === JOB ? audit : null;
  },
}));
vi.mock('@/lib/workspace-roots.ts', () => ({
  entityWorkspaceRoots: async () => [ROOT],
}));

const { GET } = await import('../../app/api/runs/[jobId]/media/route.ts');

/** Les dix octets du fichier : assez pour lire une plage au milieu. */
const OCTETS = 'RIFF012345';

beforeEach(async () => {
  ROOT = await realpath(await mkdtemp(join(tmpdir(), 'nodal-media-route-')));
  await mkdir(join(ROOT, 'outputs'), { recursive: true });
  const wav = join(ROOT, 'outputs', 'voix.wav');
  await writeFile(wav, OCTETS);
  audit = [
    {
      toolName: 'generate_speech',
      toolInput: { text: 'x', path: wav },
      toolOutput: '{"ok":true}',
      presented: {
        card: 'files',
        total: 1,
        truncated: false,
        files: [{ path: wav, action: 'written' }],
      },
    },
  ];
  signedIn = true;
  dbDown = false;
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

function get(query: string, headers: Record<string, string> = {}, jobId = JOB) {
  return GET(new Request(`http://localhost/api/runs/${jobId}/media?${query}`, { headers }), {
    params: Promise.resolve({ jobId }),
  });
}

describe('GET /api/runs/<jobId>/media @cap:travailler-sur-des-fichiers/moteur', () => {
  it('sert le WAV livré, en entier, avec son type et en ligne', async () => {
    const res = await get('path=outputs%2Fvoix.wav&n=0');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(OCTETS);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe(
      `inline; filename="voix.wav"; filename*=UTF-8''voix.wav`,
    );
  });

  it('une plage demandée rend CES octets, en 206 : la lecture avance dans la piste', async () => {
    const res = await get('path=outputs%2Fvoix.wav&n=0', { Range: 'bytes=4-7' });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe('0123');
    expect(res.headers.get('content-range')).toBe('bytes 4-7/10');
    expect(res.headers.get('content-length')).toBe('4');

    const fin = await get('path=outputs%2Fvoix.wav&n=0', { Range: 'bytes=-3' });
    expect(fin.status).toBe(206);
    expect(await fin.text()).toBe('345');
    expect(fin.headers.get('content-range')).toBe('bytes 7-9/10');

    const ouverte = await get('path=outputs%2Fvoix.wav&n=0', { Range: 'bytes=8-' });
    expect(await ouverte.text()).toBe('45');
  });

  it('une plage hors du fichier est refusée en 416, avec la taille', async () => {
    const res = await get('path=outputs%2Fvoix.wav&n=0', { Range: 'bytes=10-20' });

    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('download=1 le rend en pièce jointe', async () => {
    const res = await get('path=outputs%2Fvoix.wav&n=0&download=1');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="voix.wav"; filename*=UTF-8''voix.wav`,
    );
  });

  it('chaque refus a son code : session, travail, fichier', async () => {
    signedIn = false;
    expect((await get('path=outputs%2Fvoix.wav&n=0')).status).toBe(401);
    signedIn = true;

    const autreJob = await get(
      'path=outputs%2Fvoix.wav&n=0',
      {},
      '99999999-2222-4333-8444-555555555555',
    );
    expect(autreJob.status).toBe(404);
    expect(await autreJob.json()).toEqual({ error: 'job_not_found' });

    const pasLivre = await get('path=outputs%2Fautre.wav&n=0');
    expect(pasLivre.status).toBe(404);
    expect(await pasLivre.json()).toEqual({ error: 'not_delivered' });

    await rm(join(ROOT, 'outputs', 'voix.wav'));
    const parti = await get('path=outputs%2Fvoix.wav&n=0');
    expect(parti.status).toBe(404);
    expect(await parti.json()).toEqual({ error: 'gone' });

    // Un refus porte `nosniff` lui aussi (revue de la PR #493).
    expect(parti.headers.get('x-content-type-options')).toBe('nosniff');

    expect((await get('n=0')).status).toBe(400);
    expect((await get('path=x&n=0', {}, 'pas-un-uuid')).status).toBe(400);
  });

  it('une base en panne se dit en 500 db_error, sans détail Postgres', async () => {
    // Revue de la PR #493 : sans garde, l'erreur remontait en 500 brut.
    dbDown = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await get('path=outputs%2Fvoix.wav&n=0');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'db_error' });
    } finally {
      consoleError.mockRestore();
    }
  });
});
