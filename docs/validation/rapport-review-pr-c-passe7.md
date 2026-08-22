# Rapport de review - PR C, passe 7

tokens used
88,127
## Rapport de review — PR #12, passe 7

### Verdict

**Un constat neuf — PR à bloquer fonctionnellement.**

La correction de la passe 6 est valide dans `launch.ts` : `DATABASE_URL` est obligatoire, l’erreur part sur stderr avec un exit 1, et `NODAL_MCP_AGENT_ID` reste optionnel avec résolution racine par défaut.

### ÉLEVÉ — La commande documentée pollue stdout avant le transport MCP

Fichiers :

- [pr-c-serveur-mcp.md](D:/APPS/NodalAI/docs/plans/pr-c-serveur-mcp.md:14)
- [package.json](D:/APPS/NodalAI/packages/mcp-server/package.json:15)
- [launch.ts](D:/APPS/NodalAI/packages/mcp-server/src/launch.ts:42)

La commande proposée est :

```text
pnpm --filter @nodal-agents/mcp-server serve
```

Or `pnpm run` écrit normalement sur stdout son en-tête de lifecycle — nom du paquet, script et commande exécutée — avant de lancer `tsx`. Ces octets précèdent donc les messages JSON-RPC du `StdioServerTransport`.

Le fait que `launch.ts` réserve `console.error` à stderr ne protège pas le transport : stdout est déjà contrôlé par le processus parent `pnpm`.

Conséquence concrète : un client MCP lancé avec la commande officiellement documentée peut recevoir du texte libre avant le premier message JSON-RPC et considérer le serveur comme invalide, alors que l’exécution directe du fichier resterait saine.

Il faut fournir une commande dont le silence stdout est garanti — par exemple un véritable exécutable compilé, ou invoquer pnpm avec son niveau de logs silencieux — puis tester la commande publique complète en capturant séparément stdout et stderr. Les tests actuels ne traversent pas le nouveau lanceur.

### Conclusion

Aucun autre constat neuf trouvé. Tous les constats des passes 1 à 6 restent fermés.

Lecture seule respectée ; aucun fichier modifié. L’exécution de `pnpm serve` a été refusée par le sandbox, donc la séparation des flux n’a pas été vérifiée dynamiquement dans cet environnement.
