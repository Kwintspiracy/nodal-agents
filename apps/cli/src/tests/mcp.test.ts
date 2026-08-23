// mcp.test.ts — la résolution config → options du serveur MCP.
//
// C'est la pièce qui remplace « l'utilisateur tape DATABASE_URL » : elle doit
// construire exactement l'URL que `up` construirait, brancher la notification
// worker sur le port du runner, et échouer FORT sans config — jamais deviner.

import { describe, it, expect } from 'vitest';
import { resolveMcpServeOptions } from '../commands/mcp.ts';
import { ConfigSchema } from '../lib/config.ts';

// Les longueurs sont imposées par ConfigSchema (workerSecret ≥ 32,
// serverActionsKey/authSecret = 44, postgresPassword ≥ 16).
const WORKER_SECRET = 'ws-secret-0123456789-0123456789-01';
const PG_PASSWORD = 'p@ss:word-0123456789';
const BASE = ConfigSchema.parse({
  ports: { web: 3000, runner: 3101, postgres: 25441 },
  workerSecret: WORKER_SECRET,
  serverActionsKey: 'A'.repeat(43) + '=',
  authSecret: 'B'.repeat(43) + '=',
  postgresPassword: PG_PASSWORD,
});

describe('resolveMcpServeOptions', () => {
  it('échoue fort sans config — jamais d URL devinée', () => {
    expect(() => resolveMcpServeOptions(null)).toThrow(/mcp_config_missing/);
  });

  it("construit l'URL de la base comme `up` : port du config, mot de passe encodé", () => {
    const opts = resolveMcpServeOptions(BASE, {});
    // Le mot de passe doit être percent-encodé — un `@` brut pointerait l'URL
    // sur un autre hôte en silence (même piège que buildPgUrl documente).
    expect(opts.databaseUrl).toBe(
      `postgresql://nodalai:${encodeURIComponent(PG_PASSWORD)}@localhost:25441/nodalai`,
    );
    expect(opts.databaseUrl).not.toContain('p@ss');
  });

  it('branche la notification worker sur 127.0.0.1 (jamais localhost), secret compris', () => {
    const opts = resolveMcpServeOptions(BASE, {});
    // `localhost` peut résoudre en ::1 sur Windows, où le runner n'écoute pas :
    // notification silencieusement morte + workerSecret offert à un squatteur
    // IPv6 (review 23/08, même piège que RUNNER_URL dans env.ts).
    expect(opts.notifyRunner).toEqual({
      url: 'http://127.0.0.1:3101',
      workerSecret: WORKER_SECRET,
    });
  });

  it("relaie NODAL_MCP_AGENT_ID depuis l'environnement, absent sinon", () => {
    expect(resolveMcpServeOptions(BASE, {}).agentId).toBeUndefined();
    expect(resolveMcpServeOptions(BASE, { NODAL_MCP_AGENT_ID: 'abc-123' }).agentId).toBe('abc-123');
  });
});
