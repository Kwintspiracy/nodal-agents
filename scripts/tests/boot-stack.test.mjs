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
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
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

  it('le CLI est mort et l’adresse répond quand même : c’est le CLI qui décide, la stack est morte', async () => {
    // Le CLI dont le délai de santé expire s'arrête en laissant parfois des
    // enfants qui finissent par répondre. Il a déclaré l'échec : une réponse
    // tardive d'un orphelin ne le contredit pas (revue Codex de la PR #516).
    const m = monde({ repondA: 4_000, meurtA: 4_000, codeDeSortie: 1 });
    const v = await attendreLaStack({ ...m, plafondMs: 60_000, pasMs: 2_000 });
    expect(v).toEqual({ etat: 'morte', code: 1, apresMs: 4_000 });
  });

  it('le CLI meurt PENDANT la sonde qui réussit : morte, pas prête', async () => {
    let mort = false;
    const v = await attendreLaStack({
      maintenant: () => 0,
      attendre: async () => {},
      sonder: async () => {
        mort = true; // la mort arrive pendant l'aller-retour HTTP
        return true;
      },
      sortie: () => (mort ? { code: 9 } : null),
      plafondMs: 60_000,
      pasMs: 2_000,
    });
    expect(v).toEqual({ etat: 'morte', code: 9, apresMs: 0 });
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

  it('la stack SURVIT à la fin du processus qui l’a lancée (l’étape suivante du workflow la teste)', async () => {
    // Le test précédent vérifie l'enfant tant que Vitest vit : il resterait vert
    // si le script retenait son enfant ou l'emportait en sortant. Ici un vrai
    // processus intermédiaire fait ce que fait `boot-stack.mjs` — lancer,
    // attendre, SORTIR — et la sonde passe APRÈS sa sortie (revue Codex de la
    // PR #516, passe 3).
    dossier = mkdtempSync(join(tmpdir(), 'boot-stack-'));
    const portFile = join(dossier, 'port');
    const serveur = join(dossier, 'serveur.cjs');
    writeFileSync(
      serveur,
      "const s=require('http').createServer((q,r)=>{r.writeHead(307,{location:'/login'});r.end()});\n" +
        "s.listen(0,'127.0.0.1',()=>require('fs').writeFileSync(process.env.PORT_FILE,String(s.address().port)));\n" +
        'setTimeout(()=>process.exit(0),30000);\n',
    );
    const lanceur = join(dossier, 'lanceur.mjs');
    writeFileSync(
      lanceur,
      `import { readFileSync } from 'node:fs';\n` +
        `import { lancerEtAttendre } from ${JSON.stringify(new URL('../lib/boot-stack.mjs', import.meta.url).href)};\n` +
        `const v = await lancerEtAttendre({ commande: process.execPath, args: [${JSON.stringify(serveur)}],\n` +
        `  env: { ...process.env, PORT_FILE: ${JSON.stringify(portFile)} },\n` +
        `  url: () => { try { return 'http://127.0.0.1:' + readFileSync(${JSON.stringify(portFile)}, 'utf8') + '/'; } catch { return null; } },\n` +
        `  journal: ${JSON.stringify(join(dossier, 'stack.log'))}, plafondMs: 20000, pasMs: 200 });\n` +
        `console.log(JSON.stringify(v));\n`,
    );
    const sortie = await new Promise((ok, ko) => {
      execFile(process.execPath, [lanceur], { timeout: 25_000 }, (err, stdout) =>
        err ? ko(err) : ok(stdout),
      );
    });
    const v = JSON.parse(sortie.trim());
    expect(v.etat).toBe('prete');
    // Le lanceur est SORTI (execFile a rendu la main) ; le serveur répond encore.
    const r = await fetch(`http://127.0.0.1:${readFileSync(portFile, 'utf8')}/`, {
      redirect: 'manual',
    });
    expect(r.status).toBe(307);
    process.kill(v.pid);
  }, 40_000);

  it('l’adresse répond AVANT le lancement : rien n’est lancé, et le verdict le dit', async () => {
    // Sans ce contrôle, un service déjà en place sur :3000 faisait passer pour
    // prête une stack que son CLI n'avait même pas pu démarrer (port pris), et
    // les parcours testaient autre chose (revue Codex de la PR #516).
    dossier = mkdtempSync(join(tmpdir(), 'boot-stack-'));
    const journal = join(dossier, 'stack.log');
    const marque = join(dossier, 'lance');
    const deja = createServer((_q, r) => {
      r.writeHead(200);
      r.end('someone else');
    });
    await new Promise((ok) => deja.listen(0, '127.0.0.1', ok));
    try {
      const v = await lancerEtAttendre({
        commande: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marque)}, 'x')`],
        url: `http://127.0.0.1:${deja.address().port}/`,
        journal,
        plafondMs: 30_000,
        pasMs: 200,
      });
      expect(v).toEqual({ etat: 'occupee', apresMs: 0, pid: null });
      // La commande n'a PAS tourné : ni sa marque, ni journal ouvert.
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(marque)).toBe(false);
      expect(existsSync(journal)).toBe(false);
    } finally {
      await new Promise((ok) => deja.close(ok));
    }
  });

  // Sous Windows, `pnpm` est un `.cmd` que Node ne lance pas sans shell, et
  // `boot-stack.mjs` y refuse de tourner (voir ce fichier) : le cas n'existe pas.
  it.skipIf(process.platform === 'win32')(
    'la vraie chaîne `pnpm exec` : la mort de l’enfant remonte, avec son code',
    async () => {
      // Le script lance `pnpm … exec tsx …`, pas `node` : si pnpm survivait à son
      // enfant, la mort du CLI resterait invisible (revue Codex de la PR #516).
      dossier = mkdtempSync(join(tmpdir(), 'boot-stack-'));
      const journal = join(dossier, 'stack.log');
      const enfant = join(dossier, 'enfant.mjs');
      writeFileSync(enfant, "console.log('child up');\nprocess.exit(7);\n");
      const v = await lancerEtAttendre({
        commande: 'pnpm',
        args: ['exec', 'node', enfant],
        url: 'http://127.0.0.1:9/',
        journal,
        plafondMs: 60_000,
        pasMs: 200,
      });
      expect(v.etat).toBe('morte');
      expect(v.code).toBe(7);
      expect(readFileSync(journal, 'utf8')).toContain('child up');
    },
    60_000,
  );
});
