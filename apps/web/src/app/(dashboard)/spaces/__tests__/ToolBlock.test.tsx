// ToolBlock.test.tsx — un appel d'outil sur UNE ligne, dépliable (#135) : son
// nom, son argument, la pastille de son issue et sa durée sur la ligne ; son
// entrée et son résultat dans le corps, et nulle part ailleurs.
//
// Deux façons de rendre, pour deux questions différentes :
//   — `renderToStaticMarkup` pour ce que la ligne DIT sans qu'on y touche
//     (couleurs, absence du résumé, appel muet non dépliable) ;
//   — jsdom + `createRoot`/`act` pour ce que le CLIC change, parce que c'est
//     là que vit la promesse « chaque bloc se déplie pour son compte ».
//
// Et le bloc de réflexion, qui ne porte plus que le compte de SES étapes.

import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import ToolBlock, { excerptOfInput, hasBody } from '../ToolBlock.tsx';
import ThinkingBlock from '../ThinkingBlock.tsx';
import type { Step } from '@/lib/conversation-feed.ts';

type ToolStep = Extract<Step, { kind: 'tool' }>;

const tool = (over: Partial<ToolStep>): ToolStep => ({
  kind: 'tool',
  toolName: 'x',
  toolCallId: 'c',
  jobId: 'job-1',
  card: null,
  presented: null,
  input: {},
  outputText: null,
  outcome: 'success',
  durationMs: 300,
  lineCounts: {},
  question: null,
  ...over,
});

/** Rend dans jsdom, de quoi CLIQUER la tête du bloc. */
async function mount(step: ToolStep): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ToolBlock step={step} />);
  });
  return container;
}

async function clickHead(container: HTMLDivElement): Promise<void> {
  const head = container.querySelector('button');
  if (!head) throw new Error('le bloc n’a pas de tête cliquable');
  await act(async () => {
    head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('excerptOfInput', () => {
  it('rend la valeur seule quand l’entrée n’a qu’un champ texte', () => {
    expect(excerptOfInput({ query: 'session' })).toBe('session');
  });

  it('rend des paires clé=valeur quand il y a plusieurs champs', () => {
    expect(excerptOfInput({ pattern: 'session', path: 'src/auth' })).toBe(
      'pattern=session path=src/auth',
    );
  });

  it('coupe à 60 caractères et replie les sauts de ligne', () => {
    const long = excerptOfInput({ text: 'a\nb'.padEnd(200, 'c') });
    expect(long).toHaveLength(60);
    expect(long?.endsWith('…')).toBe(true);
    expect(long).not.toContain('\n');
  });

  it('rend null sur une entrée vide — il n’y a rien à mettre entre parenthèses', () => {
    expect(excerptOfInput({})).toBeNull();
    expect(excerptOfInput(null)).toBeNull();
    expect(excerptOfInput({ text: '   ' })).toBeNull();
  });
});

describe('hasBody', () => {
  it('un appel réussi qui n’a RIEN à dire n’a pas de corps', () => {
    expect(hasBody(tool({ input: {}, outputText: null, presented: null }))).toBe(false);
  });

  it('une erreur a toujours son corps, même sans sortie', () => {
    expect(hasBody(tool({ outcome: 'error', input: {}, outputText: null }))).toBe(true);
  });
});

describe('ToolBlock', () => {
  const searchStep = tool({
    toolName: 'mcp_files__grep',
    card: 'search',
    input: { query: 'session', path: 'src/auth' },
    presented: { card: 'search', query: 'session', total: 12, hits: [], truncated: false },
    durationMs: 300,
  });

  it('replié, il tient sur UNE ligne : le résumé du résultat n’est pas dans le DOM', () => {
    const html = renderToStaticMarkup(<ToolBlock step={searchStep} />);
    expect(html).toContain('>grep<'); // le préfixe de serveur MCP est retiré
    expect(html).toContain('(query=session path=src/auth)');
    expect(html).toContain('300 ms');
    expect(html).toContain('aria-expanded="false"');
    // Le corps n'est pas rendu : ni le résumé, ni les libellés, ni l'entrée.
    expect(html).not.toContain('12 matches');
    expect(html).not.toContain('>Input<');
    expect(html).not.toContain('>Result<');
    // Réussi : la pastille est verte, pas rouge.
    expect(html).toContain('bg-ok');
    expect(html).not.toContain('bg-err');
    expect(html).not.toMatch(/text-\[\d/);
  });

  it('la ligne se lit par la COULEUR : outil, argument, durée', () => {
    const html = renderToStaticMarkup(<ToolBlock step={searchStep} />);
    expect(html).toMatch(/class="[^"]*text-feed-tool[^"]*"[^>]*>grep</);
    expect(html).toMatch(/class="[^"]*text-feed-argument[^"]*"[^>]*>\(query=/);
    expect(html).toMatch(/class="[^"]*text-feed-metric[^"]*"[^>]*>300 ms</);
  });

  it('replié, le corps est ABSENT du DOM — pas seulement masqué', async () => {
    // La différence compte : un corps rendu puis caché en CSS reste dans le
    // document (il pèse, il se lit au clavier, il sort dans un copier-coller).
    // Le bloc promet de ne pas le rendre du tout tant qu'on ne l'a pas ouvert.
    const container = await mount(searchStep);
    expect(container.innerHTML).not.toContain('Input');
    expect(container.innerHTML).not.toContain('Result');
    expect(container.innerHTML).not.toContain('12 matches');
    expect(container.querySelectorAll('pre')).toHaveLength(0);

    await clickHead(container);

    expect(container.innerHTML).toContain('Input');
    expect(container.innerHTML).toContain('Result');
    expect(container.innerHTML).toContain('12 matches');
  });

  it('le clic ouvre le corps : l’entrée complète, puis le résultat', async () => {
    const container = await mount(searchStep);
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('12 matches');

    await clickHead(container);

    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Input');
    expect(container.textContent).toContain('"query": "session"');
    expect(container.textContent).toContain('Result');
    expect(container.textContent).toContain('12 matches');
  });

  it('un bloc BRUT ne dit qu’il est brut que dans son corps', async () => {
    const step = tool({
      toolName: 'assign_lead',
      card: 'delegation',
      presented: null,
      input: { agent: 'reviewer-c', task: 'relire la recherche mémoire' },
      outputText: 'assigned',
    });
    const folded = renderToStaticMarkup(<ToolBlock step={step} />);
    expect(folded).toContain('assign_lead');
    expect(folded).not.toContain('delegation · raw');

    const container = await mount(step);
    await clickHead(container);
    expect(container.textContent).toContain('delegation · raw');
    expect(container.textContent).toContain('assigned');
  });

  it('un appel sans carte enregistrée le dit, une fois ouvert', async () => {
    const container = await mount(tool({ toolName: 'file_read', outputText: 'deux lignes' }));
    await clickHead(container);
    expect(container.textContent).toContain('no card recorded');
  });

  it('un appel en échec peint son résultat en err', async () => {
    const step = tool({ outcome: 'error', outputText: 'ENOENT: no such file' });
    expect(renderToStaticMarkup(<ToolBlock step={step} />)).toContain('bg-err');
    const container = await mount(step);
    await clickHead(container);
    expect(container.textContent).toContain('ENOENT: no such file');
    expect(container.innerHTML).toContain('text-err');
  });

  it('une approbation en attente porte la pastille bleue, et le dit dans son corps', async () => {
    const step = tool({ outcome: 'awaiting_approval' });
    expect(renderToStaticMarkup(<ToolBlock step={step} />)).toContain('bg-run');
    const container = await mount(step);
    await clickHead(container);
    expect(container.textContent).toContain('awaiting approval');
  });

  it('un appel muet n’offre pas un chevron qui n’ouvre rien', () => {
    const html = renderToStaticMarkup(
      <ToolBlock step={tool({ input: {}, outputText: null, durationMs: null })} />,
    );
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('border-t');
  });
});

describe('ThinkingBlock', () => {
  it('sans raisonnement, il n’y a pas de bloc', () => {
    expect(renderToStaticMarkup(<ThinkingBlock steps={[]} />)).toBe('');
  });

  it('compte SES étapes, prend les couleurs du fil, et garde le texte replié', () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock steps={['il faut lire session.ts', 'puis le corriger']} />,
    );
    expect(html).toContain('Reasoning');
    expect(html).toContain('2 steps');
    // #135 — les nombres du TOUR ne s'accrochent plus ici : ils ont leur bloc.
    expect(html).not.toContain('tokens');
    expect(html).toMatch(/class="[^"]*text-feed-reasoning[^"]*"[^>]*>Reasoning</);
    expect(html).toMatch(/class="[^"]*text-feed-metric[^"]*"[^>]*>2 steps</);
    expect(html).not.toContain('italic');
    expect(html).not.toContain('il faut lire session.ts');
    expect(html).not.toMatch(/text-\[\d/);
  });

  it('dit « 1 step » au singulier', () => {
    const html = renderToStaticMarkup(<ThinkingBlock steps={['une pensée']} />);
    expect(html).toContain('1 step<');
    expect(html).not.toContain('1 steps');
  });
});
