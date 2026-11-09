// device-address.ts — the address a device connects to, read from the real network setting (#946).
//
// A device talks to the RUNNER, not to the dashboard: its routes (pairing, its
// stream, its turns) are the runner's, on the runner's port (the port of
// `RUNNER_URL`). Which host reaches it depends on how Nodal listens:
//   - network access on (`lan`, the runner binds 0.0.0.0): each LAN address of
//     this computer, on the runner's port;
//   - this computer only (`loopback`, 127.0.0.1): a device on the network
//     cannot reach Nodal; a module on THIS computer still can, at 127.0.0.1.
// The runner accepts both hosts (`isAllowedHost`: loopback and private
// addresses), and a device sends no `Origin`, so the origin check lets it in.

export interface DeviceAddress {
  mode: 'lan' | 'loopback';
  urls: string[];
}

export function deviceAddress(
  network: { runtimeBind: 'loopback' | 'lan'; lanAddresses: readonly string[] },
  runnerUrl: string,
): DeviceAddress {
  const url = new URL(runnerUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (network.runtimeBind === 'lan') {
    return { mode: 'lan', urls: network.lanAddresses.map((a) => `${url.protocol}//${a}:${port}`) };
  }
  return { mode: 'loopback', urls: [`${url.protocol}//127.0.0.1:${port}`] };
}
