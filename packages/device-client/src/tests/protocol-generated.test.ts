// protocol-generated.test.ts — the client's copy of the protocol IS the protocol module (#950).
//
// The client cannot import packages/shared/src/device-protocol.ts at run time
// (it carries Zod), so scripts/gen-protocol.ts prints its types and constants
// into src/protocol.generated.ts. This renders them again and compares: a
// protocol change that is not regenerated fails here, with the command to run.
//
// Mutation verified: an event removed from the generated file (or a field
// renamed in it) → "is the protocol module, as generated now" turns red.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as shared from '@nodal-agents/shared';
import { GENERATED_FILE, renderProtocol } from '../../scripts/gen-protocol.ts';
import type * as generated from '../protocol.generated.ts';

/** True only when A and B are the same type. */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameTypes: [
  Same<generated.DeviceEvent, shared.DeviceEvent>,
  Same<generated.DeviceCardChoice, shared.DeviceCardChoice>,
  Same<generated.DeviceCapability, shared.DeviceCapability>,
  Same<generated.DeviceEventType, shared.DeviceEventType>,
] = [true, true, true, true];

describe('the generated protocol @cap:parler-par-canal-externe/moteur', () => {
  it('is the protocol module, as generated now (run `pnpm --filter @nodal-agents/device-client gen`)', () => {
    expect(readFileSync(GENERATED_FILE, 'utf8')).toBe(renderProtocol());
    expect(sameTypes).toEqual([true, true, true, true]);
  }, 60_000);
});
