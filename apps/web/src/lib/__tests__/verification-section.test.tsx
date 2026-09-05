// verification-section.test.tsx — la section « Verification » du détail de
// run n'est JAMAIS vide (inv. #4) : un tour de chat, une surface hors
// vérification, un projet sans commandes et « aucune preuve » ont chacun leur
// phrase ; les lignes d'une preuve sortent dans l'ordre des rangs. Rendu
// statique, sans navigateur : ce sont les mots et l'ordre qu'on prouve.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import VerificationSection from '@/app/(dashboard)/code/[id]/VerificationSection.tsx';
import type { VerificationSequenceView } from '@/lib/verification-runs-view.ts';

const SEQ: VerificationSequenceView = {
  sequenceId: 'S1',
  jobId: 'job-a',
  deliverableType: 'code_project',
  canonicalKey: 'd:/apps/projet',
  verdict: 'red',
  startedAt: new Date().toISOString(),
  runs: [
    {
      jobId: 'job-a',
      sequenceId: 'S1',
      commandRank: 1,
      command: 'pnpm typecheck',
      exitCode: 0,
      outcomeKind: 'exit',
      durationMs: 1500,
      verdict: 'green',
      testedGeneration: 3,
      testedEpoch: 0,
      createdAt: new Date().toISOString(),
    },
    {
      jobId: 'job-a',
      sequenceId: 'S1',
      commandRank: 2,
      command: 'pnpm test',
      exitCode: null,
      outcomeKind: 'timeout',
      durationMs: 240_000,
      verdict: 'red',
      testedGeneration: 3,
      testedEpoch: 0,
      createdAt: new Date().toISOString(),
    },
  ],
};

function render(props: Partial<Parameters<typeof VerificationSection>[0]>) {
  return renderToStaticMarkup(
    <VerificationSection
      sequences={[]}
      skippedSurfaces={[]}
      unconfigured={[]}
      stage="done"
      live={false}
      {...props}
    />,
  );
}

describe('VerificationSection', () => {
  it('un tour de chat le dit : pas de job, donc pas de preuve', () => {
    const html = render({ stage: 'chat' });
    expect(html).toContain('Chat turns are not under verification yet');
    expect(html).not.toContain('No proof ran');
  });

  it('aucune preuve : « No proof ran » une fois terminé, « No proof yet » tant que ça tourne', () => {
    expect(render({ live: false })).toContain('No proof ran for this process.');
    expect(render({ live: true, stage: 'coding' })).toContain('No proof yet.');
  });

  it('surface décochée ⇒ la mention, avec le libellé du réglage, et la section n’est pas vide', () => {
    const html = render({ skippedSurfaces: ['fileOps'] });
    expect(html).toContain('not verified');
    expect(html).toContain('File tools is out of verification');
    expect(html).toContain('data-testid="verification-skipped-fileOps"');
  });

  it('projet sans commandes / en attente d’approbation ⇒ deux phrases distinctes', () => {
    const html = render({
      unconfigured: [
        {
          deliverableType: 'code_project',
          canonicalKey: 'd:/apps/a',
          displayPath: 'D:\\APPS\\a',
          reason: 'not_configured',
        },
        {
          deliverableType: 'code_project',
          canonicalKey: 'd:/apps/b',
          displayPath: null,
          reason: 'pending_approval',
        },
      ],
    });
    expect(html).toContain('has no proof commands');
    expect(html).toContain('waiting for the owner’s approval');
    expect(html).toContain('d:/apps/b');
  });

  it('un document ne renvoie PAS vers une carte de projet (v7-A)', () => {
    // Dire à quelqu'un d'aller ajouter des commandes de preuve sur la carte de
    // projet d'un classeur l'envoie chercher un réglage qui n'existe pas :
    // aucun écran ne configure la vérification d'un document.
    const html = render({
      unconfigured: [
        {
          deliverableType: 'office_file',
          canonicalKey: 'd:/apps/a/rapport.xlsx',
          displayPath: 'D:\APPS\a\rapport.xlsx',
          reason: 'not_configured',
        },
      ],
    });
    expect(html).toContain('Nodal does not check documents yet');
    expect(html).not.toContain('project card in Code');
    expect(html).toContain('not checked');
  });

  it('une preuve : ses commandes dans l’ordre des rangs, code de sortie, durée, verdict', () => {
    const html = render({ sequences: [SEQ] });
    expect(html).toContain('Verification · 1');
    const iTypecheck = html.indexOf('pnpm typecheck');
    const iTest = html.indexOf('pnpm test');
    expect(iTypecheck).toBeGreaterThan(-1);
    expect(iTest).toBeGreaterThan(iTypecheck);
    expect(html).toContain('timeout');
    expect(html).toContain('1.5 s');
    expect(html).toContain('4 min 0 s');
    expect(html).toContain('>red<');
    expect(html).toContain('>green<');
    expect(html).not.toContain('No proof');
  });
});
