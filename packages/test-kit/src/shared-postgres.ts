// shared-postgres.ts — UN Postgres par run de vitest, une base neuve par
// fichier `.pg.test.ts` (#471).
//
// Chaque fichier `.pg` démarrait son propre cluster : `initdb` + `pg_ctl
// start`, cinq à dix secondes chacun, dix-huit fichiers. Le verrou de la
// machine (#130) les sérialise, mais son attente est bornée à 45 s pour qu'un
// démarrage coincé ne bloque pas tout le monde ; mesuré sur sept runs complets
// le 24/09, SIX À HUIT démarrages sur vingt-six abandonnaient la file
// (`PG_CLUSTER_START_UNSERIALISED`) et partaient ensemble, sur une machine déjà
// saturée par le reste de la suite. Le fichier qui tombait changeait d'un run
// à l'autre, et passait seul.
//
// La cause est la file elle-même : dix-huit `initdb` pour dix-huit bases. Le
// projet vitest `pg` (voir les `vitest.config.ts`) démarre donc UN serveur dans
// son `globalSetup` — qui ne tourne que si le run contient des fichiers `.pg`
// — et chaque fichier y reçoit sa base, créée par `CREATE DATABASE`. Chaque
// fichier applique toujours les VRAIES migrations, sur une base vide qui n'est
// qu'à lui.
//
// DEUX FICHIERS `.pg` N'Y PASSENT PAS, et c'est voulu : ceux d'`apps/cli`
// (`postgres-auth-stop`, `postgres-logging`). Ils testent le CYCLE DE VIE d'un
// cluster (démarrage, arrêt, journaux) par `startEmbeddedPostgres`, pas une
// base par `startRealPostgres` : un serveur partagé leur retirerait justement
// ce qu'ils prouvent. Leur paquet n'a donc pas de projet `pg`, et ils gardent
// chacun leur cluster (revue de la PR #499).

/** La clé `provide`/`inject` du serveur partagé. */
export const SHARED_POSTGRES_KEY = 'nodalSharedPostgres';

/** Ce que le `globalSetup` transmet aux fichiers : où joindre le serveur. */
export interface SharedPostgres {
  port: number;
  dataDir: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    [SHARED_POSTGRES_KEY]: SharedPostgres | undefined;
  }
}
