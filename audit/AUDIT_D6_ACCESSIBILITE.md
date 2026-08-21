# D6 — Accessibilité WCAG 2.1 AA

**2026-08-07** · dashboard réel de l'install packée (`http://127.0.0.1:3010`), navigateur Chrome ·
contrôles écrits dans la page plutôt que via axe-core chargé de l'extérieur (la CSP bloquerait le
script, et un calcul maison permet de nommer le token fautif plutôt qu'un sélecteur)

**Le dernier contrôle bloqué de l'audit est levé.**

---

## UX-001 — Deux tokens de couleur échouent au contraste AA, dans les deux thèmes

```
ID: UX-001   TOPIC: UX   SEVERITE: P2   CONFIANCE: Confirmed   EFFORT: S
IMPACT: Friction (utilisateurs malvoyants, écrans peu contrastés, lumière du jour)
```

### Explication simple

Le texte secondaire du dashboard — les intitulés de section de la barre latérale, les libellés
d'aide, les compteurs — est trop pâle pour être lu par une personne malvoyante, et à la limite du
lisible pour tout le monde sur un écran en plein soleil. Ce n'est pas dix bugs éparpillés : c'est
**deux variables de couleur** utilisées partout. Une correction dans la définition du token couvre
toutes les occurrences.

### Mesure

10 échecs sur 42 nœuds de texte en thème clair, 8 en thème sombre — mais seulement **quatre
combinaisons couleur/fond distinctes**, toutes issues de deux tokens.

| Token | Alias | Thème clair | Thème sombre |
|---|---|---|---|
| `--text-faint` | `--c-ink-4` | `#9a9a9a` | `#6a6a66` |
| `--text-muted` | `--c-ink-3` | `#6a6a6a` | `#9a9a96` |

| Combinaison mesurée | Ratio | Requis | Occurrences | Exemples |
|---|---:|---:|---:|---|
| `#9a9a9a` sur `#f2f2f2` @11px | **2.51** | 4.5 | 5 | « Overview », « Build », « Operate », « Workspace » |
| `#9a9a9a` sur `#ffffff` @12px | **2.81** | 4.5 | 3 | « Drag a worker here », séparateurs |
| `#6a6a6a` sur `#eaeaea` @14px | **4.50** | 4.5 | 1 | « 1 agent » |
| `#6a6a6a` sur `#eaeaea` @12px | **4.50** | 4.5 | 1 | « group workers under a coordinator » |
| `#6a6a66` sur `#1c1c20` @12px (sombre) | **3.13** | 4.5 | 3 | idem |

Les deux lignes à 4.50 sont exactement à la limite : elles échouent au calcul exact et passeraient à
l'arrondi. À traiter quand même — un token qui frôle la conformité la perdra au premier ajustement de
fond.

Classes utilitaires concernées : `text-ink-4`, `text-ink-3`, `text-mono-11`, `text-mono-12`,
`text-body-12`, `text-micro-10`.

### Valeurs minimales conformes, calculées

| Token | Fond | Actuel | Ratio | **Minimum conforme** | Ratio obtenu |
|---|---|---|---:|---|---:|
| `--text-faint` clair | `#f2f2f2` | `#9a9a9a` | 2.51 | **`#6e6e6e`** | 4.55 |
| `--text-faint` clair | `#ffffff` | `#9a9a9a` | 2.81 | **`#767676`** | 4.54 |
| `--text-muted` clair | `#eaeaea` | `#6a6a6a` | 4.50 | **`#696969`** | 4.56 |
| `--text-faint` sombre | `#1c1c20` | `#6a6a66` | 3.13 | **`#848484`** | 4.54 |

`--text-faint` apparaît sur deux fonds différents en clair (`#f2f2f2` en barre latérale, `#ffffff` en
contenu) : la valeur à retenir est la plus contrainte, **`#6e6e6e`**, qui satisfait les deux.

**VERIFICATION 1** `[B]` — calcul du ratio depuis les styles calculés du DOM réel, fond effectif
obtenu en remontant l'arbre jusqu'au premier ancêtre opaque et en composant les couches
semi-transparentes. Seuils WCAG appliqués correctement, y compris la règle « grand texte » (≥ 24px,
ou ≥ 18.66px en gras → 3:1).
**VERIFICATION 2** `[B]` — bascule `data-theme` clair/sombre dans la page et re-mesure ; puis
résolution des tokens CSS pour remonter des couleurs observées aux variables sources.

### CHALLENGE

1. *Protection ailleurs ?* Non. Aucun test n'assert de contraste ; la branche `worktree-contrast-audit`
   existe mais n'est pas fusionnée dans `main`.
2. *Design délibéré ?* Oui pour l'intention — c'est une hiérarchie visuelle voulue, du texte
   « secondaire » doit être plus discret. Le défaut n'est pas la hiérarchie, c'est son amplitude :
   2.51:1 n'est pas discret, c'est illisible pour une partie des utilisateurs.
3. *Est-ce vraiment AA ?* Oui. 1.4.3 exige 4.5:1 pour le texte normal, sans exception de taille au-dessus
   de 24px. Tout le texte concerné est à 11-14px.
4. *Faux positif du calcul ?* Le fond effectif est composé en remontant les couches, pas lu sur le
   parent immédiat — c'est l'erreur classique et elle est évitée. Les valeurs correspondent aux
   couleurs déclarées dans les tokens, ce qui les confirme.
5. *Code mort ?* Non — page `/agents` de l'install packée, thème par défaut.
6. *Pourquoi pas de plainte ?* Un utilisateur unique avec une bonne vue sur un bon écran ne le voit
   pas. C'est précisément le mode de défaillance de l'accessibilité.

**Résultat : Survived, P2.**

### OPTIONS

```
A) Corriger les deux tokens aux valeurs calculées ci-dessus.
   Effort : S. Compromis : la hiérarchie visuelle s'aplatit un peu — le texte
   « faint » devient nettement plus présent. Risque résiduel : aucun sur ces
   combinaisons ; d'autres fonds non visités peuvent encore échouer.

B) Corriger les tokens ET ajouter un test Playwright qui rejoue ce calcul sur
   les pages principales, dans les deux thèmes, et échoue sous 4.5:1.
   Effort : M. C'est la seule option qui empêche la régression.

C) Ne toucher qu'aux deux pires combinaisons (2.51 et 2.81) et laisser les deux
   à 4.50. Effort : XS. Risque résiduel : un token à la limite exacte repasse
   sous le seuil au premier ajustement de fond.
```

### CHALLENGE DE L'OPTION RECOMMANDÉE

B coûte un test qui doit connaître les pages à visiter, et il faudra le maintenir quand l'UI bouge —
un test d'accessibilité qui casse à chaque refonte finit désactivé, et un garde-fou désactivé est pire
qu'absent parce qu'il se lit comme une couverture. Le coût réel est donc dans le choix du périmètre :
trois pages stables valent mieux que toutes les pages. Ce que B ne corrige pas : les combinaisons sur
des fonds jamais visités par le test. A seule laisse le problème revenir au premier changement de
palette — et c'est déjà arrivé, la branche `worktree-contrast-audit` en témoigne.

### ★ RECOMMANDATION

**Option B, avec le test limité à trois pages et aux deux thèmes.** La raison qui tranche : le
contraste est un défaut qui revient à chaque ajustement de palette, et il est invisible pour la
personne qui l'introduit — exactement le profil de défaut qui exige une vérification par la machine
plutôt que par l'œil. Si l'effort est contraint : corriger les deux tokens (A) et ouvrir le test au
prochain passage sur le design system.

---

## Autres critères — résultats

### Échecs

| Critère | Niveau | Constat |
|---|---|---|
| **1.1.1 Contenu non textuel** | A | **3 SVG** ni étiquetés (`aria-label` / `<title>`) ni masqués (`aria-hidden="true"`), et hors d'un contrôle déjà nommé. Un lecteur d'écran les annonce comme des images sans nom. Correctif : `aria-hidden="true"` sur les icônes décoratives, `aria-label` sur les autres. Effort XS. |
| **3.3.2 Étiquettes ou instructions** | A | Le champ de recherche (`input[type=search]`) n'a ni `<label>`, ni `aria-label`, ni `aria-labelledby`. Un placeholder ne compte pas — il disparaît à la saisie. Correctif : `aria-label`. Effort XS. |

### Contrôles qui tiennent

| Critère | Constat |
|---|---|
| **3.1.1 Langue de la page** | `lang="en"` présent sur `<html>` |
| **1.3.1 Hiérarchie de titres** | Aucun saut de niveau ; exactement **un `h1`** |
| **4.1.1 Analyse syntaxique** | Aucun identifiant dupliqué |
| **2.4.3 Ordre de focus** | Aucun `tabindex` positif — l'ordre de tabulation suit le DOM |
| **4.1.2 Nom, rôle, valeur** | Tous les boutons et liens visibles portent un nom accessible |

C'est une base saine : les défauts structurels qui coûtent cher à réparer (hiérarchie, ordre de focus,
ids) sont absents. Ce qui reste est de la finition.

---

## Limites de ce passage

- **Une seule page** (`/agents`) instrumentée. Les autres écrans peuvent porter d'autres combinaisons.
  Les deux tokens fautifs étant globaux, le défaut de contraste est certain ailleurs ; son ampleur
  ne l'est pas.
- **Navigation clavier non parcourue** (2.1.1, 2.4.7) : l'absence de `tabindex` positif est bon signe,
  mais je n'ai pas tabulé la page pour vérifier que chaque élément interactif est atteignable et que
  l'indicateur de focus est visible. `--border-focus` vaut `#6a6a6a`, à vérifier contre le seuil de
  3:1 du critère 1.4.11.
- **Lecteur d'écran non utilisé.** Les noms accessibles sont calculés depuis le DOM, pas entendus.
- **`prefers-reduced-motion`** non vérifié.

Ces quatre points sont les seuls contrôles d'accessibilité encore ouverts.
