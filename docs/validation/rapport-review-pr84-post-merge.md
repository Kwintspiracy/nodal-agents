Rapport Markdown fourni ci-dessous, sans création de fichier puisque la session est en lecture seule. Référence des lignes : **`4186254c`**. Comparaison effectuée avec `git log`, `git diff` et `git show` sur les **15 commits `62a73357..4186254c`**. Aucun test ni compilateur exécuté.

### [P0] L’absence de rendu devient un parcours ignoré

- Fichier : `apps/web/tests/e2e/agents-redesign.spec.ts:183`
- Ce qui casse : la nouvelle garde peut masquer une régression d’affichage des équipes.
- Dans quel cas : des affectations existent, mais les cartes ou les lignes de workers ne sont plus rendues, ou leurs attributs disparaissent.
- Preuve : `teamSizes` est construit uniquement depuis le DOM testé, puis `test.skip(teamSizes.every((n) => n === 0), ...)` intervient avant les assertions. Un tableau vide satisfait également `every`. Avant `aa712070`, l’absence de poignée faisait échouer le parcours.
- Verdict : **le constat tient**. Vérifier le prérequis depuis une source indépendante du rendu, puis affirmer sa présence à l’écran. Une équipe initiale constitue une fixture légitime pour tester son déplacement ; elle ne pré-seede pas le résultat du déplacement.

### [P0] La sauvegarde LLM perd son assertion d’identité

- Fichier : `apps/web/tests/e2e/brique31-flows.spec.ts:80`
- Ce qui casse : la branche de succès ne prouve plus qu’un fournisseur a été enregistré.
- Dans quel cas : le test de connexion réussit, mais la sauvegarde échoue et un texte contenant « anthropic » reste visible, notamment dans un message d’erreur.
- Preuve : `f15424fa` remplace `getByText(nickname)`, où `nickname` était unique au parcours, par `getByText(/anthropic/i).first()`. Aucune lecture DB ni vérification d’une nouvelle ligne ne suit.
- Verdict : **le constat tient**. Affirmer la ligne créée et sa persistance. L’exécution de cette branche avec la fausse clé fournie est **NON VÉRIFIÉE** ; le scénario nominal utilise toujours cette fausse clé, sans substitution par une clé réelle.

### [P0] Le modèle n’est plus vérifié après le changement de fournisseur

- Fichier : `apps/web/tests/e2e/brique31-flows.spec.ts:153`
- Ce qui casse : le parcours peut réussir alors que changer de fournisseur vide le modèle.
- Dans quel cas : au moins deux options existent et la mise à jour du modèle régresse.
- Preuve : avant `f15424fa`, la valeur du modèle était contrôlée **après** `selectOption`. Après, `modelValue` est lu et affirmé avant le changement ; les seules vérifications suivantes portent sur le fournisseur sélectionné et le toast.
- Verdict : **le constat tient**. Relire le modèle après le changement et contrôler sa valeur attendue, puis la configuration sauvegardée.

### [P1] Le nettoyage efface encore les vrais identifiants du type demandé

- Fichier : `apps/web/tests/e2e/helpers.ts:545`
- Ce qui casse : le filtre rétabli protège les autres types, mais pas les comptes personnels du même type.
- Dans quel cas : exécution en local-trust avec des identifiants Google, Notion ou Airtable du propriétaire.
- Preuve : `resolveActingUser()` remplace le compte sentinelle ; la suppression filtre seulement `ownerUserId` et `type`, sans identifier les données du test. Les cinq appelants exécutent ce nettoyage en `beforeAll`, notamment `help-guides.spec.ts:17`, simplement pour afficher une aide.
- Verdict : **le constat tient**. Utiliser un espace de test isolé ou limiter les suppressions aux identifiants explicitement créés par les tests.

### [P1] Le parcours d’affectation supprime tous les Google Drive du propriétaire

- Fichier : `apps/web/tests/e2e/agent-tool-assignment.spec.ts:58`
- Ce qui casse : le setup supprime des connecteurs réels, leurs affectations et leurs identifiants.
- Dans quel cas : l’espace résolu en local-trust contient déjà un Google Drive personnel.
- Preuve : sélection par `entityId` et `slug === 'google-drive'`, puis suppression de chaque connecteur et de son `credentialId`, sans marqueur E2E. Le filtre par nom E2E des lignes suivantes ne protège pas cette première boucle. La boucle préexistait ; `823d8bba` la rend applicable au propriétaire local.
- Verdict : **le constat tient**. Restreindre cette boucle aux fixtures du parcours. La suppression par ID ne suffit pas si l’ID provient d’une sélection de comptes réels.

### [P1] Une panne de sonde peut sélectionner le mauvais utilisateur

- Fichier : `apps/web/tests/e2e/helpers.ts:428`
- Ce qui casse : une erreur réseau ou HTTP devient silencieusement une détection local-trust.
- Dans quel cas : la pile est en local-auth, la sonde échoue, et l’utilisateur local-trust avec son espace existe encore en DB. Inversement, un HTTP 200 en local-trust sélectionne la sentinelle si elle existe.
- Preuve : `betterAuthAvailable = probe.ok`, puis `catch { betterAuthAvailable = false; }`. Seule l’absence de l’utilisateur ou de son espace déclenche une erreur ; aucune vérification supplémentaire du mode ou de l’identité du navigateur n’intervient.
- Verdict : **le constat tient**. Une réponse ambiguë doit échouer explicitement. La présence effective de ces configurations sur l’installation est **NON VÉRIFIÉE**.

### [P1] Une correspondance partielle peut supprimer la mauvaise instance

- Fichier : `apps/web/tests/e2e/helpers.ts:125`
- Ce qui casse : le helper peut affirmer ou supprimer une autre instance que celle demandée.
- Dans quel cas : plusieurs lignes contiennent le même nom, ou un nom est inclus dans un autre. Les appelants utilisent aussi des noms de fournisseur comme `Google Drive`.
- Preuve : `getByRole('row').filter({ hasText: instanceName })`, suivi de `.first()` dans le nettoyage. Le clic destructif précède l’attente du toast `${instanceName} removed` : un toast différent ne protège donc pas contre la mauvaise suppression.
- Verdict : **le constat tient**. Identifier exactement la cellule du compte et son instance, idéalement par ID ; refuser les correspondances multiples.

### [P2] Le client reste ouvert si le nettoyage échoue

- Fichier : `apps/web/tests/e2e/agent-recipes.spec.ts:155`
- Ce qui casse : la fermeture ajoutée par la PR n’est pas garantie.
- Dans quel cas : la suppression de l’agent rejette dans le `finally`.
- Preuve :
  ```ts
  finally {
    await db.delete(agents).where(eq(agents.slug, slug));
    await close();
  }
  ```
- Verdict : **le constat tient**. Placer la suppression dans un `try` dont le `finally` appelle `close()`. Aucun chemin équivalent trouvé dans les helpers DB : leurs clients sont fermés en `finally`, et `cleanCredentialsByType` résout l’utilisateur avant d’ouvrir son propre client.

### [P2] Le mot de passe comporte un repli silencieux préexistant

- Fichier : `apps/web/tests/e2e/helpers.ts:207`
- Ce qui casse : une configuration sans mot de passe valide est traitée comme une installation historique.
- Dans quel cas : `postgresPassword` manque, est vide ou possède un mauvais type.
- Preuve : `let password = 'nodalai'`, remplacé seulement pour une chaîne non vide. Aucun contrôle de version historique ni signalement du repli.
- Verdict : **le constat tient**, mais ce code **préexiste à la plage** : `resolveDbUrl` n’a pas été modifié par ces 15 commits. Exiger une configuration explicite pour le cas historique.

Un `postmaster.pid` résiduel est également accepté sans contrôle du processus ou de l’identité du cluster. Le helper réutilise son port ; le résultat de connexion dépend du service éventuellement présent sur ce port : **NON VÉRIFIÉ**.

### [P2] La mutualisation des gestes reste incomplète

- Fichier : `apps/web/tests/e2e/credentials-reuse.spec.ts:83`
- Ce qui casse : une modification du bouton d’installation nécessite encore plusieurs corrections.
- Dans quel cas : changement du libellé ou du contrat d’ouverture du dialogue.
- Preuve : les séquences carte → bouton `/^(install|add account)$/i` → dialogue restent recopiées dans `credentials-reuse`, `oauth-flow`, `airtable-oauth` et `notion-oauth`. `apify-apikey.spec.ts:76` recopie aussi la suppression et sa confirmation.
- Verdict : **le constat tient**. Réutiliser les helpers pour ces gestes ; conserver les assertions propres à chaque parcours.

### [P2] Des pauses fixes subsistent dans les fichiers touchés

- Fichier : `apps/web/tests/e2e/agent-tool-assignment.spec.ts:308`
- Ce qui casse : l’affirmation générale de suppression des `waitForTimeout` dans les parcours touchés est inexacte ; cette lecture DB dépend encore d’une pause de 800 ms.
- Dans quel cas : la sauvegarde prend plus longtemps que la pause.
- Preuve : cette pause existait à `62a73357:327`. Les pauses de `agents-redesign.spec.ts:112`, `:116` et `:147` préexistent également et restent présentes.
- Verdict : **le constat tient**, comme limite conservée, pas comme pause introduite. `thread-autoscroll.spec.ts` et `global-setup.ts` sont inchangés dans la plage et hors des 17 fichiers modifiés.

**Autres axes demandés**

- **Pré-seeding des assertions :** aucun appel effectif à `insertMemory` trouvé dans les parcours examinés. Les fixtures connecteur/MCP, skill à éditer ou supprimer, et propriétaire Telegram ne créent pas le résultat final du geste testé. Aucun constat de pré-seeding frauduleux retenu.
- **Types de nettoyage :** « le filtre de type est absent » — **le constat est faux** à `4186254c`. Les cinq appelants passent le type attendu : Google pour Drive/Gmail/aide, Notion pour Notion OAuth, Airtable pour Airtable.
- **Réutilisation du credential :** `credentials-reuse.spec.ts:169` vérifie deux états Connected, mais jamais l’égalité des `credentialId`. Cette insuffisance préexistait ; la réécriture ne démontre pas le partage annoncé.
- **Étiquettes :** aucune perte ni modification de slug entre les bornes. Une occurrence supplémentaire `@cap:assigner-outils/ecran` figure dans le titre de `tools-tab`. `9879b358` l’introduit sans niveau ; `4186254c` ajoute `/ecran`.
- **Deux skips :** aucune condition n’est une constante toujours vraie. Pour `user-menu`, le motif local-trust est cohérent avec l’objet du parcours ; la présence réelle du titre de bannière est **NON VÉRIFIÉE**. Pour `agents-redesign`, voir le constat P0 ; l’absence effective d’équipe sur le runner est **NON VÉRIFIÉE**.
- **Unicité des boutons/dialogues :** les regex sont ancrées et les boutons d’installation sont limités à une carte. Leur unicité dans le DOM réel, ainsi que les libellés des confirmations et toasts, sont **NON VÉRIFIÉS**.
- **`networkidle` :** les deux helpers attendent bien 15 secondes. L’existence d’une connexion persistante empêchant cette attente sur `/connectors` est **NON VÉRIFIÉE** : son code produit est hors périmètre et aucun rejeu n’a été effectué.
- **TypeScript :** le `tsconfig` exclut bien `tests`. La PR corrige l’utilisation du wrapper DB et retire les arguments numériques des hooks. Aucune autre erreur de type certaine établie par cette lecture ; compilation des fichiers et compatibilité complète avec les types importés : **NON VÉRIFIÉES**.
- **`LlmKeyForm.tsx:349` :** le changement est correct à la lecture : seuls des commentaires et les attributs `data-testid`/`data-state` sont ajoutés aux branches existantes. « Changement emporté par mégarde » — **le constat est faux** : `f15424fa` explique l’ancre et le parcours l’utilise. Elle est nécessaire au sélecteur choisi, sans constituer une réparation fonctionnelle du produit.
- **« Aucune fonctionnalité produit n’était cassée » et « les parcours passent » : NON VÉRIFIÉ.** Les messages de commits rapportent des erreurs antérieures ; ils ne constituent pas un rejeu indépendant.