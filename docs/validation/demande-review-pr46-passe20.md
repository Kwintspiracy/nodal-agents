# Demande de review — PR #46, passe 20 (P3 : preuves et envois dans l'espace)

Périmètre : **le commit P3** (apps/web : `getSpaceConversationAction` étendue,
`spaces/[id]/page.tsx`, `spaces/DeliveriesCard.tsx`, le test de l'action).
P1 et P2 sont clos (passes 16 et 19).

## Ce que ça pose (plan « De la maquette au produit », P3)

Sous le fil, deux blocs :

- **La preuve** — `VerificationSection`, le composant EXISTANT du détail Code,
  réutilisé tel quel (il n'est jamais vide : « pas encore », « hors
  vérification », « rien à configurer »). Alimenté par la même lecture que
  `getCodingProcessDetailAction` : `verification_runs` du job ET de ses
  délégués (T24 : la preuve d'un délégué remonte à la racine), bornés à
  l'entité ; `groupVerificationRuns` ; la trace D8 des surfaces décochées
  depuis les jobs (`mergeSkippedSurfaces`), jamais depuis le réglage courant ;
  les livrables non configurés depuis `job_deliverable_verification_state`.
- **Les envois** — `DeliveriesCard`, neuf : `job_deliveries` du job, tel quel
  (`confirmed → sent`, `attempted → retrying`, `prepared → queued`,
  `rejected → rejected`, tentatives, quand). Absent quand il n'y a rien.

Le plan disait « les tests existants de VerificationSection migrent vers la
carte » : en réutilisant le composant, ils n'ont pas à migrer — ils restent
la garde de ce qui s'affiche ici.

## Mesuré

Test pglite : une séquence rouge (typecheck vert, test rouge) posée sur
l'ENFANT remonte dans `verification.sequences` de la racine, rangs dans
l'ordre, `unconfigured` vide ; un `job_deliveries` `attempted`/2 tentatives se
lit tel quel. `tsc` web propre.

## Ce dont je doute moi-même

### `stage={job.status}` sur `VerificationSection`

Le composant lit `stage` seulement pour `stage === 'chat'` (une session de
runtime n'a pas de preuve). Ici c'est un job : n'importe quelle valeur hors
`'chat'` convient. Je passe `job.status` — lisible, mais ce n'est pas un
« stage » au sens de `deriveJobStage`. Est-ce un mésusage qui piègera quelqu'un
plus tard, ou acceptable ?

### La preuve d'un délégué apparaît deux fois si on ouvre l'enfant

`/spaces/<enfant>` montre la preuve de l'enfant ; `/spaces/<racine>` la
montre aussi (remontée T24). Voulu — la racine est ce que l'utilisateur lit.

### Les envois ne sont pas des cartes DANS le fil

La maquette montrait « ✓ parti » dans la carte finale « Ce qui a été produit ».
Ici c'est un bloc sous le fil. La carte `sent` du fil (P1) couvre les envois
faits PAR l'agent via un outil ; `job_deliveries` couvre ceux du runner
(finalisation). Deux sources, deux endroits : est-ce lisible, ou faut-il
fusionner ?

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne
trouves rien de neuf. Un constat non exécuté est marqué NON EXÉCUTÉ.
