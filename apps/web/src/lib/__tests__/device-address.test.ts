// device-address.test.ts — the address Settings → Devices shows is the runner's, in the mode Nodal listens in (#946).

import { describe, it, expect } from 'vitest';
import { deviceAddress } from '../device-address.ts';

describe('the address a device connects to @cap:parler-par-canal-externe/moteur', () => {
  it('network access on: each LAN address, on the RUNNER port (the device routes are the runner’s)', () => {
    expect(
      deviceAddress(
        { runtimeBind: 'lan', lanAddresses: ['192.168.1.20', '10.0.0.7'] },
        'http://127.0.0.1:3001',
      ),
    ).toEqual({ mode: 'lan', urls: ['http://192.168.1.20:3001', 'http://10.0.0.7:3001'] });
  });

  it('this computer only: the loopback address, so a module on this computer can still pair', () => {
    expect(
      deviceAddress(
        { runtimeBind: 'loopback', lanAddresses: ['192.168.1.20'] },
        'http://127.0.0.1:4101',
      ),
    ).toEqual({
      mode: 'loopback',
      urls: ['http://127.0.0.1:4101'],
    });
  });

  it('no LAN address detected: none is invented', () => {
    expect(
      deviceAddress({ runtimeBind: 'lan', lanAddresses: [] }, 'http://127.0.0.1:3001'),
    ).toEqual({
      mode: 'lan',
      urls: [],
    });
  });
});
