---
name: revue-codex
description: Boucle de vérification Claude ↔ Codex sur une PR. Deux documents distincts — une demande de REVIEW (lecture) et, quand la lecture ne suffit pas, un plan de TEST (exécution). Chaque constat rendu est vérifié à la source avant d'être accepté. Invoquer quand Quentin dit /revue-codex, « fais relire par Codex », ou pendant une /loop de vérification.
---

# /revue-codex — faire relire, puis faire éprouver

Une review lit le code. Un test l'exécute. Confondre les deux produit le pire
résultat possible : un rapport qui *déduit* un comportement et l'énonce avec la
même assurance qu'une mesure.

Vécu le 22/08 sur la PR #8 : Codex a conclu, correctement, que deux mutations
resteraient vertes — mais par déduction, la sandbox lecture seule lui
interdisant de les appliquer. La conclusion était juste ; elle aurait pu ne pas
l'être, et rien dans le rapport ne l'aurait signalé.

## Les deux documents

| Document | Quand | Sandbox | Ce qu'il produit |
|---|---|---|---|
| `docs/validation/demande-review-pr<N>.md` | toujours | `read-only` | des constats tracés : fichier, ligne, ce qui casse |
| `docs/validation/plan-de-test-pr<N>.md` | quand la lecture ne suffit pas | `workspace-write` | des résultats mesurés : commande, sortie, verdict |

**Le plan de test n'est pas systématique.** L'écrire quand la lecture ne peut
pas trancher :

- une mutation à appliquer réellement (« ce test rougit-il si je casse ça ? ») ;
- un comportement qui dépend du réseau, du système de fichiers, de l'OS ;
- une mesure : coût, tokens, latence, couverture ;
- un chemin de bout en bout que personne n'a jamais fait tourner ;
- **tout constat qu'un rapport précédent a rendu sans l'exécuter.**

Ce dernier cas est le plus important. Un constat déduit est une hypothèse bien
argumentée, pas un fait.

## Écrire une demande de review

Interdire les trois verdicts inutiles : « ça a l'air bien », « conforme aux
bonnes pratiques », « je confirme ». Deux verdicts valent : le constat tient,
le constat est faux.

Structure : ce que la PR affirme → les questions classées par priorité → ce qui
est hors périmètre → ce qui n'est PAS attendu (style, nommage).

Nommer explicitement **ce dont on doute soi-même**. Une demande qui cache ses
propres points faibles obtient une review qui les rate.

## Écrire un plan de test

Une ligne par test, et pour chacune :

| Champ | Pourquoi |
|---|---|
| La commande **exacte** | pas « lance les tests » : la ligne à taper |
| Le résultat attendu | écrit AVANT de lancer, sinon on rationalise après coup |
| Ce que le résultat inverse prouverait | c'est ce qui rend le test utile |

Et la règle qui fait tout tenir :

> **Un test qui ne peut pas être exécuté doit être rapporté comme NON EXÉCUTÉ,
> jamais conclu par lecture.** C'est le résultat le plus utile qu'un rapport
> puisse rendre quand l'environnement manque.

### Restaurer l'état

Un plan de test qui mute le dépôt dit **comment revenir en arrière**, et le
rapport confirme que c'est fait. Vérifier `git status` après réception : une
mutation oubliée dans l'arbre de travail est un piège pour la session suivante.

## Lancer Codex

```bash
# Review — lecture seule
codex exec --sandbox read-only --skip-git-repo-check --ignore-user-config "<consigne>" < /dev/null

# Test — écriture dans le workspace, demande l'accord de Quentin AVANT
codex exec --sandbox workspace-write --skip-git-repo-check --ignore-user-config "<consigne>" < /dev/null
```

**`< /dev/null` n'est pas décoratif.** Lancé en tâche de fond sans lui,
`codex exec` affiche `Reading additional input from stdin...` et **attend
indéfiniment** : l'entrée standard reste ouverte et il n'a aucune raison de
conclure qu'elle est vide. Perdu 37 minutes ainsi le 22/08 — le processus était
bien vivant, l'arbre de travail propre, aucune sortie.

Comment le diagnostiquer en une commande, plutôt qu'en interprétant l'absence
de sortie (elle est bufferisée jusqu'à la fin, donc silencieuse dans les deux
cas) : **compter les processus ENFANTS.**

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" |
  Where-Object { $_.CreationDate -gt (Get-Date "<heure du lancement>") }
```

Zéro enfant après plusieurs minutes = bloqué. Codex passe par PowerShell pour
chaque commande shell sous Windows : s'il travaille, il en engendre. C'est le
seul signal fiable, `ps` sous Git Bash mélangeant dates et heures de façon
inexploitable.

`--ignore-user-config` n'est pas optionnel. Sans lui, Codex charge le
`~/.codex/config.toml` de Quentin, qui apporte ses serveurs MCP personnels
**avec leurs secrets** et met `[windows] sandbox = "elevated"` — donc aucun
confinement. C'est l'objet de la PR #6, et c'est ainsi qu'une clé s'est
retrouvée imprimée en clair.

**`workspace-write` se demande.** La lecture seule peut être lancée sans
préavis : elle ne peut rien casser. Le mode écriture laisse un agent modifier
le dépôt sans que Quentin voie les actions défiler — ça se demande à chaque
fois, en disant quels fichiers seront touchés.

Codex tourne sous l'abonnement de Quentin dans les deux cas. Le dire.

## Traiter un rapport

**Ne jamais appliquer un constat sur parole.** Le rapport est une piste, pas
une autorité. Chaque constat est vérifié à la source — le code, la base, l'API
du fournisseur — avant qu'une ligne ne bouge.

Cette règle a servi dans les deux sens le 22/08 :

- un constat « bloquant » sur les prix OpenRouter : **vrai**, vérifié sur
  `/api/v1/models`, correctif appliqué ;
- mon propre constat « le modèle phare est aveugle » : **faux**, démonté en
  exécutant la vraie expression de décision — 8 modèles sur 11 concernés, et
  pas ceux que j'avais nommés.

Un rapport qui me donne tort est le meilleur résultat de la boucle.

## Quand s'arrêter

Quand une passe ne trouve **rien de neuf**. Pas quand elle ne trouve rien : une
passe qui redit les constats déjà traités confirme seulement qu'ils sont
traités.

Compter les passes. Si la passe N trouve encore des constats bloquants dans les
correctifs de la passe N-1, ce n'est plus une boucle de vérification, c'est le
signe que la PR a la mauvaise forme — le dire plutôt que d'itérer.
