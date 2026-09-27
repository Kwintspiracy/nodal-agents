// run-page.test.ts — la section d'un run se décide SUR LE RUN (#501).
//
// La règle est pure : la tête de la chaîne dit d'où vient le travail, et la
// section en découle. Le câblage (lire cette tête en base, rediriger) est
// prouvé par `run-page-resolve.test.ts`.

import { describe, it, expect } from 'vitest';
import { destinationForPath } from '@/components/sidebar-nav.ts';
import { openRunHref, runHrefIn, runSectionOf } from '../run-page.ts';

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
