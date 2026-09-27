// table-cells.lint.test.ts — la garde des tables, prouvée sur la VRAIE
// configuration ESLint de apps/web (#522).
//
// La règle vit dans `eslint.config.mjs` (`no-restricted-syntax`) ; `pnpm lint`
// la fait tourner en CI. Ce fichier prouve qu'elle mord encore : une règle de
// lint dont le sélecteur ne correspond plus à rien reste verte à jamais, sans
// que personne le voie. On lui donne donc des fichiers écrits exprès, sous des
// chemins de page, et on lit ce qu'elle répond.
//
// Ce qu'elle doit refuser :
//   1. la recette que Logs portait avant #522 (`font-mono text-xs text-ink-3`)
//      sur un <Td> ;
//   2. une classe de texte n'importe où DANS une cellule, même profonde, même
//      dans un gabarit `${…}` ;
//   3. un <table>, un <tr>, un <td> écrits à la main.
// Ce qu'elle doit laisser passer :
//   4. la mise en page d'une cellule (`hidden md:table-cell`, `max-w-*`) et
//      l'alignement (`text-right`) ;
//   5. une table brute dans un TEST, qui monte une ligne dans un parent valide.
//
// Mutation vérifiée : le sélecteur des classes de texte retiré de la
// configuration → les cas 1 et 2 rougissent.

import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = join(WEB, 'src', 'app', '(dashboard)', 'fixture', 'FixtureTable.tsx');
const TEST = join(WEB, 'src', 'app', '(dashboard)', 'fixture', '__tests__', 'Fixture.test.tsx');

const eslint = new ESLint({ cwd: WEB });

/** Les messages de la règle des tables pour ce code, à ce chemin. */
async function tableErrors(code: string, filePath = PAGE): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => m.message);
}

const HEAD = `import Table, { THead, Th, Tr, Td, CellMono } from '@/components/ui/Table';\n`;

describe('la règle des tables, sur la configuration réelle', () => {
  it('refuse la recette brute que Logs portait sur ses nombres', async () => {
    const errors = await tableErrors(
      `${HEAD}export function X({ n }: { n: number }) {
  return (
    <Table><tbody><Tr>
      <Td align="right" className="font-mono text-xs text-ink-3">{n}</Td>
    </Tr></tbody></Table>
  );
}\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('No text class inside a table cell');
  });

  it('refuse une classe de texte au fond d’une cellule, et dans un gabarit', async () => {
    const errors = await tableErrors(
      `${HEAD}export function X({ on }: { on: boolean }) {
  return (
    <Table>
      <THead><Th><span className="text-legacy-10 uppercase">A</span></Th></THead>
      <tbody><Tr>
        <Td><div className="flex"><span className={\`\${on ? 'x' : ''} text-[12.5px]\`}>a</span></div></Td>
        <Td><span className="hover:text-ink">b</span></Td>
      </Tr></tbody>
    </Table>
  );
}\n`,
    );
    expect(errors).toHaveLength(3);
  });

  it('refuse une classe que la règle ne peut pas lire : variable, appel, propriété, même dans une condition (revue Codex de la PR #525)', async () => {
    const errors = await tableErrors(
      `${HEAD}const cellClass = 'text-sm text-red-500';
const cn = (...c: string[]) => c.join(' ');
const styles = { cell: 'font-mono' };
export function X({ on }: { on: boolean }) {
  return (
    <Table><tbody><Tr>
      <Td className={cellClass}>a</Td>
      <Td><span className={cn('text-xs')}>b</span></Td>
      <Td><span className={styles.cell}>c</span></Td>
      <Td><span className={on ? cellClass : 'flex'}>d</span></Td>
      <Td><span className={on && cellClass}>e</span></Td>
    </Tr></tbody></Table>
  );
}\n`,
    );
    // Les cinq classes illisibles, plus la chaîne `'text-xs'` passée à `cn(…)`,
    // que la règle des classes de texte lit et refuse aussi.
    expect(errors.filter((e) => e.includes('write classes in the clear'))).toHaveLength(5);
    expect(errors.filter((e) => e.includes('No text class inside a table cell'))).toHaveLength(1);
  });

  it('laisse passer une condition entre chaînes, dont le test est une variable', async () => {
    const errors = await tableErrors(
      `${HEAD}export function X({ on }: { on: boolean }) {
  return (
    <Table><tbody><Tr>
      <Td><span className={on ? 'rotate-90' : 'flex'}>a</span></Td>
    </Tr></tbody></Table>
  );
}\n`,
    );
    expect(errors).toEqual([]);
  });

  it('refuse une table écrite à la main', async () => {
    const errors = await tableErrors(
      `export function X() {
  return <table><tbody><tr><td>a</td></tr></tbody></table>;
}\n`,
    );
    expect(errors.filter((m) => m.includes('never raw table markup'))).toHaveLength(3);
  });

  it('laisse passer la mise en page et l’alignement d’une cellule', async () => {
    const errors = await tableErrors(
      `${HEAD}export function X({ n }: { n: number }) {
  return (
    <Table>
      <THead><Th align="right" className="hidden md:table-cell">N</Th></THead>
      <tbody><Tr>
        <Td align="right" className="hidden max-w-[320px] md:table-cell"><div className="mt-1.5 text-right"><CellMono>{n}</CellMono></div></Td>
      </Tr></tbody>
    </Table>
  );
}\n`,
    );
    expect(errors).toEqual([]);
  });

  it('laisse un test monter une ligne dans une table brute', async () => {
    const errors = await tableErrors(
      `export function X() {
  return <table><tbody><tr><td>a</td></tr></tbody></table>;
}\n`,
      TEST,
    );
    expect(errors).toEqual([]);
  });
});
