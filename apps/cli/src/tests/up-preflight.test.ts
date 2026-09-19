// up-preflight.test.ts — `up` demande les binaires AVANT tout le reste (#247).
//
// Le détecteur avait ses propres cas, et personne ne prouvait qu'il était
// BRANCHÉ : `runUp` pouvait cesser de l'appeler, ou l'appeler trop tard, sans
// qu'un test rougisse (constat de revue, passe 1).
//
// L'ordre est prouvé sans compter les appels (invariant #5). `readConfig` est
// remplacé par une sentinelle qui LÈVE : si la lecture de config arrivait avant
// le contrôle des binaires, c'est cette erreur-là qui sortirait de `runUp`. Le
// premier cas obtient le message des binaires, donc le contrôle est bien passé
// en premier ; le second obtient la sentinelle, donc une installation saine
// n'est pas bloquée et l'exécution continue après.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as BinariesModule from '../lib/embedded-postgres-binaries.ts';
import type * as ConfigModule from '../lib/config.ts';

// ── Mocks (hissés avant les imports) ─────────────────────────────────────────

vi.mock('../lib/embedded-postgres-binaries.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof BinariesModule>();
  return { ...actual, probeEmbeddedPostgres: vi.fn() };
});

/** Ce que `readConfig` lève : reconnaissable, et impossible à confondre. */
const CONFIG_SENTINEL = 'CONFIG_WAS_READ_BEFORE_THE_BINARIES_WERE_CHECKED';

vi.mock('../lib/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    readConfig: vi.fn(() => {
      throw new Error(CONFIG_SENTINEL);
    }),
  };
});

// ── Imports (après les mocks) ────────────────────────────────────────────────

import {
  probeEmbeddedPostgres,
  EmbeddedPostgresUnavailableError,
  type BinariesVerdict,
} from '../lib/embedded-postgres-binaries.ts';
import { runUp } from '../commands/up.ts';

const mockProbe = vi.mocked(probeEmbeddedPostgres);

const GATE_MESSAGE =
  "npm's install-script gate skipped @embedded-postgres/linux-x64, so 14 library links the database needs were never created.\n" +
  'Approve that one package and install again:\n\n' +
  '  npm approve-scripts @embedded-postgres/linux-x64\n' +
  '  npm install -g nodal-agents@latest';

const GATED: BinariesVerdict = {
  ok: false,
  reason: 'HYDRATION_SKIPPED',
  packageName: '@embedded-postgres/linux-x64',
  missing: ['/opt/pg/native/lib/libpq.so'],
  message: GATE_MESSAGE,
};

beforeEach(() => {
  mockProbe.mockReset();
});

describe('up refuses to start on missing database binaries @cap:installer-et-demarrer/moteur', () => {
  it('stops with the probe’s own message, before the config is even read', async () => {
    mockProbe.mockResolvedValue(GATED);

    const err = await runUp().then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(EmbeddedPostgresUnavailableError);
    const failure = err as EmbeddedPostgresUnavailableError;
    // Le message sort TEL QUEL : `index.ts` l'imprime derrière « Error: » et
    // sort en code non nul. Rien n'est reformulé en route.
    expect(failure.message).toBe(GATE_MESSAGE);
    expect(failure.reason).toBe('HYDRATION_SKIPPED');
    expect(failure.message).not.toContain(CONFIG_SENTINEL);
  });

  it('a complete install is not blocked: up carries on past the check', async () => {
    mockProbe.mockResolvedValue({ ok: true, packageName: '@embedded-postgres/linux-x64' });

    const err = await runUp().then(
      () => null,
      (e: unknown) => e,
    );

    // La sentinelle, donc `up` a dépassé le contrôle et a atteint la config.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(CONFIG_SENTINEL);
    expect(err).not.toBeInstanceOf(EmbeddedPostgresUnavailableError);
  });
});
