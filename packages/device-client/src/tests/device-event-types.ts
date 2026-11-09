// The protocol's event types, read from the Zod schema of the protocol module.
import { DeviceEventSchema } from '@nodal-agents/shared';

export const DEVICE_EVENT_TYPES_FOR_TEST: string[] = DeviceEventSchema.options.map(
  (o) => o.shape.type.value,
);
