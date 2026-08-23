# Rapport de review - gardes MCP, passe 2

tokens used
31,438
# Passe 2 — `feat/mcp-guardrails`

**Aucun constat neuf.**

Les trois failles du rapport initial sont correctement fermées dans `c29b83a` :

- provenance MCP fail-closed sur parent absent, cycle ou chaîne dépassant 10 sauts ;
- refus au démarrage des agents sans entité avec `mcp_agent_without_entity` ;
- lecture de l’interrupteur et insertion du job dans une même transaction, sous verrou `FOR UPDATE`.

La mise à jour de l’interrupteur acquiert bien le verrou de ligne PostgreSQL correspondant, donc elle est correctement sérialisée avec la création du job.

Revue statique uniquement, conformément à la consigne de lecture seule. Aucun fichier modifié.
