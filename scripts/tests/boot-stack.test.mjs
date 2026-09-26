// boot-stack.test.mjs — la CI attend la stack comme un utilisateur l'attend.
//
// Pourquoi (#514) : `ci.yml` et `qa.yml` lançaient la stack avec `&` dans une
// étape, puis la sondaient 5 minutes à l'aveugle. Deux défauts, les mêmes dans
// les deux workflows :
//   - tout ce que la stack écrivait APRÈS la fin de l'étape de lancement était
//     perdu : le journal s'arrêtait à « Starting embedded Postgres… » quelle que
//     soit la phase où la stack était vraiment ;
//   - la boucle avait son propre délai (300 s), concurrent de celui du CLI
//     (300 s pour le web en --dev) : si la stack mourait, la boucle continuait à
//     sonder un cadavre ; si elle était lente, la boucle abandonnait sans rien
//     dire de ce qu'elle faisait.
// Le script suit donc le PROCESSUS du CLI : il s'arrête dès que la stack répond,
// ou dès que le CLI meurt — avec sa sortie — et le seul délai qui décide est
// celui du CLI, le même que pour tout utilisateur. Le plafond du script n'est
// qu'un filet, et il le dit.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attendreLaStack, lancerEtAttendre, finDuJournal, estPrete } from '../lib/boot-stack.mjs';

describe('attendreLaStack', () => {
  // Horloge et sondes simulées : chaque appel à `attendre` avance le temps.
  function monde({ repondA = Infinity, meurtA = Infinity, codeDeSortie = 1 } = {}) {
    let t = 0;
    return {
      maintenant: () => t,
      attendre: async (ms) => {
        t += ms;
      },
      sonder: async () => t >= repondA,
      sortie: () => (t >= meurtA ? { code: codeDeSortie } : null),
    };
  }

  it('la stack répond : prête, au temps où elle a répondu', async () => {
    const m = monde({ repondA: 6_000 });
    const v = await attendreLaStack({ ...m, plafondMs: 60_000, pasMs: 2_000 });
    expect(v).toEqual({ etat: 'prete', apresMs: 6_000 });
  });

  it('le CLI meurt avant de répondre : échec IMMÉDIAT, avec son code, sans attendre le plafond', async () => {
    const m = monde({ meurtA: 4_000, codeDeSortie: 3 });
    const v = await attendreLaStack({ ...m, plafondMs: 600_000, pasMs: 2_000 });
    expect(v).toEqual({ etat: 'morte', code: 3, apresMs: 4_000 });
  });

  it('ni réponse ni mort : le filet se déclenche au plafond, et le verdict le nomme comme tel', async () => {
    const m = monde();
    const v = await attendreLaStack({ ...m, plafondMs: 10_000, pasMs: 2_000 });
    expect(v).toEqual({ etat: 'plafond', apresMs: 10_000 });
  });

  it('une stack qui répond au moment où le CLI sort encore : la réponse l’emporte', async () => {
    // Le CLI de dev ne sort pas une fois prêt, mais un lanceur qui rend la main
    // (un `up` détaché) sort en code 0 APRÈS avoir servi : ce n'est pas une mort.
    const m = monde({ repondA: 4_000, meurtA: 4_000, codeDeSortie: 0 });
    const v = await attendreLaStack({ ...m, plafondMs: 60_000, pasMs: 2_000 });
    expect(v.etat).toBe('prete');
  });
});

describe('estPrete', () => {
  // Le critère de `curl -f` que les workflows utilisaient avant : ne pas
  // l'élargir en silence. Une 404 pendant que le web démarre n'est pas un dashboard.
  it('2xx et 3xx : prête ; 4xx et 5xx : pas prête', () => {
    expect([200, 204, 302, 307].map(estPrete)).toEqual([true, true, true, true]);
    expect([400, 404, 500, 503].map(estPrete)).toEqual([false, false, false, false]);
  });
});

describe('finDuJournal', () => {
  it('rend les N dernières lignes, sans ligne vide finale', () => {
    const texte = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n';
    expect(finDuJournal(texte, 3)).toBe('l7\nl8\nl9');
  });
});

describe('lancerEtAttendre, sur de VRAIS processus', () => {
  let dossier;
  afterEach(() => {
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it('un lanceur qui meurt : échec rendu dès sa mort, et le journal contient tout ce qu’il a écrit', async () => {
    dossier = mkdtempSync(join(tmpdir(), 'boot-stack-'));
    const journal = join(dossier, 'stack.log');
    const debut = Date.now();
    const v = await lancerEtAttendre({
      commande: process.execPath,
      args: [
        '-e',
        "console.log('- Starting embedded Postgres…'); console.error('initdb: boom'); process.exit(7)",
      ],
      url: 'http://127.0.0.1:9/',
      journal,
      plafondMs: 120_000,
      pasMs: 200,
    });
    expect(v.etat).toBe('morte');
    expect(v.code).toBe(7);
    // Mort en quelques centaines de ms : le plafond de 2 minutes n'a pas été attendu.
    expect(Date.now() - debut).toBeLessThan(30_000);
    const ecrit = readFileSync(journal, 'utf8');
    expect(ecrit).toContain('- Starting embedded Postgres…');
    expect(ecrit).toContain('initdb: boom');
  });

  it('un lanceur qui sert : prêt, et il continue de tourner après le retour (la suite des étapes en a besoin)', async () => {
    dossier = mkdtempSync(join(tmpdir(), 'boot-stack-'));
    const journal = join(dossier, 'stack.log');
    const serveur =
      "const s=require('http').createServer((q,r)=>{r.writeHead(307,{location:'/login'});r.end()});" +
      "s.listen(0,'127.0.0.1',()=>{require('fs').writeFileSync(process.env.PORT_FILE,String(s.address().port));console.log('ready')});" +
      'setTimeout(()=>process.exit(0),20000)';
    const portFile = join(dossier, 'port');
    // Le port n'est connu qu'une fois le serveur ouvert : la sonde le lit au vol.
    const v = await lancerEtAttendre({
      commande: process.execPath,
      args: ['-e', serveur],
      env: { ...process.env, PORT_FILE: portFile },
      url: () => {
        try {
          return `http://127.0.0.1:${readFileSync(portFile, 'utf8')}/`;
        } catch {
          return null;
        }
      },
      journal,
      plafondMs: 30_000,
      pasMs: 200,
    });
    expect(v.etat).toBe('prete');
    // Toujours vivant : une redirection (307, l'écran de connexion) compte comme une réponse.
    expect(() => process.kill(v.pid, 0)).not.toThrow();
    process.kill(v.pid);
  });
});
