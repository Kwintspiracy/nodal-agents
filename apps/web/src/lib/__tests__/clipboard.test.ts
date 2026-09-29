// clipboard.test.ts — copier marche partout où le dashboard est servi.
//
// Le 28/09/2026, le bouton Copy de l'identifiant d'un run affichait « Could not
// copy » : le dashboard était ouvert en http sur l'IP du réseau local (bind=lan),
// hors contexte sécurisé, où `navigator.clipboard` n'existe pas. Ces tests
// lisent CE QUI A ÉTÉ COPIÉ, par chacun des chemins, et sur les trois composants
// qui copient — pas seulement le premier qui a été signalé.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

import { copyText } from '../clipboard.ts';
import CopyButton from '../../components/ui/CopyButton.tsx';
import CopyablePath from '../../components/ui/CopyablePath.tsx';
import { SetUrl } from '../../components/ui/SetUrl.tsx';

/** Ce que le presse-papiers a reçu, par l'un ou l'autre chemin. */
let copied: string[] = [];

/** Le navigateur hors contexte sécurisé : aucune API presse-papiers. */
function insecureContext() {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
}

function clipboardApi(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

/** `execCommand('copy')` copie la sélection courante, comme le navigateur. */
function execCommandCopies(ok = true) {
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: (cmd: string) => {
      if (cmd !== 'copy' || !ok) return false;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) {
        copied.push(active.value.slice(active.selectionStart, active.selectionEnd));
      }
      return true;
    },
  });
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  copied = [];
  toasts.success.mockReset();
  toasts.error.mockReset();
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
});

describe('copyText @cap:suivre-execution/ecran', () => {
  it('uses the clipboard API when the context is secure', async () => {
    clipboardApi(async (t) => {
      copied.push(t);
    });
    execCommandCopies();
    await copyText('run-123');
    expect(copied).toEqual(['run-123']);
  });

  it('over http on a LAN IP (no clipboard API) still copies the exact text', async () => {
    insecureContext();
    execCommandCopies();
    await copyText('5f347b0b-6ebf-4212-b7cb-9c123d370283');
    expect(copied).toEqual(['5f347b0b-6ebf-4212-b7cb-9c123d370283']);
    // the helper textarea is gone
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('when the API refuses (document not focused), the fallback copies', async () => {
    clipboardApi(async () => {
      throw new DOMException('Document is not focused.', 'NotAllowedError');
    });
    execCommandCopies();
    await copyText('abc');
    expect(copied).toEqual(['abc']);
  });

  it('when nothing can copy, it throws: the caller must not claim a copy', async () => {
    insecureContext();
    execCommandCopies(false);
    await expect(copyText('abc')).rejects.toThrow('copy_failed');
    expect(copied).toEqual([]);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });
});

async function clickCopy(element: ReturnType<typeof createElement>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy'));
  if (!button) throw new Error('no Copy button');
  await act(async () => {
    button.click();
  });
}

describe('every Copy button works over http on a LAN IP @cap:suivre-execution/ecran', () => {
  const cases: [string, () => ReturnType<typeof createElement>, string][] = [
    [
      'CopyButton (run id)',
      () => createElement(CopyButton, { value: 'run-42', successMessage: 'Run id copied' }),
      'run-42',
    ],
    [
      'CopyablePath',
      () => createElement(CopyablePath, { display: 'out', value: 'D:/work/out' }),
      'D:/work/out',
    ],
    [
      'SetUrl',
      () => createElement(SetUrl, { subtitle: 'Webhook', url: 'http://192.168.1.2:3001/h' }),
      'http://192.168.1.2:3001/h',
    ],
  ];

  for (const [name, make, expected] of cases) {
    it(`${name}: copies the value and says so, no red toast`, async () => {
      insecureContext();
      execCommandCopies();
      await clickCopy(make());
      expect(copied).toEqual([expected]);
      expect(toasts.error).not.toHaveBeenCalled();
      expect(toasts.success).toHaveBeenCalledTimes(1);
    });

    it(`${name}: when nothing can copy, the toast is red, never green`, async () => {
      insecureContext();
      execCommandCopies(false);
      await clickCopy(make());
      expect(copied).toEqual([]);
      expect(toasts.success).not.toHaveBeenCalled();
      expect(toasts.error).toHaveBeenCalledTimes(1);
    });
  }
});
