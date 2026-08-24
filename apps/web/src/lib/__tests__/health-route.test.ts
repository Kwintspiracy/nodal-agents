// health-route.test.ts — GET /api/health du WEB ne doit plus jamais mentir.
//
// L'incident fondateur (23/08) : Postgres mort, et ce handler répondait
// `{ ok: true }` inconditionnellement — le rituel `curl :3000/api/health`
// jurait donc que tout allait bien pendant que rien ne s'écrivait en base.
// Deux contrats figés ici : base joignable → 200 db:ok ; base morte → 503
// db:error, SANS fuiter le détail de l'erreur (la route n'est pas
// authentifiée — un message Postgres porte hôte/port/user).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// getDb est piloté test par test : un vrai SELECT 1 n'apporterait rien de
// plus ici — le contrat porte sur la TRADUCTION du résultat du ping en
// statut HTTP, pas sur le driver.
const executeMock = vi.fn();

vi.mock('@/lib/server.ts', () => ({
  getDb: () => ({ execute: executeMock }),
}));

beforeEach(() => {
  executeMock.mockReset();
});

describe('GET /api/health (web)', () => {
  it('base joignable → 200, ok:true, db:ok', async () => {
    executeMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    const { GET } = await import('../../app/api/health/route.ts');

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: 'ok', service: 'nodalai-web' });
  });

  it('base morte → 503, ok:false, db:error — et AUCUN détail Postgres dans la réponse', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    executeMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:25440 user=nodalai'),
    );
    const { GET } = await import('../../app/api/health/route.ts');

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ ok: false, db: 'error', service: 'nodalai-web' });
    expect(JSON.stringify(body), 'le détail de l’erreur DB a fuité au client').not.toContain(
      '25440',
    );

    // Le détail va bien dans les logs SERVEUR, lui.
    expect(consoleError).toHaveBeenCalledWith(
      '[health] DB ping failed:',
      expect.stringContaining('ECONNREFUSED'),
    );
    consoleError.mockRestore();
  });
});
