// devices/device-streams.ts — the streams a device holds open right now (#946).
//
// Every streamed answer a device reads with its key (its event stream, a
// voice reply, a voice turn, a chat turn) is registered here by the device
// gate (devices/device-auth.ts), with the way to CUT it. Removing a device
// cuts them all at once: its key stops working on the next request, and what
// it is listening to or playing stops now, not at the next reconnection.
//
// It is also what "Connected" means in Settings → Devices: the device holds at
// least one open stream.
//
// In memory, per runner process: a stream lives in the process that serves it.

const open = new Map<string, Set<() => void>>();

/** Registers an open stream of `deviceId`, with what cuts it. Returns its unregistration. */
export function registerDeviceStream(deviceId: string, cut: () => void): () => void {
  let set = open.get(deviceId);
  if (!set) {
    set = new Set();
    open.set(deviceId, set);
  }
  set.add(cut);
  return () => {
    const s = open.get(deviceId);
    if (!s) return;
    s.delete(cut);
    if (s.size === 0) open.delete(deviceId);
  };
}

/** Cuts every open stream of `deviceId`. Returns how many were cut. */
export function cutDeviceStreams(deviceId: string): number {
  const set = open.get(deviceId);
  if (!set) return 0;
  const cuts = [...set];
  open.delete(deviceId);
  for (const cut of cuts) cut();
  return cuts.length;
}

/** Does `deviceId` hold an open stream right now? */
export function isDeviceConnected(deviceId: string): boolean {
  return (open.get(deviceId)?.size ?? 0) > 0;
}
