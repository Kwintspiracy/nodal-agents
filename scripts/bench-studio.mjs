#!/usr/bin/env node
// bench-studio.mjs — `pnpm bench:studio` : Bench Studio dans le navigateur.
//
// L'outil LOCAL du propriétaire pour le banc d'essai : le catalogue des
// scénarios, le lancement d'essais, leur suivi en direct, les résultats. Jamais
// livré (ses routes ne sont des routes qu'en mode studio, voir
// apps/web/next.config.ts), et il ne touche jamais la stack qui tourne : son
// port, son dossier de build, sa boucle locale (scripts/lib/bench-studio.mjs).
//
//   pnpm bench:studio               sert sur http://127.0.0.1:4320/bench-studio et l'ouvre
//   pnpm bench:studio --port 4400   un autre port (jamais celui du web ou du runner)
//   pnpm bench:studio --no-open     sans ouvrir le navigateur

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configHoteDepuis, portsDeLaStack } from './lib/live-stack.mjs';
import { nodalHomeEntry } from './lib/nodal-home.mjs';
import {
  STUDIO_HOST,
  STUDIO_PORT,
  assertStudioPort,
  createStudioServer,
  keepFile,
  listenLoopback,
  studioEnv,
} from './lib/bench-studio.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const webDir = join(repoRoot, 'apps', 'web');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Le config.json de l'instance visée (NODALAI_HOME), comme le CLI le lit. */
const HOST_CONFIG = nodalHomeEntry('config.json');

function readHostConfig() {
  try {
    return configHoteDepuis({ texte: readFileSync(HOST_CONFIG, 'utf8'), chemin: HOST_CONFIG });
  } catch (err) {
    if (err && err.code) return configHoteDepuis({ err, chemin: HOST_CONFIG });
    throw err;
  }
}

async function main() {
  const port = assertStudioPort(
    Number(arg('port') ?? STUDIO_PORT),
    portsDeLaStack(readHostConfig(), HOST_CONFIG),
  );
  // Deux jetons distincts : le filtre pose le premier sur chaque requête admise ;
  // le second, seule la page le reçoit et le renvoie (anti-CSRF).
  const gate = randomBytes(24).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  Object.assign(process.env, studioEnv(process.env, port, gate, csrf));

  // Next réécrit next-env.d.ts pour son dossier de build : remis tel quel dès
  // qu'il a fini de se préparer, et encore à la sortie.
  const restore = keepFile(join(webDir, 'next-env.d.ts'));
  const next = createRequire(join(webDir, 'package.json'))('next');
  const app = next({ dev: true, dir: webDir, hostname: STUDIO_HOST, port });
  const stop = () => {
    restore();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await app.prepare();
  } finally {
    restore();
  }
  const server = createStudioServer({
    port,
    gate,
    csrf,
    handle: app.getRequestHandler(),
    upgrade: app.getUpgradeHandler(),
  });
  await listenLoopback(server, port);
  const url = `http://${STUDIO_HOST}:${port}/bench-studio`;
  console.log(`Bench Studio: ${url} (local only; Ctrl+C to stop)`);
  if (!process.argv.includes('--no-open')) {
    const openPath = createRequire(join(repoRoot, 'apps', 'cli', 'package.json')).resolve('open');
    const { default: open } = await import(pathToFileURL(openPath).href);
    await open(url);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
