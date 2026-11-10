// devices/device-secrets.ts — the secrets of a pairing, drawn and hashed in ONE place (#946).
//
// Three secrets, all from the CSPRNG (`node:crypto`):
//   - the DEVICE CODE: 32 bytes, base64url — what a device polls with, secret;
//   - the USER CODE: 6 digits — what the device shows or says, for the owner
//     to compare; not a secret, a check that both sides see the same request;
//   - the DEVICE TOKEN: `ndv_` + 32 bytes, base64url — the device's key.
// Nodal keeps only the sha256 of the device code and of the token.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { DEVICE_TOKEN_PREFIX } from '@nodal-agents/shared';

/** sha256, hex: how a device code and a device token are kept. */
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function drawDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

export function drawUserCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function drawDeviceToken(): { token: string; tokenHash: string } {
  const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashDeviceSecret(token) };
}
