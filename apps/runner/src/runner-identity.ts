// runner-identity.ts — l'identité de CE processus runner, un module FEUILLE.
//
// Créée une fois au premier chargement du module — donc une fois au boot — et
// stable pour toute la vie du processus.
//
// POURQUOI elle existe : l'outbox de livraison (`delivery/outbox.ts`) réclame
// une ligne par `UPDATE … SET claimed_by = <cet id> … RETURNING id`, donc
// `claimed_by` doit nommer le processus qui tient réellement le bail. Deux
// runners sur la même base ne doivent jamais se confondre, et un runner qui
// redémarre après un crash doit revenir avec un id DIFFÉRENT — sinon ses
// propres claims périmés passeraient pour les siens d'aujourd'hui.
//
// Rien dans le dépôt ne fournissait cela : `cron/execute-ready.ts` frappe un
// `Math.random().toString(36).slice(2, 10)` PAR APPEL (une étiquette de tick,
// pas une identité de processus), et le port d'écoute n'en est pas une non
// plus — deux installations sur deux machines partagent le port 3001 tout le
// temps.
//
// POURQUOI un module feuille et non `deps.ts` : deps.ts est la racine de
// composition du runner (DB, LLM, embeddings, registre d'outils, auth). Les
// chemins terminaux (run-job.ts, deliver-results.ts) vivent SOUS son graphe et
// importeront `drainDeliveries` ; si l'outbox importait deps.ts pour un seul
// UUID, le cycle serait à un import de distance. deps.ts le RÉEXPORTE : la
// constante reste lisible depuis la racine de composition, sans que le module
// feuille dépende d'elle.
//
// Une constante de module plutôt qu'un champ de `RunnerDeps` : c'est un fait
// sur le PROCESSUS, pas une dépendance qu'un appelant substituerait, et la
// faire passer par `RunnerDeps` forcerait ~36 fabriques de test à en inventer
// une.

import { randomUUID } from 'node:crypto';

export const runnerInstanceId: string = randomUUID();
