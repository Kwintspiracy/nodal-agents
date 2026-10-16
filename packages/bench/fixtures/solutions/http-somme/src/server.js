// Une solution de référence : prouve que la fixture se résout, et sert de livrable vert aux tests du juge.
import { createServer as createHttpServer } from 'node:http';

export function createServer() {
  return createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/somme') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ erreur: 'introuvable' }));
      return;
    }
    const a = Number(url.searchParams.get('a'));
    const b = Number(url.searchParams.get('b'));
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ erreur: 'a et b doivent être des nombres' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ somme: a + b }));
  });
}
