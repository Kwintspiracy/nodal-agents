# Demande de review — plan « De la maquette au produit », lot 2 — passe 2

Suite de `demande-review-plan-maquette-lot2.md` (passe 1). Même périmètre : le
document `docs/plans/de-la-maquette-au-produit.md` et son miroir `.html`, pas de
code.

## Ce que la passe 1 a rendu

- **P0 (fidélité à la discussion) : NON EXÉCUTÉ** — la sandbox a refusé le
  fichier verbatim hors du workspace. **Il est maintenant dans le workspace** :
  `.cache/discussion-06-09.md` (dossier ignoré par git, jamais committé). Le
  lire en premier.
- **P1 : un constat neuf, corrigé** — le miroir HTML disait « validée à
  l'écran » sans « par Playwright ». Rétabli.
- **P2 : un constat neuf, corrigé** — P11 prêtait à `file_write` un ancien
  texte qu'il n'a pas (`tool_input` = chemin + nouveau contenu). P11 dit
  maintenant : `file_edit` rend son diff depuis `old_string` ; `file_write` et
  le harnais dépendent de l'instantané du tour (sha à persister, dépôt git
  requis) ; sinon « sans diff ».
- Remarque retenue : `save_memory` est `riskLevel: 'write'` mais carte `text`.
  P7 dit maintenant que les outils natifs se classent par leur carte, jamais par
  leur niveau de risque, réservé aux outils tiers `generic`.

## Ce qui est attendu de la passe 2

### P0 — fidélité, message par message

L'extrait a 12 messages de Quentin (titres `## QUENTIN · <horodatage>`). Pour
CHACUN : la décision ou nuance qu'il porte ; la ligne du plan qui la porte ;
verdict **tient** (fidèle) / **faux** (absente ou déformée, citer les deux
textes). Les réponses de Claude dans l'extrait ne font pas autorité : seules
les phrases de Quentin comptent, sauf quand Quentin y répond « d'accord ».

Ne pas s'arrêter aux points que la passe 1 a listés comme « présents » — ils ont
été vérifiés sans le verbatim. Chercher ce qui n'a PAS été soupçonné.

### P1 — les deux corrections

Les deux corrections ci-dessus tiennent-elles (fichier, ligne) ? Le `.md` et le
`.html` disent-ils la même chose sur P11 et sur la frontière ?

## Ce qui n'est PAS attendu

Re-vérifier les ancrages code déjà tenus en passe 1. « Ça a l'air bien ». Dis
explicitement si tu ne trouves rien de neuf. Un constat non vérifié est marqué
NON EXÉCUTÉ.
