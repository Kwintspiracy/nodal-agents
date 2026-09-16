// sonde.test.mjs — la sonde de `release:check`, contre de VRAIS serveurs.
//
// Le verdict est pur et se teste sans socket (`live-stack.test.mjs`). La sonde,
// elle, ne se prouve qu'en parlant à quelqu'un : ce qu'elle passe à `fetch`
// change ce que `fetch` jette, et aucune lecture de source ne le dit.
//
// Les serveurs écoutent sur un port éphémère de 127.0.0.1, et la sonde ne
// questionne que cette famille — sans quoi ::1 refuserait et le résultat ne
// dirait plus rien de ce qu'on veut prouver.

import { createServer } from 'node:http';
import { describe, it, expect, afterAll } from 'vitest';
import { sonderUnPort } from '../lib/sonde.mjs';

const UNE_SEULE_FAMILLE = { familles: ['127.0.0.1'], delaiMs: 2000 };
const ouverts = [];

/** Un serveur jetable sur 127.0.0.1, rendu avec son port. */
const servir = (repondre) =>
  new Promise((resolve) => {
    const s = createServer(repondre);
    ouverts.push(s);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });

/** Un port que personne n'écoute : ouvert puis refermé tout de suite. */
const portMort = async () => {
  const s = createServer(() => {});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
};

afterAll(() => Promise.all(ouverts.map((s) => new Promise((r) => s.close(r)))));

describe('sonderUnPort', () => {
  it('un serveur qui répond 200 est vivant', async () => {
    const port = await servir((_, res) => res.end('ok'));
    expect((await sonderUnPort(port, UNE_SEULE_FAMILLE)).vivant).toBe(true);
  });

  it('un 500 est une réponse : quelqu’un écoute, donc vivant', async () => {
    const port = await servir((_, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    expect((await sonderUnPort(port, UNE_SEULE_FAMILLE)).vivant).toBe(true);
  });

  // Le cas du constat : par défaut `fetch` SUIT la redirection, et l'erreur
  // qu'il jette vient de la SECONDE requête. Une stack bien vivante, qui venait
  // de répondre 307, passait pour absente et le build l'écrasait.
  it('un 307 vers une adresse fermée reste VIVANT : le 307 est une réponse', async () => {
    const mort = await portMort();
    const port = await servir((_, res) => {
      res.statusCode = 307;
      res.setHeader('Location', `http://127.0.0.1:${mort}/api/health`);
      res.end();
    });
    expect((await sonderUnPort(port, UNE_SEULE_FAMILLE)).vivant).toBe(true);
  });

  it('une connexion acceptée puis coupée net reste vivante', async () => {
    const port = await servir((_, res) => res.socket.destroy());
    expect((await sonderUnPort(port, UNE_SEULE_FAMILLE)).vivant).toBe(true);
  });

  it('personne au bout du fil : absent, et c’est le seul cas qui le soit', async () => {
    expect((await sonderUnPort(await portMort(), UNE_SEULE_FAMILLE)).vivant).toBe(false);
  });

  it('refusé sur une famille, vivant sur l’autre : vivant', async () => {
    const port = await servir((_, res) => res.end('ok'));
    // ::1 ne sert pas — le serveur n'écoute que sur 127.0.0.1.
    const r = await sonderUnPort(port, { familles: ['::1', '127.0.0.1'], delaiMs: 2000 });
    expect(r.vivant).toBe(true);
  });

  it('rend le port qu’on lui a donné, pour que le message le nomme', async () => {
    const port = await servir((_, res) => res.end('ok'));
    expect((await sonderUnPort(port, UNE_SEULE_FAMILLE)).port).toBe(port);
  });
});
