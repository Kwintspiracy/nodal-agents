// whatsapp-library-load.test.ts — the WhatsApp transport library is loaded when
// a socket is opened, never when the delivery package is imported.
//
// 0.9.6 (16/10/2026): `npm install -g nodal-agents` failed on every machine
// without git, because @whiskeysockets/baileys pulls libsignal from a git URL.
// The pack no longer installs baileys from npm: the runner bundle carries its
// own copy. The dashboard imports this package (actions.ts → getAdapter) for
// Discord and Slack and never opens a WhatsApp socket, so it must load without
// the library on disk. Opening a socket where the library is absent fails with
// a coded error instead of a bare MODULE_NOT_FOUND.
//
// The library is mocked as MISSING at the module boundary: its factory throws
// the same error Node raises for a package that is not installed.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@whiskeysockets/baileys', () => {
  throw new Error("Cannot find package '@whiskeysockets/baileys' imported from socket-manager.ts");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WhatsApp library loading @cap:parler-par-canal-externe/moteur', () => {
  it('the delivery package loads, and serves the other channels, without the WhatsApp library', async () => {
    const delivery = await import('../index.ts');

    expect(typeof delivery.ensureWhatsAppSocket).toBe('function');
    expect(delivery.getAdapter('discord').channel).toBe('discord');
    expect(delivery.getAdapter('slack').channel).toBe('slack');
  });

  it('opening a socket without the library ends "closed" with a coded error naming the library', async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const { ensureWhatsAppSocket, closeWhatsAppSocket } =
      await import('../channels/whatsapp/socket-manager.ts');
    const { DeliveryError } = await import('../errors.ts');

    const handle = ensureWhatsAppSocket('missing-library', { sessionDir: '/sessions/none' });
    expect(handle.getStatus()).toBe('connecting');

    await vi.waitFor(() => expect(handle.getStatus()).toBe('closed'));
    expect(errors).toHaveLength(1);
    const [label, err] = errors[0]!;
    expect(label).toBe('[whatsapp] connect failed');
    expect(err).toBeInstanceOf(DeliveryError);
    expect((err as InstanceType<typeof DeliveryError>).code).toBe('whatsapp_library_unavailable');
    expect((err as Error).message).toContain(
      'the WhatsApp library @whiskeysockets/baileys could not be loaded (',
    );
    // The import's own failure is kept, not replaced (vitest wraps a throwing
    // factory once more, hence the walk down the cause chain).
    const causes: string[] = [];
    for (let c = (err as Error).cause; c instanceof Error; c = c.cause) causes.push(c.message);
    expect(causes.join('\n')).toContain("Cannot find package '@whiskeysockets/baileys'");
    closeWhatsAppSocket('missing-library');
  });
});
