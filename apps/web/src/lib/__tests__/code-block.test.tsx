// code-block.test.tsx — le bloc de code du fil (P2bis) : la pastille de
// langue, le nom du fichier, et une gouttière de numéros qui compte les vraies
// lignes.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CodeBlock from '@/components/ui/CodeBlock';

describe('CodeBlock', () => {
  const html = renderToStaticMarkup(
    <CodeBlock code={'const a = 1;\nconst b = 2;\n'} lang="ts" filename="src/auth/session.ts" />,
  );

  it('numérote les lignes écrites, sans en inventer une pour le saut final', () => {
    expect(html).toContain('>1</div>');
    expect(html).toContain('>2</div>');
    expect(html).not.toContain('>3</div>');
  });

  it('montre la langue en pastille et le nom du fichier', () => {
    expect(html).toContain('ts');
    expect(html).toContain('src/auth/session.ts');
  });

  it('garde le code tel qu’il a été écrit et propose de le copier', () => {
    expect(html).toContain('const a = 1;');
    expect(html).toContain('Copy');
  });

  it('sans langue ni nom de fichier, l’en-tête ne porte que la copie', () => {
    const bare = renderToStaticMarkup(<CodeBlock code="echo hi" />);
    expect(bare).toContain('echo hi');
    expect(bare).toContain('Copy');
    expect(bare).toContain('>1</div>');
  });

  it('sans numéros de ligne, le code reste entier, coloré et copiable — la gouttière seule s’en va', () => {
    const plain = renderToStaticMarkup(
      <CodeBlock code={'{\n  "limit": 10\n}'} lang="json" lineNumbers={false} />,
    );
    expect(plain).not.toContain('>1</div>');
    expect(plain).not.toContain('>2</div>');
    expect(plain).toMatch(/class="text-code-key">&quot;limit&quot;</);
    expect(plain).toContain('Copy');
  });

  it('n’écrit aucune taille de police en pixels', () => {
    expect(html).not.toMatch(/text-\[\d/);
  });

  it('en JSON, chaque sorte de valeur porte SA couleur', () => {
    const json = renderToStaticMarkup(
      <CodeBlock code={'{\n  "limit": 10,\n  "query": "typecheck"\n}'} lang="json" />,
    );
    expect(json).toMatch(/class="text-code-key">&quot;limit&quot;</);
    expect(json).toMatch(/class="text-code-string">&quot;typecheck&quot;</);
    expect(json).toMatch(/class="text-code-number">10</);
    expect(json).toMatch(/class="text-code-bracket">\{</);
    // Rien n'est perdu : couleurs retirées, le texte est celui qu'on a donné.
    expect(json.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"')).toContain('"limit": 10,');
  });

  it('hors JSON, aucun jeton n’est coloré', () => {
    expect(html).not.toMatch(/text-code-(?:key|string|number|keyword|punct|bracket)/);
  });

  it('le bloc pose son fond de code, et laisse son espacement à l’appelant', () => {
    expect(html).toContain('bg-code-bg');
    expect(html).toContain('mb-3');
    expect(renderToStaticMarkup(<CodeBlock code="echo hi" className="" />)).not.toContain('mb-3');
  });
});
