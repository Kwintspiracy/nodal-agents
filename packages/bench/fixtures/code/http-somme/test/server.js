import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET /somme additionne a et b', async () => {
  const res = await fetch(`${base}/somme?a=2&b=3`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), { somme: 5 });
});

test('les décimaux et les négatifs', async () => {
  const res = await fetch(`${base}/somme?a=-1.5&b=4`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { somme: 2.5 });
});

test("un paramètre qui n'est pas un nombre est une erreur 400", async () => {
  const res = await fetch(`${base}/somme?a=deux&b=3`);
  assert.equal(res.status, 400);
});

test('une autre route répond 404', async () => {
  const res = await fetch(`${base}/autre`);
  assert.equal(res.status, 404);
});
