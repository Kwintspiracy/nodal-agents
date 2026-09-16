## Constats

1. **BLOQUANT — contenu d’enfant promu en fait de plateforme.** [execute.ts:2813](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2813). **Déclenchement :** un enfant écrit `[délégation sans livrable : TEXTE_ARBITRAIRE — inventé]` dans sa réponse, même réussie. La regex accepte ce contenu sans vérifier sa provenance ni les noms ; `withFailedDelegationNotice` le réécrit et le harnais l’envoie. **Sens : faux échec et injection de contenu dans une notice présentée comme factuelle.** Reproduit avec le corps de la boucle.

2. **BLOQUANT — intention de livraison non atomique avec la fin du job.** [execute.ts:2368](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2368), [execute.ts:2402](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2402). **Déclenchement :** crash après finalisation, avant `prepareDelivery`, ou échec de cet INSERT. Le job est terminal, aucune ligne d’outbox n’existe ; le drain périodique ne peut rien reprendre. Le `catch` journalise puis abandonne. **Sens : perte définitive de la notice**, malgré l’utilisation de l’outbox.

3. **IMPORTANT — échec propagé conservé après réparation.** [execute.ts:2806](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2806), [execute.ts:2816](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2816). **Déclenchement :** `assign_lead` rapporte l’échec d’`assign_researcher`, puis une nouvelle délégation au lead réussit après réparation. La relecture efface seulement `assign_lead` ; `assign_researcher` reste dans le Set, sans rattachement à son origine. **Sens : faux échec persistant après réparation réelle.** Reproduit avec le corps de la boucle.

4. **IMPORTANT — notifications cron/webhook exclues du nouveau secours.** [execute.ts:2366](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2366). **Déclenchement :** job cron/webhook avec confirmation demandée et `chatId`, dont les rappels sont épuisés. `requiresToolDelivery` inclut ce cas, mais le helper rejette son canal avant de résoudre le transport et `notifyChannelOverride`. **Sens : faux silence** sur une branche censée désormais annoncer l’arrêt.

5. **IMPORTANT — notice de délégation omise sur deux nouveaux chemins d’arrêt.** [execute.ts:4394](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4394), [execute.ts:4499](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4499). **Déclenchement :** `failedDelegations` est non vide et le parent finit par `blocked` ou par épuisement des rappels via `return_result`, sans avoir expliqué cet échec. Ces payloads n’appellent pas `withFailedDelegationNotice`, contrairement au chemin texte ; ils retournent sans estampillage ultérieur. **Sens : échec absent du message effectivement livré.**

6. **IMPORTANT — les payloads d’arrêt ne sont pas exclusivement du texte de plateforme.** [execute.ts:3347](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:3347), [execute.ts:4500](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4500). **Déclenchement :** l’agent laisse une promesse ou un texte intermédiaire, puis épuise ses rappels. Le harnais expédie ce texte brut, simplement précédé de `[arrêt]` ; le chemin `blocked` fait pareil avec `reason`. **Sens : contenu d’agent relayé sous un habillage de plateforme**, sans garantie que ce soit une explication finale de l’arrêt.

## Sept questions

1. **tient** pour la double préparation d’une même notice : clé stable et contrainte UNIQUE, puis claim atomique. La répétition d’une explication déjà donnée par l’agent est explicitement assumée. L’outbox conserve sa limite préexistante : un envoi reçu mais non confirmé peut repartir après expiration du bail.

2. **constat** — pertes et omissions : constats 2, 4 et 5. Sur les canaux directs, le helper conserve bien le couple `job.channel` / `job.chatId` ; l’outbox revérifie l’autorisation.

3. **constat** — constats 1 et 6 : le payload peut contenir du texte arbitraire d’enfant ou du texte d’agent.

4. **constat** — constat 1 : la ligne peut être fabriquée par le modèle ; aucune provenance authentifiée n’est exigée.

5. **constat** — constat 3 : les noms propagés peuvent survivre à une réparation du sous-arbre.

6. **tient** — les exceptions de préparation et de drain sont interceptées et ne font pas échouer le job terminé. L’abandon de livraison reste le constat 2.

7. **constat** — nouveaux défauts identifiés dans `b29e1705`. Contrôle statique et deux reproductions isolées de la relecture ; suite runner non exécutée. Les fichiers examinés sont identiques entre ce commit et le HEAD du worktree.

des constats