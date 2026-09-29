// run-page.test.ts — la section d'un run se décide SUR LE RUN (#501).
//
// La règle est pure : la tête de la chaîne dit d'où vient le travail, et la
// section en découle. Le câblage (lire cette tête en base, rediriger) est
// prouvé par `run-page-resolve.test.ts`.

import { describe, it, expect } from 'vitest';
import { destinationForPath } from '@/components/sidebar-nav.ts';
import { conversationOf, openRunHref, questionHref, runHrefIn, runSectionOf } from '../run-page.ts';

describe('runSectionOf — un run appartient à la section de ce qui l’a lancé @cap:suivre-execution/ecran', () => {
  it('une automatisation (cron ou webhook) : Scheduled', () => {
    expect(runSectionOf({ triggerType: 'cron', scheduleId: null })).toBe('scheduled');
    expect(runSectionOf({ triggerType: 'webhook', scheduleId: null })).toBe('scheduled');
    // Un run d'automatisation d'avant la provenance : son `schedule_id` suffit.
    expect(runSectionOf({ triggerType: null, scheduleId: 's1' })).toBe('scheduled');
  });

  it('une conversation, un canal, le serveur MCP : Work', () => {
    expect(runSectionOf({ triggerType: null, scheduleId: null })).toBe('work');
    expect(runSectionOf({ triggerType: 'mcp', scheduleId: null })).toBe('work');
  });

  it('l’adresse de chaque section allume bien cette section du rail', () => {
    // La règle ne vaut que si l'adresse qu'elle rend est lue par le rail comme
    // la section voulue : c'est le rail qui décide, sur l'adresse seule.
    expect(destinationForPath(runHrefIn('work', 'r1')).key).toBe('work');
    expect(destinationForPath(runHrefIn('scheduled', 'r1')).key).toBe('run');
    expect(runHrefIn('work', 'r1')).toBe('/chat/runs/r1');
    expect(runHrefIn('scheduled', 'r1')).toBe('/jobs/r1');
  });

  it('ouvrir un run sans savoir d’où il vient passe par la route qui décide', () => {
    expect(openRunHref('r1')).toBe('/runs/r1');
  });
});

// Revue Nodal de #622, P3 : `questionHref` ne testait que `null`, alors que la
// liste des conversations (`conversation-rows.ts`) traite `''` comme « sans
// conversation ». Une seule règle, `conversationOf`, pour les deux : un id
// vide n'est pas un fil, et `/chat/` n'est l'adresse de rien.
describe('questionHref — où se répond une question (#465) @cap:suivre-execution/ecran', () => {
  it('une conversation : son fil', () => {
    expect(questionHref({ conversationId: 'c1', jobId: 'j1' })).toBe('/chat/c1');
  });

  it('sans conversation, null OU vide : la page du run qui l’a posée', () => {
    expect(questionHref({ conversationId: null, jobId: 'j1' })).toBe(openRunHref('j1'));
    expect(questionHref({ conversationId: '', jobId: 'j1' })).toBe(openRunHref('j1'));
  });

  it('conversationOf : la même règle que la liste des conversations', () => {
    expect(conversationOf('c1')).toBe('c1');
    expect(conversationOf('')).toBeNull();
    expect(conversationOf(null)).toBeNull();
  });
});

// Revue Nodal de #621, passe 2 : `/runs` restait dans la table de Scheduled.
// Cette porte ne décide rien, elle redirige ; mais quand la chaîne du run ne se
// lit pas, elle rend sa PAGE D'ERREUR, le rail est dessiné, et il s'allumait sur
// Scheduled pour un run de Work : le symptôme de #501 sur sa propre porte. La
// page d'erreur vit à la MÊME adresse que la redirection, et le rail ne lit que
// l'adresse : l'assertion vaut pour les deux.
describe('la porte /runs/<id> n’allume jamais Scheduled (#501) @cap:suivre-execution/ecran', () => {
  it('ni la redirection, ni sa page d’erreur : le rail reste sur son repli, Work', () => {
    expect(destinationForPath(openRunHref('r1')).key).not.toBe('run');
    expect(destinationForPath(openRunHref('r1')).key).toBe('work');
  });
});
