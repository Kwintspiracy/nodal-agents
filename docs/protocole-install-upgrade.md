# Protocole install / mise à jour

À rejouer avant **chaque** publication. Destiné à un agent de validation (Codex
ou autre) travaillant sur une copie du dépôt, ou à toi.

Objectif unique : décider si un utilisateur peut installer la version qu'on
s'apprête à publier, ou y passer depuis celle qui est en ligne, **sans que Nodal
refuse de démarrer**.

Les numéros de version dans les commandes ci-dessous sont ceux du 21/08/2026
(0.8.1 → 0.8.5). Remplace-les par la version publiée du moment et celle que tu
prépares ; le reste ne bouge pas.

C'est le seul terrain où ce produit s'est cassé jusqu'ici. La 0.8.0 est partie
sans sept chunks serveur ; la 0.8.1 a re-résolu son propre runtime trois jours
après sa publication. Les deux fois, la suite de tests était verte et
l'installation mourait. Ce protocole ne teste donc pas le code : il teste ce que
reçoit quelqu'un qui tape `npm install`.

## Pré-requis

- Node ≥ 22, pnpm ≥ 10, accès réseau à npm (les deux scripts téléchargent la
  version publiée).
- Environ 4 Go libres sous le répertoire temporaire du système et ~15 min.
- **Aucune préparation de données.** Les deux scripts créent leur propre
  `HOME`/`USERPROFILE` dans un dossier temporaire et le suppriment à la fin.
  Ils ne touchent jamais le `~/.nodalai` de la machine — ni la configuration, ni
  la clé maîtresse, ni la base.
- Les ports utilisés sont hors des valeurs par défaut (`3210/3211/25640` pour
  l'installation neuve, `3310/3311/25740` pour la mise à jour). Une instance
  Nodal qui tourne déjà n'est pas dérangée, et les deux scripts peuvent tourner
  l'un après l'autre sans se marcher dessus.

## Étape 0 — construire le paquet

```bash
pnpm install
pnpm pack:build
```

Le tarball attendu est `pack/nodal-agents-0.8.5.tgz`.

Deux pièges connus, à respecter à la lettre :

1. **Ne pas sauter cette étape même si `pack/` existe déjà.** Un `.next` laissé
   par un build précédent produit un paquet incohérent. `build-pack.mjs` purge
   `apps/web/.next` de lui-même depuis le 20/08 — c'est pour cela qu'il faut
   passer par lui.
2. Si le build échoue sur un chemin du genre
   `.next\standalone\C:\Users\...\ENOENT`, c'est la signature Next standalone +
   pnpm sous Windows. Supprimer `apps/web/.next` et relancer. Si l'échec
   persiste, **c'est un bloquant de publication** : le rapporter tel quel, sans
   contourner.

## Étape 1 — installation neuve

```bash
pnpm pack:smoke
```

Ce que fait le script : `npm init` dans un bac à sable, installation du tarball,
vérification des dépendances épinglées, `init --non-interactive`, `up`, attente
de `/api/health`, récupération d'une vraie page, `down`.

**Attendu :** sortie 0, et la ligne finale confirmant que les deux services
répondent.

## Étape 2 — mise à jour depuis la version publiée

C'est l'étape qui compte le plus, et celle qui n'existait pas avant le 21/08.

```bash
pnpm pack:upgrade -- --from 0.8.1
```

Sans `--from`, le script part de `latest` (aujourd'hui : 0.8.1 — donc le même
parcours ; l'argument explicite documente l'intention et survivra à la
publication de la 0.8.5).

Le script installe la **0.8.1 réelle depuis npm**, la configure, tente de la
démarrer, vérifie qu'un état existe bel et bien sur le disque, puis installe le
tarball local **par-dessus** et contrôle quatre choses :

| # | Contrôle | Ce qu'un échec signifie |
|---|---|---|
| 1 | La 0.8.5 atteint `/api/health` | Une installation existante ne peut pas migrer. Bloquant. |
| 2 | La page d'accueil se rend vraiment (`<h1>` présent) | Incident 0.8.0 : `/api/health` restait vert pendant que chaque page renvoyait 500. |
| 3 | `secrets.key` est **identique** avant / après | Le plus insidieux. Si la clé maîtresse change, tous les identifiants et clés LLM chiffrés en base deviennent définitivement illisibles — sans erreur, sans avertissement. |
| 4 | `pg-data/PG_VERSION` existe toujours | L'utilisateur a perdu sa base. |

**Attendu :** sortie 0.

**Ce qui n'est PAS un échec :** l'avertissement
`0.8.1 did NOT become healthy`. La 0.8.1 est cassée depuis que `next@16.3.0` est
sorti — c'est justement la raison d'être de la 0.8.5. Le script le signale et
continue, parce que la question posée est « la nouvelle version rattrape-t-elle
un répertoire écrit par l'ancienne ? », pas « l'ancienne marchait-elle ? ».

## Étape 3 — l'interruption

Les scripts couvrent le parcours nominal. Ce cas-ci demande des mains, parce
qu'aucun script ne peut envoyer un vrai Ctrl+C à un groupe de processus Windows.

> **Cette étape n'est couverte par aucune CI, et ne peut pas l'être.**
>
> Deux raisons, toutes deux définitives. D'abord, Ctrl+C est un signal émis par
> la console à ses processus attachés : un programme peut tuer un processus, il
> ne peut pas produire ce signal-là. Ensuite, le runner Windows de GitHub est
> incapable d'énumérer sa propre table de processus — les deux chemins
> PowerShell (CIM et WMI) expirent, à 6 comme à 20 secondes, sans concurrence à
> blâmer. Établi sur quatre passages le 21/08/2026.
>
> Les cas de test qui en dépendent s'ignorent donc automatiquement sur une
> machine qui ne répond pas, en annonçant la raison. La logique de parcours
> d'arbre reste testée partout ; c'est l'accès à la table réelle qui saute.
>
> **Cette étape manuelle est donc la seule couverture réelle de ce
> comportement.** Ne pas la sauter.

1. Depuis le dépôt : `pnpm --filter nodal-agents exec tsx src/index.ts --dev`
2. Attendre `All services healthy`.
3. **Ctrl+C** dans le terminal.
4. Relancer la même commande.

**Attendu :** le second démarrage ne signale aucun orphelin. S'il affiche
`Found N orphan process ... web on :3000`, c'est le bug B4 qui revient : les
workers Turbopack survivent à l'arbre tué. Reporter le PID et la ligne de
commande exacte (`Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"`).

Et un cas voisin, qui a produit un vrai défaut la dernière fois : occuper le
port 3000 avec **un serveur qui n'est pas Nodal** (n'importe quel `python -m
http.server 3000`), puis lancer `up`. Attendu : `up` **refuse de démarrer** et
nomme le processus étranger. S'il le tue, c'est une régression grave — il
supprimerait le travail d'un tiers sans prévenir.

## Ce qu'il faut rapporter

Pour chaque étape : la commande exacte, le code de sortie, et les vingt
dernières lignes en cas d'échec. Pour l'étape 3, le PID et la ligne de commande
du processus survivant.

Et surtout — la distinction qui a fait perdre le plus de temps au dernier tour :
séparer **« le produit a un défaut »** de **« mon cas de test décrivait autre
chose »**. Sur cinq bloquants remontés le 20/08, deux étaient des défauts réels
et trois venaient du protocole lui-même. Les deux verdicts sont utiles ; les
confondre ne l'est pas.
