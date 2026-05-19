// catalog/skills/obsidian.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const obsidianSkill: SystemSkill = {
  slug: 'obsidian',
  name: 'Obsidian',
  description: 'Read, search, create, and edit notes in the Obsidian vault.',
  requiredBuiltins: [],
  content: `Skill pour travailler sur un vault Obsidian via le système de fichiers : lire, lister, chercher, créer, éditer des notes, avec maîtrise complète de la syntaxe Obsidian Flavored Markdown.

### Setup

Le vault Obsidian EST le workspace de cet agent (configuré côté dashboard : Agents → Edit → Workspace root path). Tous les paths que tu passes aux \`file_*\` sont **relatifs** à la racine du vault. Ne passe jamais d'absolus, n'inclus pas le chemin du vault.

Si un \`file_*\` retourne \`workspace_not_configured\`, demande à l'utilisateur de configurer le workspace dans le dashboard.

### ⚠️ STEP 1 OBLIGATOIRE — Inspecter l'existant AVANT d'écrire

Une délégation a pu être lancée plusieurs fois (un appel précédent peut avoir foiré APRÈS avoir écrit un fichier — tu n'as aucune mémoire de ces tentatives). Avant TOUT \`file_write\` sur une task d'écriture :

1. **\`file_list({ glob: "*.md", recursive: true })\`** pour voir ce qui existe dans le vault (ou cible le sous-dossier pertinent : \`file_list({ path: "Cosmologie", glob: "*.md" })\`).
2. Si un fichier ressemblant à ta cible existe déjà (même topic, même dossier proche, créé récemment) :
   - **\`file_read\`** pour vérifier son contenu.
   - Si le contenu est complet et répond déjà à la task → **NE PAS RÉ-ÉCRIRE**. Réponds à l'utilisateur en référençant le fichier existant + appelle \`return_result{status:'success'}\` directement.
   - Si le contenu est partiel/incomplet → **\`file_edit\`** ou **\`file_write\`** sur le MÊME chemin (pas un nouveau fichier avec nom légèrement différent). Mieux : enrichis l'existant plutôt que de tout réécrire.
3. Sinon (rien d'équivalent n'existe) : continue le workflow normal de recherche + écriture.

Cette étape coûte 1-2 turns et évite de polluer le vault de doublons quand une tentative précédente a échoué après file_write mais avant return_result.

### ⚠️ Workflow recherche → vault (CRITIQUE — éviter le loop)

Quand tu fais une recherche web (\`firecrawl_search\` / \`firecrawl_scrape\`) ET que la task demande d'écrire dans le vault :

1. **Étape 1 OBLIGATOIRE ci-dessus :** \`file_list\` + éventuellement \`file_read\` pour voir si un brouillon existe déjà.
2. **Fais la recherche en MAX 4-6 tours** (1-2 search + 2-4 scrape ciblés). Ne pas dépasser.
3. **DÈS QUE tu as assez de matière, appelle \`file_write\` IMMÉDIATEMENT.** Pas plus tard. Pas après save_memory. Pas après "encore une recherche pour vérifier".
4. **APRÈS \`file_write\` :** OPTIONNELLEMENT 1 seul \`save_memory\` court (max 200 chars, du type "J'ai écrit X.md dans le vault à propos de Y"). PAS le contenu de la recherche.
5. **Termine :** \`telegram_send_message\` (si jobContext.telegram_chat_id) + \`return_result{status:'success'}\` dans le même tour.

### ❌ Anti-patterns à ÉVITER absolument

- ❌ **Écrire un nouveau fichier avec un nom légèrement différent** (\`Note v2.md\`, \`Note (2).md\`, \`Note-final.md\`) au lieu d'enrichir l'existant trouvé à l'Étape 1 → le vault se pollue de doublons quasi-identiques.
- ❌ \`save_memory\` plusieurs fois avec le contenu de recherche → la mémoire est pour les FAITS DURABLES sur l'utilisateur, pas pour stocker des résumés de recherche. Le résumé va dans le fichier \`.md\`, pas en mémoire.
- ❌ \`mark_memory_outdated\` en boucle pour "mettre à jour" la mémoire → si tu te retrouves à appeler ce tool plus d'une fois sur le même topic dans un job, **stop, tu es en loop, appelle file_write maintenant**.
- ❌ Dire "j'ai sauvegardé dans le vault" via \`save_memory\` ALORS QUE tu n'as pas appelé \`file_write\`. C'est mentir — l'utilisateur ne verra rien dans son vault.
- ❌ Continuer à scraper plus de pages "pour être exhaustif" après 5+ scrapes. Tu as ce qu'il faut. Écris.
- ❌ Skipper l'Étape 1 "parce que tu penses que c'est une nouvelle task" → fais le \`file_list\` quand même. Coût 1 turn, bénéfice : zéro doublon.

### Lire une note

\`file_read({ path: "Daily/2026-05-16.md" })\` — retourne le contenu avec line numbers + pagination. Pour les longues notes, utilise \`offset\` et \`limit\`.

### Lister les notes

- \`file_list({ glob: "*.md", recursive: true })\` — toutes les notes
- \`file_list({ path: "Projects", glob: "*.md" })\` — sous-dossier
- \`file_list({ path: "." })\` — structure top-level

### Rechercher

- \`file_search({ target: "files", pattern: "regex" })\` — par filename
- \`file_search({ pattern: "regex", file_glob: "*.md" })\` — par contenu (défaut)

Skip auto de \`.git\` / \`.obsidian\` / \`node_modules\`.

### Créer une note (le geste central)

\`file_write({ path: "Cosmologie/Fond Diffus Cosmologique 2026.md", content: "# Titre\\n\\n## Section 1\\n...", create_dirs: true })\`

Écriture atomique (tempfile + rename). \`create_dirs: true\` crée les dossiers parents manquants. **C'est ce tool qui matérialise le résultat de ton travail dans le vault** — sans ce call, ton boulot ne se voit nulle part.

**Rappel** : ne pas créer un fichier sans avoir fait l'Étape 1 (\`file_list\` pour vérifier l'existant).

### Éditer une note (changement ciblé)

\`file_edit({ path: "Note.md", old_string: "...", new_string: "..." })\` — quote exact (whitespace compris). Match multiple → fail loud (passe \`replace_all: true\` ou narrow). Match absent → re-read le fichier d'abord.

### Append à une note

Deux approches : (1) **anchored** via \`file_edit\` avec un anchor stable comme \`old_string\` + anchor + nouveau contenu comme \`new_string\`. (2) **full rewrite** : \`file_read\` puis \`file_write\` avec le contenu concaténé.

### Anti-patterns paths

- ❌ Path absolu (\`D:\\...\\foo.md\`) — le workspace te scope déjà, écris juste \`foo.md\`.
- ❌ \`..\` qui sort du vault → \`path_traversal_blocked\` retourné.
- ❌ Lire de grosses notes en entier → pagine avec \`offset\` / \`limit\`.

---

## Référence — Obsidian Flavored Markdown (kepano/obsidian-skills)

Obsidian étend CommonMark + GFM avec wikilinks, embeds, callouts, properties, comments et autres syntaxes. Référence à ouvrir quand tu écris une note structurée pour Quentin.

### Workflow création d'une note

1. **Frontmatter YAML** au début (properties : title, tags, aliases). Voir section "Properties" ci-dessous.
2. **Contenu** en markdown standard + syntaxes Obsidian ci-dessous.
3. **Lier** les notes connexes via wikilinks (\`[[Note]]\`) ; markdown links (\`[text](url)\`) UNIQUEMENT pour URLs externes.
4. **Embed** d'autres notes/images/PDFs via \`![[embed]]\`.
5. **Callouts** pour info mise en avant via \`> [!type]\`.
6. **Vérifier** que la note rend correctement en reading view Obsidian.

> Wikilinks vs Markdown links : \`[[wikilinks]]\` pour les notes du vault (Obsidian track les renames automatiquement), \`[text](url)\` UNIQUEMENT pour URLs externes.

### Internal Links (Wikilinks)

\`\`\`markdown
[[Note Name]]                          Link to note
[[Note Name|Display Text]]             Custom display text
[[Note Name#Heading]]                  Link to heading
[[Note Name#^block-id]]                Link to block
[[#Heading in same note]]              Same-note heading link
\`\`\`

Define a block ID by appending \`^block-id\` to any paragraph :

\`\`\`markdown
This paragraph can be linked to. ^my-block-id
\`\`\`

Pour les listes et quotes, place le block ID sur une ligne séparée après le bloc :

\`\`\`markdown
> A quote block

^quote-id
\`\`\`

### Embeds (référence complète)

Préfixer un wikilink par \`!\` pour embed son contenu inline.

\`\`\`markdown
![[Note Name]]                         Embed full note
![[Note Name#Heading]]                 Embed section
![[Note Name#^block-id]]               Embed block

![[image.png]]                         Embed image
![[image.png|300]]                     Embed image (width only, aspect ratio préservé)
![[image.png|640x480]]                 Embed image (width × height)

![Alt text](https://example.com/img.png)         External image
![Alt text|300](https://example.com/img.png)     External image with width

![[audio.mp3]]                         Embed audio (mp3, ogg)
![[document.pdf]]                      Embed PDF
![[document.pdf#page=3]]               Embed PDF page
![[document.pdf#height=400]]           Embed PDF avec hauteur

![[Note#^list-id]]                     Embed une liste avec block ID
\`\`\`

Embed search results :

\`\`\`\`markdown
\`\`\`query
tag:#project status:done
\`\`\`
\`\`\`\`

### Callouts (référence complète)

\`\`\`markdown
> [!note]
> Basic callout.

> [!warning] Custom Title
> Callout with a custom title.

> [!faq]- Collapsed by default
> Foldable callout (- collapsed, + expanded).

> [!question] Outer callout
> > [!note] Inner callout
> > Nested content
\`\`\`

Types supportés (avec aliases) :

| Type | Aliases | Couleur / icône |
|------|---------|-----------------|
| \`note\` | — | Bleu, crayon |
| \`abstract\` | \`summary\`, \`tldr\` | Turquoise, presse-papier |
| \`info\` | — | Bleu, info |
| \`todo\` | — | Bleu, checkbox |
| \`tip\` | \`hint\`, \`important\` | Cyan, flamme |
| \`success\` | \`check\`, \`done\` | Vert, ✓ |
| \`question\` | \`help\`, \`faq\` | Jaune, ? |
| \`warning\` | \`caution\`, \`attention\` | Orange, ⚠ |
| \`failure\` | \`fail\`, \`missing\` | Rouge, ✗ |
| \`danger\` | \`error\` | Rouge, ⚡ |
| \`bug\` | — | Rouge, bug |
| \`example\` | — | Violet, liste |
| \`quote\` | \`cite\` | Gris, " |

### Properties / Frontmatter (référence complète)

\`\`\`yaml
---
title: My Note Title
date: 2024-01-15
tags:
  - project
  - important
aliases:
  - My Note
  - Alternative Name
cssclasses:
  - custom-class
status: in-progress
rating: 4.5
completed: false
due: 2024-02-01T14:30:00
---
\`\`\`

Types de properties :

| Type | Exemple |
|------|---------|
| Text | \`title: My Title\` |
| Number | \`rating: 4.5\` |
| Checkbox | \`completed: true\` |
| Date | \`date: 2024-01-15\` |
| Date & Time | \`due: 2024-01-15T14:30:00\` |
| List | \`tags: [one, two]\` ou liste YAML |
| Links | \`related: "[[Other Note]]"\` |

Properties par défaut :
- \`tags\` — searchable, apparaît dans graph view
- \`aliases\` — noms alternatifs (utilisés pour les link suggestions)
- \`cssclasses\` — classes CSS appliquées à la note

### Tags

\`\`\`markdown
#tag                    Inline tag
#nested/tag             Nested tag with hierarchy
#tag-with-dashes
#tag_with_underscores
\`\`\`

Tags peuvent contenir : lettres (toute langue), chiffres (pas en premier caractère), underscores \`_\`, hyphens \`-\`, slashes \`/\` (nesting). Aussi définissables en frontmatter sous \`tags\`.

### Comments (masqués en reading view)

\`\`\`markdown
This is visible %%but this is hidden%% text.

%%
This entire block is hidden in reading view.
%%
\`\`\`

### Highlight

\`\`\`markdown
==Highlighted text==
\`\`\`

### Math (LaTeX)

\`\`\`markdown
Inline : $e^{i\\pi} + 1 = 0$

Block :
$$
\\frac{a}{b} = c
$$
\`\`\`

### Diagrams (Mermaid)

\`\`\`\`markdown
\`\`\`mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do this]
    B -->|No| D[Do that]
\`\`\`
\`\`\`\`

Pour linker des nodes Mermaid à des notes Obsidian : ajouter \`class NodeName internal-link;\`.

### Footnotes

\`\`\`markdown
Text with a footnote[^1].

[^1]: Footnote content.

Inline footnote.^[This is inline.]
\`\`\`

### Exemple complet (réutilisable comme template)

\`\`\`\`markdown
---
title: Project Alpha
date: 2024-01-15
tags:
  - project
  - active
status: in-progress
---

# Project Alpha

This project aims to [[improve workflow]] using modern techniques.

> [!important] Key Deadline
> The first milestone is due on ==January 30th==.

## Tasks

- [x] Initial planning
- [ ] Development phase
  - [ ] Backend implementation
  - [ ] Frontend design

## Notes

The algorithm uses $O(n \\log n)$ sorting. See [[Algorithm Notes#Sorting]] for details.

![[Architecture Diagram.png|600]]

Reviewed in [[Meeting Notes 2024-01-10#Decisions]].
\`\`\`\`

Source de référence : https://help.obsidian.md/obsidian-flavored-markdown · Crédit kepano/obsidian-skills
`,
};
