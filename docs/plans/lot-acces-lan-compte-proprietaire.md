<!-- artifact: https://claude.ai/code/artifact/ba83711a-106a-4157-9b3d-a8ca14200c5a -->

# Lot — Accès LAN : le propriétaire réclame son compte

**État : livré et validé de bout en bout sur l'install réelle (23/08). Reste à
merger : #16, geste de Quentin.**

## Suivi

| # | Lot | PR | État |
|---|-----|----|----|
| 1 | Pont local-trust → local-auth (3 morceaux) | #16 | 🔄 CI verte, validée live, à merger |

## Le problème (vécu, pas théorique)

Quentin a activé l'accès LAN pour son portable. Résultat : stack morte au
restart, puis cul-de-sac. Deux trous produit à racine commune — **personne
n'avait construit le pont entre les deux modes d'auth** :

1. Le toggle LAN (Settings → Network) écrivait `bind: "lan"` en laissant le
   `auth.mode: "local-trust"` explicite posé le 16/08 par le formulaire
   Security → config que le CLI refuse de booter (garde de l'audit, Fix #12).
2. Une fois en local-auth, l'écran de login était mort : sign-in impossible
   (aucun credential n'existe) et sign-up fermé (« this workspace already has
   an owner » — le propriétaire existe en base, garde MED-2).

## La voie canonique (#16)

| Morceau | Comportement |
|---|---|
| Toggle LAN | lan + local-trust explicite → aligne `local-auth` dans le même merge, bandeau UI. Plus jamais de config imbootable |
| Page de login | résout l'état : `fresh` → sign-up du 1er utilisateur ; `claim` → création du compte propriétaire ; `ready` → sign-in. L'onglet sign-up n'apparaît que s'il peut réussir |
| `claimOwnerAccount` | one-shot sous advisory lock, rattache email + credential à l'utilisateur EXISTANT (même id → même workspace). Hash `better-auth/crypto`. Plusieurs users sans compte → `claim_ambiguous`, échec fort |

## Vérification

- 9 tests provider — dont le décisif : le credential créé passe le **vrai**
  endpoint better-auth `/api/auth/sign-in/email` (200 + cookie).
- 7 tests actions web : config résultant bootable, rows réelles, one-shot.
- Suites complètes auth 92/92, web 931/931 ; typecheck, lint, dep-cruiser, CI verts.
- **Live sur l'install réelle** : écran « Create your account » rendu, compte
  créé depuis le portable de Quentin via `http://192.168.50.197:3000`, vérifié
  en base : user seedé `…0001` porte `quentinbeau@gmail.com`, credential
  rattaché, workspace `…0002` intact, session active.

## Ce que la vérification a corrigé en route

| Constat | Correctif |
|---|---|
| Icône œil du mot de passe hors du champ (bug préexistant, invisible tant que personne ne voyait /login) | positionnement déplacé sur un conteneur — `IconButton` impose `relative` qui gagne sur l'`absolute` de l'appelant (`a1c7e8e`) |
| Cache Turbopack corrompu par le crash Bun du 23/08 (boot > 5 min puis abandon) | purge `apps/web/.next` ; pas un bug du lot, consigné comme piège |

## Ce que le lot ne couvre pas

| Reporté | Pourquoi |
|---|---|
| Sortir du LAN (retour loopback) ne propose pas de re-basculer en local-trust | choix conservateur : garder le mot de passe est toujours sûr |
| Changement de mot de passe depuis l'UI | à vérifier : better-auth l'expose, pas encore de surface Settings |
| Le CLI pourrait pointer vers l'écran de claim dans son message de refus | cosmétique, le refus ne devrait plus jamais se produire |
