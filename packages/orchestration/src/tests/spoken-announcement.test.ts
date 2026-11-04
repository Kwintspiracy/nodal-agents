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
  'a send), only confirm it is done: nothing from its content, no gist, no summary, no ' +
  'finding, no number, no name.\n' +
  '- Never say where to read it, and never offer to send it anywhere: they know.\n' +
  '- If they need a fact so as not to be misled (something not finished or not confirmed ' +
  'yet), keep it, in a few words.\n' +
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

  it('no channel and no "read it in Nodal" is put in its mouth: the rule names none', () => {
    const { system, prompt } = buildSpokenAnnouncement({
      personality: 'You are Alfred.',
      request: JOBS[0]!.request,
      result: JOBS[0]!.result,
    });
    const rule = prompt.split('>>>')[1]!;
    expect(`${system}\n${rule}`).not.toMatch(/telegram|slack|discord|whatsapp|\bnodal\b/i);
    expect(rule).toContain('never offer to send it anywhere');
  });
});
