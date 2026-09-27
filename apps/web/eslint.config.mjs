import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import { blocTypeScript, blocTestsTypeScript } from '../../eslint.shared.mjs';

// Native browser dialogs (window.confirm/alert/prompt or their bare global form)
// are banned. Use the designed <ConfirmDialog /> component instead — see
// memory/feedback_no_browser_native_dialogs.md.
const noNativeDialogs = {
  rules: {
    'no-restricted-globals': [
      'error',
      { name: 'confirm', message: 'Use <ConfirmDialog /> instead of window.confirm.' },
      { name: 'alert', message: 'Use a toast (sonner) instead of window.alert.' },
      { name: 'prompt', message: 'Use a designed input modal instead of window.prompt.' },
    ],
    'no-restricted-properties': [
      'error',
      {
        object: 'window',
        property: 'confirm',
        message: 'Use <ConfirmDialog /> instead of window.confirm.',
      },
      {
        object: 'window',
        property: 'alert',
        message: 'Use a toast (sonner) instead of window.alert.',
      },
      {
        object: 'window',
        property: 'prompt',
        message: 'Use a designed input modal instead of window.prompt.',
      },
    ],
  },
};

// Raw form/button JSX elements bypass the design system (mismatched button
// sizes side by side in footers, hand-styled inputs with 3+ divergent
// geometries — the UX-DS Phase 1 audit). Ban them everywhere under src/ EXCEPT
// inside components/ui/ itself, where the design-system primitives live and
// are allowed to touch the native element once.
//
// `error` — Phase 2 migrated every consumer to a design-system component
// (245 violations → 0) and Phase 2R reconciled the remaining temporary
// disables (SegmentedControl, CopyButton, DisclosureButton). This is the
// permanent lock: any new raw <button>/<input>/<select>/<textarea> outside
// components/ui/ now fails CI instead of warning.
const rawFormElementSelectors = ['button', 'input', 'select', 'textarea'].map((el) => ({
  selector: `JSXOpeningElement[name.name='${el}']`,
  message: `Use the design-system component (PrimaryButton/RowActionButton/IconButton/TextInput/TextArea/Select/Checkbox) instead of a raw <${el}>.`,
}));

// Les tables (#522, 27/09/2026). `components/ui/Table.tsx` donne le cadre ET le
// contenu des cellules (CellTitle, CellAgent, CellText, CellMono, CellMuted,
// CellActions, TableDetailRow, TablePagination). Avant, chaque table écrivait
// sa typographie de cellule à la main, et douze tables en avaient autant de
// recettes : `font-mono text-xs text-ink-3` ici, `text-mono-12 text-ink-4` là.
//
// Deux interdits, hors de components/ui/ :
//   1. un <table>, <thead>, <tfoot>, <tr>, <td> ou <th> écrit à la main (et une
//      classe sur un <tbody>) : une table passe par <Table>, <Tr>, <Td>… ;
//   2. une classe de TEXTE dans l'arbre d'un <Td> ou d'un <Th>, le <Td>
//      lui-même compris : taille (ramp, `text-xs`, `text-legacy-*`, fraction
//      `text-[…]`), police, graisse, interlignage, espacement, casse, couleur.
//      Il reste permis d'y écrire la MISE EN PAGE (`hidden md:table-cell`,
//      `max-w-[320px]`, `w-8`, `mt-1.5`) et l'alignement (`text-right`).
// La règle lit les classes ÉCRITES dans le JSX (chaîne ou gabarit) ; une classe
// passée par une variable, ou dessinée par un composant défini ailleurs, lui
// échappe. C'est la limite connue : les composants de page qui vivent dans une
// cellule (MemoryFact, ImportanceStars…) ne portent pas de recette de cellule.
const TEXT_CLASS = String.raw`(^|[\s:!])(text-(?!(left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)(\s|$))|font-|leading-|tracking-|uppercase|lowercase|capitalize|italic|tabular-nums)`;
const tableSelectors = [
  {
    selector: 'JSXOpeningElement[name.name=/^(table|thead|tfoot|tr|td|th)$/]',
    message:
      'Build tables with components/ui/Table (Table, THead, Th, Tr, Td, TableDetailRow), never raw table markup.',
  },
  {
    selector: "JSXOpeningElement[name.name='tbody'] JSXAttribute[name.name='className']",
    message: 'A <tbody> carries no style: rows and cells take theirs from components/ui/Table.',
  },
  ...['Literal', 'TemplateElement'].map((node) => ({
    selector: `JSXElement[openingElement.name.name=/^(Td|Th)$/] JSXAttribute[name.name='className'] ${node}[${
      node === 'Literal' ? 'value' : 'value.raw'
    }=/${TEXT_CLASS}/]`,
    message:
      'No text class inside a table cell: use the cell vocabulary of components/ui/Table (CellTitle, CellAgent, CellText, CellMono, CellMuted, CellActions). Layout classes (hidden md:table-cell, max-w-*, w-*) stay allowed.',
  })),
];

const noRawFormElements = {
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['src/components/ui/**'],
  rules: {
    'no-restricted-syntax': ['error', ...rawFormElementSelectors, ...tableSelectors],
  },
};

// Un test d'écran rend une <RunRow> dans un `<table><tbody>` pour qu'elle ait un
// parent valide : les tests gardent l'interdit des champs bruts, pas celui des
// tables.
const noRawFormElementsInTests = {
  files: ['src/**/__tests__/**/*.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  ignores: ['src/components/ui/**'],
  rules: {
    'no-restricted-syntax': ['error', ...rawFormElementSelectors],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Les règles TypeScript du dépôt, importées de la racine et non recopiées :
  // avant l'issue #249, la racine les appliquait à `apps/web` et la CI non, si
  // bien que le même fichier était rouge à la main et vert en intégration.
  blocTypeScript,
  blocTestsTypeScript,
  noNativeDialogs,
  noRawFormElements,
  noRawFormElementsInTests,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);

export default eslintConfig;
