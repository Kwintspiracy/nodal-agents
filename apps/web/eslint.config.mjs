import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

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
// `warn` for now — this surfaces the exact per-file backlog for the Phase 2
// migration (see the ESLint output) without breaking the build. Phase 2 flips
// this to `error` once every consumer above is migrated.
const noRawFormElements = {
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['src/components/ui/**'],
  rules: {
    'no-restricted-syntax': [
      'warn',
      {
        selector: "JSXOpeningElement[name.name='button']",
        message:
          'Use the design-system component (PrimaryButton/RowActionButton/IconButton/TextInput/TextArea/Select/Checkbox) instead of a raw <button>.',
      },
      {
        selector: "JSXOpeningElement[name.name='input']",
        message:
          'Use the design-system component (PrimaryButton/RowActionButton/IconButton/TextInput/TextArea/Select/Checkbox) instead of a raw <input>.',
      },
      {
        selector: "JSXOpeningElement[name.name='select']",
        message:
          'Use the design-system component (PrimaryButton/RowActionButton/IconButton/TextInput/TextArea/Select/Checkbox) instead of a raw <select>.',
      },
      {
        selector: "JSXOpeningElement[name.name='textarea']",
        message:
          'Use the design-system component (PrimaryButton/RowActionButton/IconButton/TextInput/TextArea/Select/Checkbox) instead of a raw <textarea>.',
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  noNativeDialogs,
  noRawFormElements,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);

export default eslintConfig;
