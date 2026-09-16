// live-stack.test.mjs — `pnpm release:check` ne tourne pas sur une stack vivante.
//
// Pourquoi : la commande construit dans `apps/web/.next` et vide `pack/`. Lancée
// pendant qu'une stack de dev sert sur :3000, elle la tue en cours de route, et
// le message qu'on lit alors parle de build, jamais de la stack qui vient de
// mourir. La décision est donc prise AVANT tout le reste, et elle se teste ici
// sans ouvrir une seule socket.

import { describe, it, expect } from 'vitest';
import { portsDeLaStack, verdictStackVivante } from '../lib/live-stack.mjs';
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
