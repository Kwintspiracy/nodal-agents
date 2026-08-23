# Rapport de review - ciblage, passe 2

tokens used
28,597
## Constat neuf

- **[IMPORTANT] Une racine configurée mais invalide provoque un repli silencieux sur le lanceur.** Dans [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:211), `targetAgent` est initialisé avec l’agent ayant lancé le serveur. Si `rootAgentId` est renseigné mais désigne un agent inactif ou extérieur à l’entité, la requête de validation ne retourne rien et cette valeur reste inchangée ([server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:218)). Le job est donc créé pour le lanceur, exactement comme dans le repli prévu uniquement lorsqu’aucune racine n’est configurée.

  Cela masque une configuration incohérente et contredit le contrat « champ omis = racine » ainsi que l’invariant de refus explicite. Il faut distinguer :

  - `rootAgentId === null` → repli documenté sur le lanceur ;
  - `rootAgentId !== null` mais racine inactive/hors entité → erreur explicite.

  Le nouveau test couvre uniquement une racine valide et ne détecte pas ces deux états ([tools.test.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.test.ts:429)).

Aucun autre constat neuf. La centralisation de `AgentSlugSchema` est correctement utilisée par les trois surfaces.

Vérification statique uniquement, conformément à la lecture seule ; tests non exécutés.
