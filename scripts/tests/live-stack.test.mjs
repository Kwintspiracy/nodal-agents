// live-stack.test.mjs — `pnpm release:check` ne tourne pas sur une stack vivante.
//
// Pourquoi : la commande construit dans `apps/web/.next` et vide `pack/`. Lancée
// pendant qu'une stack de dev sert sur :3000, elle la tue en cours de route, et
// le message qu'on lit alors parle de build, jamais de la stack qui vient de
// mourir. La décision est donc prise AVANT tout le reste, et elle se teste ici
// sans ouvrir une seule socket.

import { describe, it, expect } from 'vitest';
import {
  estUnRefusDeConnexion,
  portsDeLaStack,
  verdictDuneSonde,
  verdictStackVivante,
} from '../lib/live-stack.mjs';

/** Ce que `fetch` jette vraiment : une enveloppe, la cause au fond. */
const echecFetch = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
const refus = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

describe('portsDeLaStack', () => {
  it('lit les ports du fichier de configuration', () => {
    expect(portsDeLaStack({ ports: { web: 4000, runner: 4001, postgres: 25444 } })).toEqual([
      4000, 4001,
    ]);
  });

  it('sans configuration, les ports par défaut : c’est là que la stack sert', () => {
    expect(portsDeLaStack(null)).toEqual([3000, 3001]);
    expect(portsDeLaStack({})).toEqual([3000, 3001]);
  });

  it('une configuration partielle complète avec le défaut, elle ne l’efface pas', () => {
    expect(portsDeLaStack({ ports: { web: 4000 } })).toEqual([4000, 3001]);
  });

  it('un même port des deux côtés n’est sondé qu’une fois', () => {
    expect(portsDeLaStack({ ports: { web: 3000, runner: 3000 } })).toEqual([3000]);
  });

  // Un port présent mais illisible ne retombe PAS sur le défaut : la commande
  // sonderait 3000 pendant que la vraie stack sert ailleurs, ne verrait
  // personne, et la tuerait. Invariant #4 : échouer fort, et nommer la valeur.
  it('une chaîne au lieu d’un entier fait échouer, en nommant la clé et la valeur', () => {
    expect(() => portsDeLaStack({ ports: { web: '4000' } })).toThrow(
      'ports.web = "4000" in ~/.nodalai/config.json is not a port',
    );
  });

  it('un port hors des bornes ou fractionnaire fait échouer aussi', () => {
    expect(() => portsDeLaStack({ ports: { runner: 0 } })).toThrow('ports.runner = 0');
    expect(() => portsDeLaStack({ ports: { web: 70000 } })).toThrow('ports.web = 70000');
    expect(() => portsDeLaStack({ ports: { web: 3000.5 } })).toThrow('ports.web = 3000.5');
    expect(() => portsDeLaStack({ ports: { web: -1 } })).toThrow('ports.web = -1');
  });

  it('une clé absente garde le défaut : « pas de configuration » est légitime', () => {
    expect(portsDeLaStack({ ports: {} })).toEqual([3000, 3001]);
    expect(portsDeLaStack({ ports: { web: undefined, runner: null } })).toEqual([3000, 3001]);
  });
});

describe('estUnRefusDeConnexion', () => {
  it('un ECONNREFUSED au fond de l’enveloppe fetch est un refus prouvé', () => {
    expect(estUnRefusDeConnexion(echecFetch(refus()))).toBe(true);
  });

  it('un AggregateError de refus reste un refus', () => {
    const agg = Object.assign(new AggregateError([refus(), refus()], 'all failed'), {});
    expect(estUnRefusDeConnexion(echecFetch(agg))).toBe(true);
  });

  it('un reset, un timeout, une erreur sans code : ce n’est PAS un refus', () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(estUnRefusDeConnexion(echecFetch(reset))).toBe(false);
    expect(
      estUnRefusDeConnexion(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
    ).toBe(false);
    expect(estUnRefusDeConnexion(new TypeError('fetch failed'))).toBe(false);
  });

  it('un refus mêlé à autre chose ne prouve plus rien', () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const agg = new AggregateError([refus(), reset], 'mixed');
    expect(estUnRefusDeConnexion(echecFetch(agg))).toBe(false);
  });
});

describe('verdictDuneSonde', () => {
  it('une réponse, sur n’importe quelle famille, prouve que quelqu’un écoute', () => {
    expect(verdictDuneSonde([null, echecFetch(refus())])).toBe(true);
  });

  // Le cas qui a motivé le correctif : la stack n’écoute que sur ::1, et
  // 127.0.0.1 refuse. Une seule famille sondée la déclarait absente.
  it('refusée sur une famille, vivante sur l’autre : vivante', () => {
    expect(verdictDuneSonde([echecFetch(refus()), null])).toBe(true);
  });

  it('un refus prouvé sur TOUTES les familles, et seulement là, vaut absent', () => {
    expect(verdictDuneSonde([echecFetch(refus()), echecFetch(refus())])).toBe(false);
  });

  it('un reset ou une réponse malformée vaut vivant : quelqu’un a accepté la connexion', () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(verdictDuneSonde([echecFetch(reset), echecFetch(reset)])).toBe(true);
    expect(verdictDuneSonde([new TypeError('fetch failed'), new TypeError('fetch failed')])).toBe(
      true,
    );
  });

  it('un timeout vaut vivant : un serveur occupé met plus de 1,5 s à répondre', () => {
    const t = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(verdictDuneSonde([t, t])).toBe(true);
  });

  it('aucune tentative ne vaut pas une stack vivante', () => {
    expect(verdictDuneSonde([])).toBe(false);
    expect(verdictDuneSonde(null)).toBe(false);
  });
});

describe('verdictStackVivante', () => {
  it('un seul port qui répond suffit à arrêter : le build tuerait cette stack', () => {
    const v = verdictStackVivante([
      { port: 3000, vivant: true },
      { port: 3001, vivant: false },
    ]);
    expect(v.vivante).toBe(true);
    expect(v.ports).toEqual([3000]);
    expect(v.message).toContain('a dev stack is running on :3000');
    expect(v.message).toContain('apps/web/.next');
    expect(v.message).toContain('isolated worktree');
  });

  it('nomme TOUS les ports vivants, pas seulement le premier', () => {
    const v = verdictStackVivante([
      { port: 3000, vivant: true },
      { port: 3001, vivant: true },
    ]);
    expect(v.ports).toEqual([3000, 3001]);
    expect(v.message).toContain(':3000, :3001');
  });

  it('personne au bout du fil : la commande peut tourner', () => {
    const v = verdictStackVivante([
      { port: 3000, vivant: false },
      { port: 3001, vivant: false },
    ]);
    expect(v.vivante).toBe(false);
    expect(v.message).toBe(null);
  });

  it('aucune sonde du tout ne vaut pas une stack vivante', () => {
    expect(verdictStackVivante([]).vivante).toBe(false);
    expect(verdictStackVivante(null).vivante).toBe(false);
  });
});
