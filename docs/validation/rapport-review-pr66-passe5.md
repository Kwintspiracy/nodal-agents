## Constats

- **R1 — important — `apps/runner/src/verification/document.ts:152`, `:172`.** Le préfixe est retiré **à l’intérieur du code aussi**, fabriquant une clôture. Déclenchement : `"~~~\n- ~~~\n# faux\n"`. **Reproduit : `green`, avec `well-formed:markdown` vert.** Pourtant, `- ~~~` appartient au code et ne ferme pas le bloc ; aucun titre n’existe. Régression introduite par `bec62175`. [CommonMark — blocs clôturés](https://spec.commonmark.org/0.31.2/#fenced-code-blocks).

- **R2 — important — `apps/runner/src/verification/document.ts:152`, `:164`, `:179`.** L’approximation fait également disparaître de vrais titres :
  - `"1234567890. ~~~\n# vrai\n"` → **`red` reproduit**. Dix chiffres ne constituent pas un marqueur de liste ordonnée ; la regex invente une ouverture.
  - `"-     ~~~\n\n# vrai\n"` → **`red` reproduit**. Les cinq espaces sont avalés ; du code indenté devient artificiellement un bloc clôturé.
  - `"> ~~~\n> code\n\n# vrai\n"` → **`red` reproduit**. Le bloc appartient à la citation et s’arrête avec elle ; l’état `fence` persiste jusqu’à la fin du document. Même problème avec `"- ~~~\n  code\n\n# vrai\n"`.

  Ces comportements viennent du retrait sans suivi du conteneur ni de son indentation. [CommonMark — listes](https://spec.commonmark.org/0.31.2/#list-items), [blocs clôturés](https://spec.commonmark.org/0.31.2/#fenced-code-blocks).

- **R3 — important, déjà signalé en passe 4 — `apps/runner/src/verification/document.ts:449`, `:488`.** Le constat R5 précédent reste vrai : `<!DOCTYPE svg [<!ENTITY a.b "ok">]><svg>&a.b;</svg>` retourne **`red`, `EntityRef: expecting ;`**, reproduit avec le parseur installé. `bec62175` ne corrige pas ce cas.

- **R4 — mineur — `apps/runner/src/verification/document.ts:445`.** Le commentaire affirme encore que les déclarations dans les commentaires et CDATA sont acceptées ; `:460` les retire désormais. Restent aussi les contradictions déjà signalées : « une lecture de plus » (`:78`), absence de métacaractères XML (`:452`), retour à `fatalError` seul (`:478`), configuration documentaire qui ne change jamais (`:525`), ouverture par clé canonique (`:545`). Dans `document.test.ts:9`, « chaque cas […] lit les LIGNES » contredit les nombreux tests portant uniquement sur `verdict`.

## Les six questions

1. **constat.** Les quatre mécanismes annoncés existent :
   - lecture des octets à `document.ts:592`, hash à `:593`, taille à `:598`, décodage à `:612` ;
   - retrait du préfixe à `:152` ;
   - clôture limitée aux espaces et tabulations à `:178` ;
   - suppression commentaires/CDATA à `:460`, recherche sensible à la casse à `:461`.

   En revanche, **« les quatre constats en périmètre sont corrigés » est faux** : le rapport de passe 4 contient six constats, et son R5 reste reproduisible ; ses commentaires R6 restent également présents.

2. **constat — R1/R2.** Oui, le retrait peut fabriquer un titre apparent et masquer un vrai titre. Les témoins `"- prose\n\n# vrai\n"`, `"texte > ~~~\n# vrai\n"` et `"--- \n# vrai\n"` restent correctement verts. Le préfixe n’est pas directement retiré du texte rendu (`:168`) : les erreurs viennent de l’ouverture ou de la fermeture artificielle des blocs. Une phrase commençant par `1.` n’est donc pas, à elle seule, une preuve de défaut.

3. **tient — pour l’unicité des octets prouvés.** `runProof` conserve un `stat` à `:587`, mais une seule lecture de contenu à `:592`. Taille, hash et validation utilisent ce même buffer. `loadConfig` lit séparément via `fileStamp` (`:83`, `:86`, `:536`). Les empreintes peuvent diverger ; `finalize.ts:491` et `:495` comparent justement l’empreinte courante à celle réellement prouvée. La sonde vidant le fichier après `exists` conserve désormais l’empreinte du contenu initial : elle ne certifie plus le fichier vide. Cela ne constitue pas un verrou filesystem après la dernière lecture.

4. **constat — R1.** C5 reste contournable : du code contenant un faux titre repasse au vert. Les cas de `document.test.ts:315` et suivants ne couvrent ni une pseudo-clôture préfixée **dans** le code, ni les déclenchements R2. Le cas XML ponctué R3 manque également. Ce constat suffit à réfuter la couverture complète des comportements corrigés.

5. **constat — R4.** Oui, dont une contradiction directement créée par ce commit entre `:445` et `:460`.

6. **constat.** Des défauts nouveaux sont reproduits. Sondes exécutées en mémoire sur le source transpillé, notamment via `runProof`, avec frontières filesystem simulées et vrais parseurs installés. Suites Vitest, architecture et intégration DB non exécutées.

des constats