// autostart-view.test.ts — la réponse du CLI (`service … --json`), lue telle
// quelle (#451). Une réponse illisible ne devient jamais « off ».

import { describe, it, expect } from 'vitest';
import { parseServiceJson } from '../autostart-view.ts';

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
