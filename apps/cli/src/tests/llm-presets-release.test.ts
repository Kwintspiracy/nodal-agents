// llm-presets-release.test.ts — the setup wizard's endpoint probes never
// leave a response body behind (#608)
//
// `nodal-agents init` probes the model endpoint the person types in: once to
// see whether it answers, once to list its models. A probe that stops reading
// (a refusal, or an answer it only needed the status of) used to leave the
// body open on the connection, where it could hold back the next request to
// that endpoint. The stand-in below never ends its bodies: only the client can
// release them.

import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';

import { fetchModels, isEndpointReachable } from '../lib/llm-presets.ts';

interface StandIn {
  baseURL: string;
  closed: () => boolean[];
  close: () => Promise<void>;
}

const running: StandIn[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function endlessEndpoint(status: number): Promise<StandIn> {
  const states: boolean[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => {
    const i = states.push(false) - 1;
    res.on('close', () => (states[i] = true));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.write('{"data":[');
  });
  server.on('connection', (s) => sockets.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const standIn: StandIn = {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    closed: () => states,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  running.push(standIn);
  return standIn;
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

describe('setup wizard endpoint probes (#608) @cap:installer-et-demarrer/moteur', () => {
  it('a refused model list releases its response', async () => {
    const p = await endlessEndpoint(401);

    expect(await fetchModels(p.baseURL, 'lm-studio', 'k')).toBeNull();
    expect(await until(() => p.closed()[0] === true, 2_000)).toBe(true);
  });

  it('a reachability probe releases the response it only needed the status of', async () => {
    const p = await endlessEndpoint(200);

    expect(await isEndpointReachable(p.baseURL, 'lm-studio')).toBe(true);
    expect(await until(() => p.closed()[0] === true, 2_000)).toBe(true);
  });
});
