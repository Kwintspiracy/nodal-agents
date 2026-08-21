# Protocole de commit

Règles de travail pour tout commit sur ce dépôt — humain comme agent.

Elles ne sortent pas d'un manuel de bonnes pratiques. Chacune ferme un incident
réel, daté, avec ses conséquences. Une règle dont on ne peut pas nommer
l'incident n'a rien à faire ici.

## Ce qui a échoué, et pourquoi

**21/08/2026 — un fichier source commité avec 16 octets nuls.**
`packages/db/src/tests/helpers.ts` a été écrit avec seize octets nuls à
**longueur strictement identique** : 34 045 octets avant, 34 045 après. Écriture
interrompue ou incident disque, pas une modification.

Les huit suites pglite du paquet `memory` se sont effondrées sur
`invalid message format`, une erreur du parseur de protocole qui ne désigne rien
de reconnaissable. Il a fallu comparer octet à octet avec le dernier commit vert
pour trouver la cause.

Ce qui l'a rendu invisible : git avait déjà classé le fichier comme **binaire**,
donc `git diff` n'affichait qu'un `Bin 34045 -> 34045` opaque. Aucune relecture,
si attentive soit-elle, n'aurait montré quoi que ce soit.

**21/08/2026 — un rapport de validation embarqué par `git add -A`.**
Un fichier posé à la racine par un agent externe s'est retrouvé commité. Le
scanner de secrets a bloqué la CI sur un SHA-256 qu'il contenait, pris pour une
clé en dur.

**La leçon commune n'est pas « relire plus attentivement ».** Les deux fautes
sont mécaniquement détectables et aucune n'est détectable à l'œil. D'où un
contrôle machine, avant que le commit existe.

## Le contrôle machine

`scripts/check-commit-hygiene.mjs` inspecte l'ensemble **indexé** et refuse :

| Ce qu'il bloque | Incident fermé |
|---|---|
| Octets nuls dans un fichier texte | `helpers.ts`, 21/08 |
| BOM UTF-16 sur un fichier censé être UTF-8 | Redirection PowerShell sans `-Encoding utf8` |
| Rapport, log ou archive à la racine | Rapport de validation, 21/08 |
| Résidus `.orig` / `.rej` / `.bak`, dossiers de scratch | — |
| Clés privées et certificats | — |
| Fichier source de plus de 2 Mo | — |

Il tourne à trois endroits, et c'est délibéré :

- **`.githooks/pre-commit`** — automatique, activé par `pnpm install` via
  `prepare`. Le crochet est versionné et non écrit dans `.git/hooks/` : un
  crochet qui n'existe que sur une machine ne protège personne d'autre.
- **`pnpm hygiene:check`** — à la demande, sur tout le dépôt.
- **La CI** — la copie que personne ne peut contourner. Un crochet local peut
  être désactivé ; celle-ci non.

Échappatoire pour le cas volontaire, rare : `NODAL_SKIP_HYGIENE=1 git commit …`.
S'en servir impose de dire pourquoi dans le message de commit.

## Le protocole humain

Le contrôle machine attrape ce qui est mécanique. Le reste demande un regard.

### 1. Jamais `git add -A` sans avoir regardé

`git add -A` est la façon dont un fichier étranger entre dans un commit. Avant
d'indexer :

```bash
git status --short          # QUOI entre dans le commit
git diff --stat             # AMPLEUR de chaque changement
```

Trois questions sur chaque ligne :

- **Est-ce que je l'ai écrit ?** Un fichier apparu sans que je le crée — sortie
  d'outil, rapport d'agent, artefact — sort du commit ou va dans `.gitignore`.
- **Est-ce que l'ampleur correspond ?** Un fichier auquel on n'a pas touché et
  qui affiche des changements est un signal, pas un détail. Un `Bin ... -> ...`
  sur un fichier source en est un plus fort encore.
- **Est-ce que ça a sa place dans ce commit ?** Un changement sans rapport se
  commite séparément. Un commit qui mélange deux sujets est un commit
  irrécupérable en cas de retour arrière.

### 2. Lire le diff, pas seulement la liste

`git diff --cached` avant de valider. Sur un fichier que git annonce binaire
alors qu'il devrait être du texte, ne pas passer outre : c'est le symptôme exact
du 21/08.

### 3. Faire tourner les portes applicables avant de pousser

Toujours : `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.
Selon la zone touchée : `pnpm deps:check` (architecture), `pnpm pack:smoke`
(distribution), `pnpm pack:upgrade` (mise à jour).

Pousser puis regarder la CI n'est pas une porte : c'est déléguer la relecture à
une machine distante avec dix minutes de latence.

### 4. Vérifier la CI après le push

Systématiquement, jamais « ça devrait passer » :

```bash
gh pr checks <n>
gh run view --job <id> --log-failed
```

### 5. Diagnostiquer avant de rafistoler

Un test rouge est une information, pas une nuisance. La question n'est jamais
« comment le faire passer » mais « qu'est-ce qu'il dit ».

Le 21/08, trois cas rouges sur Windows n'étaient pas des tests capricieux : ils
signalaient qu'un correctif avait ajouté cinq secondes au chemin d'arrêt sur
machine lente. Élargir les délais sans regarder aurait masqué une vraie
régression de performance — celle-là même qu'on cherchait à éviter.

Un test rouge se relit deux fois : ce qu'il affirme, et si l'affirmation est
juste.

### 6. Le message dit pourquoi, pas quoi

Le diff dit déjà quoi. Le message porte ce que le diff ne peut pas porter :
l'incident fermé, l'alternative écartée et sa raison, la mesure qui a tranché.

Un message qui se lit encore dans six mois, quand il faudra comprendre pourquoi
cette ligne est là.

## Sur le `.gitignore`

Le `.gitignore` de ce dépôt s'est construit par accumulation : une exclusion
ajoutée après chaque incident. C'est une liste de refus **réactive**, et elle ne
peut pas être autre chose — elle ne connaît que les fichiers déjà vus.

Elle n'aurait attrapé aucun des deux incidents du 21/08 : le premier portait sur
un fichier **suivi** et légitime, le second sur un fichier **inédit**.

Donc : le `.gitignore` couvre le récurrent et le connu (`node_modules/`,
`.next/`, `*.log`, `pack/`). Ce qui est nouveau ou abîmé relève du contrôle
d'hygiène et de la revue. Ajouter une ligne au `.gitignore` après coup est utile,
mais ce n'est jamais la correction — seulement le classement.

## Où vont les fichiers

| Nature | Emplacement |
|---|---|
| Rapports de validation (internes ou d'agents externes) | `docs/validation/` |
| Protocoles de test | `docs/` |
| Scripts de smoke / build | `scripts/` |
| Fichiers de travail temporaires | hors du dépôt |
| Sorties d'exécution, journaux | hors du dépôt (`*.log` est ignoré) |
