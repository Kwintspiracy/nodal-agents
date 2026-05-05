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

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  noNativeDialogs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);

export default eslintConfig;
