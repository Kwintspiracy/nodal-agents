# Rapport de review - PR A, passe 4

## Passe 4 — un constat neuf

### Majeur — l’épinglage recrée une capture mémoire sans plafond

- Fichier : `packages/tools/src/builtin/code-task/live-events.ts`
- Lignes : 216, 221–223, 230

Chaque ligne contenant `"thread.started"` est ajoutée à `pinned`, sans limite ni remplacement de la précédente. La fenêtre `kept` reste plafonnée à 4 000 lignes, mais `pinned` peut croître indéfiniment.

Ce qui casse concrètement : un CLI défectueux ou une sortie hostile répétant des événements `thread.started` conserve toutes ces lignes jusqu’à la fin de la session. Chaque ligne pouvant approcher le plafond amont de 200 000 caractères, cette branche contourne de nouveau la borne mémoire que `MAX_ESSENTIAL_LINES` devait garantir et peut épuiser le runner.

Le comportement attendu serait d’épingler uniquement le premier `thread.started`, conformément au contrat décrit par le correctif.

Aucun autre constat neuf trouvé. Les deux corrections annoncées de la passe 3 sont présentes et cohérentes à la lecture. Tests non exécutés afin de respecter la contrainte de lecture seule.
