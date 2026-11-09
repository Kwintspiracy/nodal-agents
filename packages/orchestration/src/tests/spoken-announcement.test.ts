// spoken-announcement.test.ts — ce que l'agent dit quand un job lancé par la voix finit (#967).
//
// Ce qui se prouve : la consigne de l'annonce porte la personnalité de
// l'agent, le fait que ce qu'il écrit est dit, et APRÈS le résultat cité tel
// qu'en base, la règle du propriétaire : confirmer, avec ses mots, que ce qui
// a été demandé est fait ; un résultat court se dit, un document ne se raconte
// jamais (ni l'essentiel, ni un chiffre, ni un constat) ; jamais « où le
// lire », jamais l'offre d'un canal, aucune formule toute faite ; un fait
// sans lequel la personne serait trompée (pas encore fini, pas encore
// confirmé) reste, en quelques mots. Aucun canal n'est nommé dans la consigne.
//
// Les jobs des rejeux du 04/11 sont les fixtures (fixtures/
// spoken-announcement-jobs.json) : f7aecffd (le rapport de 3 737 caractères),
// 22720a8c et 3b33bf31 (deux résultats courts), b41632f5 (une mise en page
// imprimée, pas encore confirmée sortie ; écrite d'après le job, sans son
// chemin ni son imprimante).
//
// Mutations vérifiées : voir le corps de la PR #967.

import { describe, it, expect } from 'vitest';
import { buildSpokenAnnouncement } from '../spoken-announcement';
import JOBS from './fixtures/spoken-announcement-jobs.json';

const RULE =
  'Tell them, in your own words, that what they asked for is done. Speak the language ' +
  'of their request above, even when the result is written in another language.\n' +
  // Judged on what was ASKED (replay 4: a news research classed as a "short
  // answer" was summarised 5/5).
  '- If they asked a question they want answered (a fact, whether something works), ' +
  'say the answer simply, in plain spoken words.\n' +
  '- If they asked for a piece of work (research, a document, a page, a file, a print, ' +
  'a send), say only that it is done, in one short sentence. Nothing from its content: ' +
  'no gist, no main story, no finding, no number, no name, no caveat about what it says.\n' +
  // Replay 5: "keep a fact not to be misled" brought the research's caveats
  // back in. The fact kept is the state of the WORK, never of its content.
  '- If the work itself is not finished or not confirmed yet (a print still running, a ' +
  'message not delivered), add that in a few words, without naming a device, a model or ' +
  'a file. That is the only thing you add.\n' +
  // Replay 6: "in the chat for you to read" passed "never say where to read it".
  '- Never say where it is or that it can be read (not in Nodal, not in the chat, not ' +
  '"ready for you to read"), and never offer to send it anywhere: they know.\n' +
  '- No stock phrase: say it the way you would say it this time.\n' +
  '- Never say a web address, a file path or markup, and never explain what you are ' +
  'saying or leaving out, or why.\n' +
  'One or two short sentences.';

describe('the spoken announcement of a finished voice job (#967) @cap:parler-a-un-agent/moteur', () => {
  it('the fixtures are the four replayed jobs', () => {
    expect(JOBS.map((j) => j.job)).toEqual(['f7aecffd', '22720a8c', '3b33bf31', 'b41632f5']);
  });

  for (const job of JOBS) {
    it(`job ${job.job} (${job.kind}): the result is quoted whole, and the rule comes AFTER it`, () => {
      const { system, prompt } = buildSpokenAnnouncement({
        personality: 'You are Alfred.\n\n{{team}}',
        request: job.request,
        result: job.result,
      });
      expect(system).toBe(
        'You are Alfred.\n\n## Announcement\n' +
          'The work the person asked you for has just finished. You are now telling them, out ' +
          'loud: what you write is turned into speech and heard, not read.',
      );
      // The voice turn's rendering line is not reused: its "while the rest is
      // still being written" invites a rest an announcement does not have.
      expect(system).not.toContain('rendering:');
      expect(prompt).toBe(
        `The person asked:\n${job.request.trim()}\n\n` +
          'The result of the work, written in the conversation where they can read it:\n' +
          `<<<\n${job.result.trim()}\n>>>\n\n` +
          RULE,
      );
      // The rule is the last thing the model reads, after the whole result.
      expect(prompt.indexOf(job.result.trim())).toBeLessThan(prompt.indexOf('Tell them, in'));
      expect(prompt.endsWith('One or two short sentences.')).toBe(true);
    });
  }

  it('no channel is put in its mouth, and Nodal is named only as a place NOT to point to', () => {
    const { system, prompt } = buildSpokenAnnouncement({
      personality: 'You are Alfred.',
      request: JOBS[0]!.request,
      result: JOBS[0]!.result,
    });
    const rule = prompt.split('>>>')[1]!;
    expect(`${system}\n${rule}`).not.toMatch(/telegram|slack|discord|whatsapp/i);
    expect(rule.match(/nodal/gi)).toEqual(['Nodal']);
    expect(rule).toContain('Never say where it is or that it can be read (not in Nodal,');
    expect(rule).toContain('never offer to send it anywhere');
  });
});
