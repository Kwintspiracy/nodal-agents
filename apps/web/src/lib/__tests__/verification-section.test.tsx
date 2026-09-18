// verification-section.test.tsx — la section « Verification » du détail de
// run n'est JAMAIS vide (inv. #4) : un tour de chat, une surface hors
// vérification, un projet sans commandes et « aucune preuve » ont chacun leur
// phrase ; les lignes d'une preuve sortent dans l'ordre des rangs.
//
// 18/09 — la section est REPLIÉE par défaut : sa ligne porte le compte, le
// verdict d'ensemble et ce qu'il y a dessous, et c'est le clic qui montre les
// commandes. Les cas qui lisent le CORPS l'ouvrent donc d'abord, dans un vrai
// DOM ; ce qu'ils prouvent — les mots et leur ordre — n'a pas bougé.

import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
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

function section(props: Partial<Parameters<typeof VerificationSection>[0]>) {
  return (
    <VerificationSection
      sequences={[]}
      skippedSurfaces={[]}
      unconfigured={[]}
      stage="done"
      live={false}
      {...props}
    />
  );
}

/** La section REPLIÉE, en HTML : ce que la ligne dit sans qu'on la touche. */
function render(props: Partial<Parameters<typeof VerificationSection>[0]>) {
  return renderToStaticMarkup(section(props));
}

/** La section OUVERTE, dans un vrai DOM : ce que le clic montre. */
async function open(props: Partial<Parameters<typeof VerificationSection>[0]>): Promise<string> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(section(props));
  });
  await act(async () => {
    (host.querySelector('[data-testid="verification-row"]') as HTMLElement).click();
  });
  const html = host.innerHTML;
  await act(async () => {
    root.unmount();
  });
  host.remove();
  return html;
}

describe('VerificationSection — la ligne repliée @cap:verifier-un-livrable/ecran', () => {
  it('repliée par défaut : aucune commande dans la page avant le clic', async () => {
    const replie = render({ sequences: [SEQ] });
    expect(replie).not.toContain('pnpm typecheck');
    expect(replie).not.toContain('data-testid="verification-sequence"');
    // Et la ligne dit quand même ce qu'il y a dessous.
    expect(replie).toContain('Verification · 1');
    expect(replie).toContain('1 sequence · 2 commands');
    expect(await open({ sequences: [SEQ] })).toContain('pnpm typecheck');
  });

  it('la ligne porte le verdict d’ensemble : rouge dès qu’une séquence n’est pas verte', () => {
    const rouge = render({ sequences: [SEQ] });
    expect(rouge).toContain('>red<');
    const verte = render({ sequences: [{ ...SEQ, verdict: 'green' }] });
    expect(verte).toContain('>green<');
  });

  it('un verdict VERT est dessiné en vert — jamais dans la couleur des skills', () => {
    // Quentin a vu « green » écrit en rouge : le ton `skill` est la couleur
    // d'entité des skills (#ff5631, un orange-rouge). Une couleur ne peut pas
    // contredire le mot qu'elle porte.
    const html = render({ sequences: [{ ...SEQ, verdict: 'green' }] });
    const tag = /<span[^>]*class="([^"]*)"[^>]*>green</.exec(html)?.[1] ?? '';
    expect(tag, 'le verdict vert porte une étiquette').not.toBe('');
    expect(tag).toContain('text-ok');
    expect(tag).toContain('bg-ok-bg');
    expect(tag).not.toContain('skill');
    expect(tag).not.toContain('text-err');
    expect(tag).not.toContain('text-warn');
  });

  it('sans preuve, la ligne dit ce qui manque et ne montre aucun verdict', () => {
    const html = render({ live: false });
    expect(html).toContain('No proof ran for this process.');
    expect(html).not.toContain('>green<');
    expect(html).not.toContain('>red<');
  });
});

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

  it('surface décochée ⇒ la mention, avec le libellé du réglage, et la section n’est pas vide', async () => {
    const html = await open({ skippedSurfaces: ['fileOps'] });
    expect(html).toContain('not verified');
    expect(html).toContain('File tools is out of verification');
    expect(html).toContain('data-testid="verification-skipped-fileOps"');
  });

  it('projet sans commandes / en attente d’approbation ⇒ deux phrases distinctes', async () => {
    const html = await open({
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

  it('un document ne renvoie PAS vers une carte de projet (v7-A)', async () => {
    // Dire à quelqu'un d'aller ajouter des commandes de preuve sur la carte de
    // projet d'un classeur l'envoie chercher un réglage qui n'existe pas :
    // aucun écran ne configure la vérification d'un document.
    const html = await open({
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

  it('un type inconnu ne se fait PAS passer pour un document', async () => {
    // Le jour où un envoi (`outbound_action`) atteint cette liste, « is a
    // document » serait faux sans que rien ne le signale.
    const html = await open({
      unconfigured: [
        {
          deliverableType: 'outbound_action',
          canonicalKey: 'telegram:42',
          displayPath: null,
          reason: 'not_configured',
        },
      ],
    });
    expect(html).toContain('is not checked yet');
    expect(html).not.toContain('is a document');
    expect(html).not.toContain('project card in Code');
  });

  it('une preuve : ses commandes dans l’ordre des rangs, code de sortie, durée, verdict', async () => {
    const html = await open({ sequences: [SEQ] });
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
