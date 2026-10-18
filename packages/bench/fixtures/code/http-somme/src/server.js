// Un petit service HTTP : GET /somme?a=2&b=3 répond {"somme":5} en JSON.
import { createServer as createHttpServer } from 'node:http';

export function createServer() {
  return createHttpServer((req, res) => {
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ erreur: 'pas encore implémenté' }));
  });
}
