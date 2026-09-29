// autostart-view.test.ts — la réponse du CLI (`service … --json`), lue telle
// quelle (#451). Une réponse illisible ne devient jamais « off ».

import { describe, it, expect } from 'vitest';
import { autostartOutcome, parseServiceJson } from '../autostart-view.ts';

describe('parseServiceJson @cap:installer-et-demarrer/moteur', () => {
  it('lit la dernière ligne : un avertissement de node peut précéder', () => {
    expect(
      parseServiceJson(
        '(node:1) [DEP0205] DeprecationWarning: …\n{"state":"at_login","lingerCommand":"sudo loginctl enable-linger pi"}\n',
      ),
    ).toEqual({ state: 'at_login', lingerCommand: 'sudo loginctl enable-linger pi' });
    // La réponse réelle du CLI sur ce poste Windows, le 27/09 : aucune tâche.
    expect(parseServiceJson('{"state":"off"}\n')).toEqual({ state: 'off' });
  });

  it('off avec sa raison (coupé côté Windows) : la raison traverse', () => {
    expect(
      parseServiceJson('{"state":"off","reason":"Windows has this startup entry turned off."}\n'),
    ).toEqual({ state: 'off', reason: 'Windows has this startup entry turned off.' });
  });

  it('une réponse illisible ou inconnue rend null, jamais « off »', () => {
    expect(parseServiceJson('')).toBeNull();
    expect(parseServiceJson('Error: boom')).toBeNull();
    expect(parseServiceJson('{"state":"maybe"}')).toBeNull();
    expect(parseServiceJson('{"state":"unsupported"}')).toBeNull();
  });
});

describe('autostartOutcome : le toast suit l’état relu, jamais le seul « ok » @cap:installer-et-demarrer/moteur', () => {
  it('allumer : succès à la connexion comme au boot', () => {
    for (const status of [{ state: 'at_login' }, { state: 'at_boot' }] as const) {
      expect(autostartOutcome(true, status)).toEqual({
        ok: true,
        message: 'Nodal will start with this machine',
      });
    }
  });

  it('éteindre : succès quand l’état relu est off, même avec une raison', () => {
    expect(autostartOutcome(false, { state: 'off' })).toEqual({
      ok: true,
      message: 'Nodal will not start with this machine',
    });
    expect(autostartOutcome(false, { state: 'off', reason: 'Turned off in Windows.' }).ok).toBe(
      true,
    );
  });

  it('unsupported après le geste, dans les deux sens : échec, avec la raison du système', () => {
    const status = { state: 'unsupported', reason: 'No script to start.' } as const;
    expect(autostartOutcome(true, status)).toEqual({ ok: false, message: 'No script to start.' });
    expect(autostartOutcome(false, status)).toEqual({ ok: false, message: 'No script to start.' });
  });

  it('allumer, relu off : échec, la raison du système quand il en donne une', () => {
    expect(autostartOutcome(true, { state: 'off', reason: 'Turned off in Windows.' })).toEqual({
      ok: false,
      message: 'Turned off in Windows.',
    });
    expect(autostartOutcome(true, { state: 'off' })).toEqual({
      ok: false,
      message: 'Nodal is still off: this machine did not keep the startup entry.',
    });
  });

  it('éteindre, relu allumé : échec', () => {
    for (const status of [{ state: 'at_login' }, { state: 'at_boot' }] as const) {
      expect(autostartOutcome(false, status)).toEqual({
        ok: false,
        message: 'Nodal still starts with this machine: the startup entry could not be removed.',
      });
    }
  });
});
