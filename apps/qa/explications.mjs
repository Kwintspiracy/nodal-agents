// apps/qa/explications.mjs — ce que chaque page du portail MONTRE, à quoi elle
// sert, d'où viennent ses chiffres, et quand il faut agir.
//
// Écrit le 12/09/2026 parce que Quentin l'a dit sans détour : « je n'ai pas la
// moindre idée de ce que ça veut dire et de ce que ça montre ». Un tableau de
// bord qu'on ne sait pas lire ne vaut rien, quelle que soit la justesse de ses
// chiffres. Chaque page porte donc, en tête, deux phrases qui disent pourquoi
// elle existe, et un bouton « Comprendre cette page » qui ouvre le texte complet.
//
// Les textes sont en français, pour Quentin, et ils parlent PRODUIT d'abord :
// ce qu'un utilisateur de Nodal peut ou ne peut pas faire, et ce que ça coûte de
// ne pas regarder. Le jargon (couverture, baseline, instabilité) est expliqué
// à l'endroit où il apparaît, jamais supposé.
//
// Une entrée par page (`id` = l'ancre de la page). `enBref` va sous le titre ;
// `parties` fait la modale. `blocs` porte les phrases posées au-dessus des
// tableaux et des cadres à l'intérieur de la page, clé par clé.

export const EXPLICATIONS = {
  chantiers: {
    titre: 'Chantiers',
    enBref:
      "Le tableau de bord du travail : ce qui attend, ce qui est en cours, ce qui attend une relecture, ce qui est fait. Rien n'est rangé à la main — chaque carte est une issue ou une PR GitHub, et sa colonne est déduite de faits.",
    parties: [
      {
        titre: 'À quoi ça sert',
        texte: `<p>À répondre en un coup d'œil à « où en est-on ? » sans ouvrir GitHub ni lire un rapport. C'est la page d'accueil parce que c'est la question qu'on se pose le plus souvent.</p>`,
      },
      {
        titre: 'Comment le lire',
        texte: `<p>Six colonnes, de gauche à droite dans l'ordre du travail :</p>
<ul>
<li><b>À faire</b> — ce qui attend un geste ou un arbitrage de toi (une issue étiquetée <code>décision</code>).</li>
<li><b>En cours</b> — une issue ouverte que personne n'a encore portée dans une PR.</li>
<li><b>En review</b> — une PR ouverte, ou une issue qu'une PR ouverte ferme (« Closes #n » dans son corps). Le travail est écrit, il attend sa relecture.</li>
<li><b>À tester</b> — une issue étiquetée <code>test</code> : quelque chose à éprouver, ou un doute à trancher.</li>
<li><b>Fait</b> — issue fermée, PR mergée. Borné aux plus récents.</li>
<li><b>Abandonné</b> — une PR fermée sans être mergée.</li>
</ul>
<p>La barre de gauche suit le même ordre que le regard : Chantiers, Capacités, Écarts, Parcours, Mémoire des tests. Ces cinq pages sont celles qu'on pilote, et elles se lisent dans cet ordre.</p>
<p>Sous la rubrique « Comment ça tourne » se rangent les quatre pages de plomberie : la vue d'ensemble des tests, le banc d'essai, les déclencheurs et l'historique. On les ouvre quand on doute d'un chiffre, pas tous les jours.</p>
<p>Sur une carte de PR, la pastille CI dit si ses contrôles sont verts, rouges ou en cours. « CI verte » ne veut pas dire « relue » : une PR se merge après relecture ET contrôles verts.</p>`,
      },
      {
        titre: "D'où ça vient",
        texte: `<p>De GitHub, par <code>gh issue list</code> et <code>gh pr list</code>, au moment de la collecte. Les étiquettes du dépôt sont les seules qui comptent : <code>décision</code>, <code>test</code>, <code>sécurité</code>, <code>dette</code>, <code>coût</code>, <code>produit</code>.</p>
<p>Si GitHub ne répond pas, le tableau dit « absent » plutôt que d'afficher une liste vide ou périmée — une absence n'est jamais peinte en zéro.</p>`,
      },
      {
        titre: 'Quand agir',
        texte: `<p><b>À faire</b> est ta colonne : chaque carte y attend quelque chose de toi. <b>En review</b> est celle de la relecture (Codex) puis du merge. <b>En cours</b> qui grossit sans PR en face, c'est du travail qui n'avance pas. <b>À tester</b> qui stagne, ce sont des doutes qu'on a cessé de trancher.</p>`,
      },
      {
        titre: 'Ce que ça ne dit pas',
        texte: `<p>Ni la priorité entre deux cartes d'une même colonne, ni le temps passé. Une carte « En cours » ne dit pas si quelqu'un y travaille réellement — seulement qu'elle n'est ni tranchée, ni portée par une PR, ni fermée.</p>`,
      },
    ],
    blocs: {},
  },

  capacites: {
    titre: 'Ce que le produit sait faire',
    enBref:
      "La seule page qui parle du PRODUIT et non du code : une ligne par chose qu'un utilisateur croit pouvoir faire (créer un agent, connecter Notion, approuver une action…), et ce qui le prouve. Une capacité sans test qui la prouve n'est qu'une promesse.",
    parties: [
      {
        titre: 'À quoi ça sert',
        texte: `<p>« <code>apps/web</code> est couvert à 78 % » ne répond à aucune question qu'on se pose vraiment. « Un utilisateur peut-il connecter Notion ce matin, et qu'est-ce qui le montre ? » — si. Cette page relie chaque capacité du produit aux tests qui la prouvent, et dit dans quel état est cette preuve.</p>
<p>C'est ce qu'un responsable produit appelle une <i>matrice de traçabilité</i> : le lien entre ce qu'on promet et ce qu'on vérifie. La plupart des équipes ne l'ont pas, et découvrent une promesse rompue quand un utilisateur s'en plaint.</p>`,
      },
      {
        titre: 'Comment le lire',
        texte: `<p>Quatre états, du pire au meilleur :</p>
<ul>
<li><b>Cassée</b> — un test qui la prouve ÉCHOUE. Ce n'est pas une ligne non couverte : c'est quelque chose qu'un utilisateur croit pouvoir faire et qui ne marche pas. C'est la ligne la plus grave du portail.</li>
<li><b>La preuve dort</b> — un test la revendique mais n'a pas tourné (ignoré, ou jamais joué par aucune CI). La preuve existe et personne ne la regarde.</li>
<li><b>Jamais prouvée</b> — aucun test ne la revendique. C'est la liste de ce qu'on croit livré sans en avoir la preuve. Elle est censée rétrécir.</li>
<li><b>Prouvée</b> — au moins un test la revendique et passe.</li>
</ul>
<p>La colonne « Ce qui la prouve » nomme les tests. Cliquer une capacité devrait un jour ouvrir ses tests ; aujourd'hui elle les liste.</p>`,
      },
      {
        titre: "D'où ça vient",
        texte: `<p>Le registre des capacités est le fichier <code>apps/qa/capacites.mjs</code> — 24 lignes, chacune avec la question que l'utilisateur se pose. Il est DÉRIVÉ des parcours et des écrans réels, jamais imaginé.</p>
<p>Un test dit quelle capacité il prouve en écrivant <code>@cap:&lt;slug&gt;</code> dans son titre. Posée sur un <code>describe</code>, l'étiquette vaut pour tous ses cas. Le portail lit les TITRES des tests versionnés (jamais un commentaire, jamais une chaîne), puis croise avec les résultats de la dernière mesure pour dire si la preuve a tourné, et comment.</p>`,
      },
      {
        titre: 'Quand agir',
        texte: `<p>Une capacité <b>cassée</b> passe avant tout le reste : c'est un utilisateur qui ne peut pas faire ce qu'on lui a promis. Une capacité <b>jamais prouvée</b> est un test à écrire — ou une promesse à retirer du registre si elle n'existe plus.</p>
<p>La porte <code>pnpm capacites:check</code> tourne sur chaque PR et refuse deux choses : une étiquette qui ne désigne aucune capacité (une faute de frappe, un slug renommé), et une capacité exigée que plus aucun test ne revendique (le test supprimé qui emporte la preuve avec lui). Elle ne juge aucun résultat — ça, c'est la mesure nocturne.</p>`,
      },
      {
        titre: 'Ce que ça ne dit pas',
        texte: `<p>Qu'un test qui passe prouve BIEN la capacité. Un test peut porter l'étiquette et ne vérifier qu'un détail. La qualité de la preuve reste une question de relecture, pas de portail.</p>`,
      },
    ],
    blocs: {
      compteurs:
        "Les quatre compteurs se lisent de droite à gauche : « Cassées » d'abord — c'est ce qui fait mal à un utilisateur aujourd'hui —, puis ce qui dort, puis ce qu'on n'a jamais prouvé.",
      registre:
        "Une ligne par capacité, groupée par domaine du produit. « Ce qui la prouve » nomme les tests étiquetés ; l'état vient de leur dernier résultat mesuré.",
    },
  },

  vue: {
    titre: "Tests — vue d'ensemble",
    enBref:
      "Combien de tests le dépôt porte, quelle part du code ils exercent réellement, et combien de scénarios utilisateur la CI joue vraiment. C'est la page « santé du code » — utile à l'ingénieur, moins parlante pour le produit (pour ça, voir Capacités).",
    parties: [
      {
        titre: 'À quoi ça sert',
        texte: `<p>À savoir si le filet de sécurité existe, et où il a des trous. Un dépôt peut avoir des milliers de tests et laisser 40 % de son code sans aucun test qui le traverse. Cette page le mesure au lieu de le supposer.</p>`,
      },
      {
        titre: 'Comment le lire',
        texte: `<p><b>Couverture des lignes</b> : sur 100 lignes de code, combien au moins un test a exécutées. 81 % veut dire que 19 lignes sur 100 ne sont traversées par aucun test — si l'une d'elles casse, rien ne le dira avant un utilisateur. Ce n'est PAS « 81 % du code est correct » : une ligne exécutée par un test peut être fausse si le test ne vérifie pas le bon résultat.</p>
<p>Sous la jauge, une phrase dit où va ce chiffre : « en hausse de 2 points sur 7 jours », « en baisse », ou « stable ». Sept jours, parce que la question sous ce chiffre est « est-ce qu'on vient d'ajouter du code sans test », pas « où en était-on ce mois-ci ». Il faut deux collectes dans la semaine pour qu'une tendance existe ; sinon la phrase le dit et n'invente rien. L'historique complet, sur 30 jours et en courbes, est dans la page Historique.</p>
<p><b>Branches</b> : à chaque « si », il y a deux chemins ; ce pourcentage dit combien des deux ont été empruntés par un test. Toujours plus bas que les lignes, et plus honnête.</p>
<p><b>Cas de test</b> : le nombre de <code>it(…)</code> dans le dépôt. Un chiffre de vanité s'il est seul — il ne dit rien de ce qu'ils vérifient.</p>
<p><b>Parcours joués par la CI</b> : les scénarios bout en bout (un vrai navigateur, une vraie page) que l'intégration continue exécute réellement. C'est le chiffre qui a fait construire ce portail : 28 sur 30 n'étaient jamais joués.</p>
<p>Le tableau par paquet est trié par lignes NON couvertes : ce qui est en haut est ce qui coûte le plus à ignorer. Un paquet hachuré n'a pas zéro, il n'a rien — il n'a jamais été mesuré.</p>`,
      },
      {
        titre: "D'où ça vient",
        texte: `<p>La mesure nocturne lance les tests de chaque paquet avec l'instrumentation de couverture (<code>vitest --coverage</code>, moteur V8), paquet par paquet — jamais tous ensemble, chacun porte son environnement. Chaque paquet écrit un résumé ; le collecteur les additionne. La couverture n'a JAMAIS pu tourner avant le 10/09/2026 : elle était déclarée et son outil n'était installé nulle part.</p>`,
      },
      {
        titre: 'Quand agir',
        texte: `<p>Quand un paquet que TOUT LE MONDE traverse est bas : <code>nodal-agents</code> (le CLI, 50 %) est celui qui installe et démarre le produit — chaque utilisateur passe par ce code. Un paquet à 60 % qui ne fait que du rendu de cartes est moins urgent.</p>
<p>Une couverture qui BAISSE entre deux mesures (voir Historique) dit qu'on a ajouté du code sans test. Ce n'est pas une alerte, c'est une tendance à regarder.</p>`,
      },
      {
        titre: 'Ce que ça ne dit pas',
        texte: `<p>Si les tests vérifient quelque chose d'utile. Un test qui appelle une fonction et ne regarde pas le résultat couvre des lignes et ne prouve rien. C'est pour ça que la règle du dépôt exige d'asserter sur le résultat réel — une règle de relecture, pas de portail.</p>`,
      },
    ],
    blocs: {
      cartes:
        'Quatre chiffres : la part du code traversée par un test, le nombre de tests, la part des scénarios utilisateur que la CI joue, et le nombre de sections du banc. Le premier ne vaut que pour les paquets mesurés.',
      paquets:
        'Un paquet = un dossier du dépôt avec son propre code (le runner, le web, les outils…). Trié par ce qui coûte le plus à ignorer : les lignes que personne ne teste.',
    },
  },

  ecarts: {
    titre: 'Écarts',
    enBref:
      "Ce que la mesure du jour reproche au dépôt, classé par gravité. Cette liste est CALCULÉE à partir des autres pages, jamais rédigée : elle change quand le dépôt change. C'est la page à lire quand on n'a qu'une minute.",
    parties: [
      {
        titre: 'À quoi ça sert',
        texte: `<p>Un portail qui affiche vingt tableaux ne dit pas par quoi commencer. Cette page le dit : elle prend tout ce que les autres pages mesurent, garde ce qui est anormal, et le range par ce que ça coûte de l'ignorer.</p>`,
      },
      {
        titre: 'Comment le lire',
        texte: `<p>Trois gravités :</p>
<ul>
<li><b>Haute</b> — quelque chose est cassé ou passé au rouge : une capacité exigée cassée, un test tombé au rouge dans les deux derniers jours, une section du banc qui a régressé ou n'a pas pu tourner, des parcours que la CI ne joue jamais. C'est ce qui réveille quelqu'un : la mesure nocturne ouvre UNE issue (« Portail : ce qui est rouge ») avec exactement ces lignes, la tient à jour, et la ferme quand il n'y a plus rien.</li>
<li><b>Moyenne</b> — une preuve qui dort, un test instable. Rien n'est cassé, mais on ne sait pas.</li>
<li><b>Basse</b> — un plan de travail : les capacités jamais prouvées, un historique trop court. Ça ne bouge que lentement.</li>
</ul>
<p>Chaque écart nomme ce qu'il concerne (les tests, les capacités, les paquets) : c'est par là qu'on va sur la page de détail.</p>`,
      },
      {
        titre: "D'où ça vient",
        texte: `<p>De la fonction <code>ecartsDe</code> dans <code>apps/qa/lib.mjs</code>, qui relit la collecte : le registre des capacités, la mémoire des tests, le rapport du banc, les parcours et les paquets. Elle est testée — chaque règle a un test qui dit quel cas réel l'a motivée.</p>`,
      },
      {
        titre: 'Quand agir',
        texte: `<p>Une gravité <b>haute</b> se traite dans la journée, ou se requalifie explicitement (une issue qui dit pourquoi on attend). Le reste se traite dans l'ordre affiché. Une liste qui ne bouge pas d'une semaine dit qu'on a cessé de la lire.</p>`,
      },
      {
        titre: 'Ce que ça ne dit pas',
        texte: `<p>Pourquoi quelque chose est cassé. L'écart nomme le test ; la raison est dans son rapport d'exécution, sur GitHub Actions, ou en le rejouant en local.</p>`,
      },
    ],
    blocs: {},
  },

  parcours: {
    titre: 'Parcours',
    enBref:
      "Les scénarios bout en bout : un vrai navigateur qui fait ce qu'un utilisateur ferait — ouvrir la page, créer un agent, connecter un service. C'est le filet le plus proche de l'usage réel, et le plus fragile.",
    parties: [
      {
        titre: 'À quoi ça sert',
        texte: `<p>Un test unitaire vérifie une fonction ; un parcours vérifie que TOUT tient ensemble, comme le verrait un utilisateur. Une régression qui casse un écran ne se voit dans aucun test unitaire — elle se voit ici, ou chez l'utilisateur.</p>`,
      },
      {
        titre: 'Comment le lire',
        texte: `<p>Les parcours sont groupés par <b>cadence</b> : à quelle fréquence la CI les joue.</p>
<ul>
<li><b>Chaque PR</b> — joué avant chaque merge : il BLOQUE une régression. Deux parcours seulement (la fumée).</li>
<li><b>Chaque nuit</b> — joué par la mesure nocturne : il CONSTATE une régression après coup, sans la bloquer.</li>
<li><b>À la main</b> — versionné, jamais joué par aucune CI. Il n'existe que sur le papier.</li>
</ul>
<p>Chaque ligne porte son dernier résultat, cas par cas : <b>vert</b>, <b>rouge</b>, <b>ignoré</b> (le test s'est désactivé lui-même — souvent parce qu'un service externe manque), <b>instable</b> (passé au second essai — ce n'est pas un vert). Un parcours « rouge » n'est pas forcément un défaut du produit : sur un runner neuf, sans Google ni Notion configurés, un parcours qui les attend échoue pour une raison d'environnement.</p>`,
      },
      {
        titre: "D'où ça vient",
        texte: `<p>Des fichiers <code>apps/web/tests/e2e/*.spec.ts</code> (Playwright). La cadence est LUE dans les fichiers de workflow de la CI, pas déclarée : si personne ne lance un parcours, le portail le dit. Le dernier résultat vient du rapport JSON de Playwright, produit par la mesure nocturne qui joue 29 parcours sur 30 (<code>agent-flows</code> est exclu : il attend un LM Studio sur la machine de Quentin).</p>`,
      },
      {
        titre: 'Quand agir',
        texte: `<p>Un parcours rouge depuis peu (voir « Rouge depuis » dans la Mémoire des tests) est une régression à comprendre vite. Un parcours rouge depuis toujours sur le runner et vert en local est un écart d'environnement à trancher : soit le test doit se désactiver proprement quand le service manque, soit le runner doit avoir le service.</p>
<p>La question de fond, ouverte : lesquels de ces parcours doivent passer de « chaque nuit » à « chaque PR », pour BLOQUER une régression au lieu de la constater ? Chaque promotion coûte des minutes de CI par PR.</p>`,
      },
      {
        titre: 'Ce que ça ne dit pas',
        texte: `<p>La cause d'un rouge. Pour elle : le rapport Playwright du run (traces, captures), ou rejouer le parcours en local avec <code>pnpm --filter @nodal-agents/web exec playwright test &lt;fichier&gt;</code> sur une stack qui tourne.</p>`,
      },
    ],
    blocs: {
      cadence:
        'Trois groupes par cadence : joué à chaque PR (bloque), chaque nuit (constate), à la main (jamais). Le dernier résultat est cas par cas — un parcours peut être en partie vert, en partie ignoré.',
    },
  },

  banc: {
    titre: "Banc d'essai",
    enBref:
      "Le banc ne demande pas « est-ce cassé ? » mais « qu'est-ce qui a CHANGÉ, et de combien » : la taille du prompt, le nombre de règles d'architecture, le coût d'un tour… Chaque mesure a une valeur de référence acceptée ; s'en écarter est une régression.",
    parties: [
      {
        titre: 'À quoi ça sert',
        texte: `<p>Certaines choses ne sont ni vraies ni fausses, elles ont une VALEUR : le nombre de jetons d'un prompt, le nombre de fichiers qui violent une règle, la durée d'un démarrage. Un test ne sait pas les garder — il faudrait décider d'un seuil. Le banc garde la dernière valeur ACCEPTÉE et signale tout écart : c'est un détecteur de dérive.</p>
<p>Exemple : le prompt système d'un tour de chat pesait 9 000 jetons. Sans banc, il aurait pu monter à 12 000 sans qu'aucun test rougisse.</p>`,
      },
      {
        titre: 'Comment le lire',
        texte: `<p>Une <b>section</b> = un sujet mesuré (architecture, catalogue, portes de sécurité, frontière de confiance…). Chaque section liste ses <b>métriques</b> avec la valeur de référence (la <i>baseline</i>), le commit où elle a été acceptée, et le sens souhaitable (plus bas = mieux, ou plus haut = mieux).</p>
<p>Le bandeau du haut dit le verdict du dernier passage : aucune régression, ou la liste des sections qui ont <b>régressé</b> (une valeur a bougé dans le mauvais sens), ou qui n'ont <b>pas pu tourner</b> (une panne, pas un ralentissement — les deux ne se traitent pas pareil).</p>`,
      },
      {
        titre: "D'où ça vient",
        texte: `<p><code>pnpm bench</code> (le paquet <code>packages/bench</code>) mesure chaque section et compare aux fichiers <code>bench/baselines/*.json</code>. La CI le lance sur chaque PR en porte bloquante ; la mesure nocturne le lance aussi et range son rapport pour cette page.</p>`,
      },
      {
        titre: 'Quand agir',
        texte: `<p>Une <b>régression</b> demande une décision : soit c'est un défaut (on corrige), soit c'est un changement assumé (on accepte la nouvelle valeur avec <code>pnpm bench --update</code>, et le commit explique pourquoi). Jamais l'un sans l'autre. Une section <b>en panne</b> se répare avant tout : elle ne garde plus rien.</p>`,
      },
      {
        titre: 'Ce que ça ne dit pas',
        texte: `<p>Si une valeur est BONNE. Le banc ne connaît que « pareil » et « différent ». Que 4 770 jetons soit un bon prix pour un tour de chat, c'est un jugement — le banc garde seulement qu'on ne remonte pas à 9 000 sans le dire.</p>`,
      },
    ],
    blocs: {
      sections:
        "Une carte par section mesurée. La baseline est la dernière valeur acceptée, avec le commit qui l'a acceptée : c'est contre elle que le prochain passage sera comparé.",
    },
  },

  ci: {
    titre: 'Ce qui déclenche quoi',
    enBref:
      "La réponse à « qu'est-ce qui lance les tests, et quand ». Lue dans les fichiers de workflow de GitHub Actions, pas dans une intention : si un parcours n'est nommé nulle part, personne ne le joue.",
    parties: [
      {
        titre: 'À quoi ça sert',
        texte: `<p>Des tests qui existent mais que rien ne lance ne protègent de rien. Cette page dit, workflow par workflow, ce qui se déclenche (à chaque PR, à chaque push sur main, chaque nuit, ou à la main), ce que ça exécute, et si le banc en fait partie.</p>`,
      },
      {
        titre: 'Comment le lire',
        texte: `<p>Un <b>workflow</b> = un fichier dans <code>.github/workflows/</code>, une liste d'étapes que GitHub exécute sur une machine neuve. Nodal en a quatre :</p>
<ul>
<li><b>CI</b> — à chaque PR et chaque push sur main : tests unitaires, architecture, banc, deux parcours de fumée, le paquet publié installé à blanc. C'est la porte : rouge = pas de merge.</li>
<li><b>Qualité — mesure complète</b> — chaque nuit à 03:17 UTC (et à la main) : couverture des 34 paquets, banc, les 29 parcours, puis elle écrit ses données sur main et ouvre ou ferme l'issue d'alerte. C'est elle qui nourrit ce portail.</li>
<li><b>Qualité — publier le portail</b> — après chaque mesure : rend ce site et le publie (Cloudflare Pages, dès que les secrets sont posés).</li>
<li><b>Deploy Docs</b> — la documentation publique.</li>
</ul>
<p>Les <b>déclencheurs</b> sont les événements qui lancent le workflow ; les <b>jobs</b> ses parties parallèles ; « Parcours joués » les scénarios qu'il exécute nommément.</p>`,
      },
      {
        titre: "D'où ça vient",
        texte: `<p>Du texte des fichiers de workflow, lu par le collecteur. Une première version cherchait un caractère invisible et affichait « à la main » pour tout — d'où les tests qui gardent cette lecture aujourd'hui.</p>`,
      },
      {
        titre: 'Quand agir',
        texte: `<p>Quand un workflow annonce une cadence que GitHub ne tient pas : la mesure nocturne n'a pas tourné d'elle-même les deux premières nuits (issue #69). Quand un parcours qu'on croit protecteur est « à la main ». Quand le banc n'est lancé par aucun workflow.</p>`,
      },
      {
        titre: 'Ce que ça ne dit pas',
        texte: `<p>Si les workflows ont RÉELLEMENT tourné, ni leur résultat : ça, c'est l'onglet Actions de GitHub, et l'Historique de ce portail pour la mesure nocturne.</p>`,
      },
    ],
    blocs: {},
  },

  memoire: {
    titre: 'Mémoire des tests',
    enBref:
      "Un enregistrement par test, gardé d'une mesure à l'autre : combien de fois il a tourné, combien de fois il est tombé, depuis quand il est rouge. C'est la seule page qui voit le TEMPS — et donc l'instabilité, invisible dans une exécution isolée.",
    parties: [
      {
        titre: 'À quoi ça sert',
        texte: `<p>Un test qui tombe une fois sur trois est plus nuisible qu'un test cassé : il passe pour vert chaque fois qu'il passe, et fait douter de tous les rouges. Aucune exécution seule ne peut le voir. Il faut se souvenir des exécutions précédentes — c'est cette page.</p>
<p>Elle sait aussi dater un problème : un test passé au rouge hier est une régression (quelque chose a bougé, et on sait quand) ; un test rouge depuis trois mois est une dette qu'on a appris à ne plus voir. Les deux ne se traitent pas pareil.</p>`,
      },
      {
        titre: 'Comment le lire',
        texte: `<p>Quatre compteurs : <b>instables</b> (verts ET rouges dans leur fenêtre récente), <b>cassés</b> (rouges à leurs derniers passages), <b>suivis</b> (tous ceux qu'on a vus au moins une fois), et <b>réparé en (médiane)</b>.</p>
<p><b>Réparé en (médiane) N jours</b> répond à « quand un test casse, combien de temps reste-t-il cassé ». Un dépôt avec vingt rouges réparés en un jour et un dépôt avec vingt rouges réparés en quarante ne sont pas du tout dans le même état, et le nombre de rouges ne fait pas la différence. Ne comptent que les réparations vues de bout en bout : le test était vert, on l'a vu tomber, on l'a vu revenir. Un test déjà rouge avant la première mesure n'a pas de point de départ, donc pas de durée.</p>
<p>La <b>médiane</b> et pas la moyenne : c'est la valeur qui coupe les réparations en deux moitiés. Une seule réparation oubliée six mois tire une moyenne vers le haut et fait croire que c'est la normale ; la médiane ne bouge pas d'un accident. Tant qu'aucune réparation n'a été observée, la case affiche « — » : aucune absence n'est peinte en zéro.</p>
<p>Dans les tableaux, le <b>ruban</b> se lit de gauche à droite, du plus ancien au plus récent : une lettre par passage, vert, rouge, ignoré, instable. <b>Taux</b> = échecs sur passages. <b>Rouge depuis</b> = la date où on l'a VU basculer de vert à rouge — jamais la date où on a commencé à regarder, sinon la première collecte aurait présenté vingt-deux rouges anciens comme des régressions du jour.</p>
<p>Le premier tableau, « Les plus nuisibles », est trié par taux d'échec.</p>`,
      },
      {
        titre: "D'où ça vient",
        texte: `<p>Du fichier <code>apps/qa/data/tests.ndjson</code> — une ligne par test, écrit sur main par la mesure nocturne. Chaque mesure y fusionne ses résultats : un test revu avance ses compteurs, un test absent de la mesure ne bouge pas (il n'a pas tourné — compter un tour, ou pire un échec, ferait mentir tous les taux). Un test « instable » ici n'est pas le même mot qu'un parcours « instable » dans la page Parcours : là-bas c'est « passé au second essai dans la même exécution », ici c'est « vert un jour, rouge le lendemain ».</p>`,
      },
      {
        titre: 'Quand agir',
        texte: `<p>Un <b>rouge frais</b> (dans les deux derniers jours) se comprend le jour même : c'est une régression datée. Un test <b>instable</b> se répare ou se retire — jamais ignoré, il empoisonne la confiance dans les autres.</p>
<p>Au-delà de <b>14 jours</b>, la colonne « Âge » passe en rouge et la page Écarts nomme ces tests. Le seuil n'est pas une science : deux semaines, c'est le moment où plus personne ne se souvient de ce qui a cassé, et où un rouge cesse d'être une régression pour devenir une décision qu'on n'a pas prise. Ces lignes-là ne réveillent personne (elles ne bougent plus) mais elles sont nommées, sinon elles finissent invisibles à force d'être là. Deux issues seulement : réparer, ou supprimer le test avec la capacité qu'il prouvait.</p>
<p>Cette page ne vaut rien les premiers jours : il lui faut plusieurs passages avant de savoir dire quoi que ce soit. Elle a commencé le 10/09/2026.</p>`,
      },
      {
        titre: 'Ce que ça ne dit pas',
        texte: `<p>Pourquoi un test est instable. Les causes habituelles : un délai trop court, un ordre d'exécution qui compte, un service externe qui répond parfois. Le portail nomme le test ; la cause se trouve en le rejouant.</p>`,
      },
    ],
    blocs: {
      nuisibles:
        "Les tests qui tombent le plus souvent par rapport à leurs passages. Un taux de 30 % sur dix passages est pire qu'un test toujours rouge : on ne sait jamais s'il faut le croire.",
      casses:
        "Rouges à leurs derniers passages. « Rouge depuis » ne date que les bascules vues : un test rouge depuis avant la première mesure n'a pas de date, et c'est honnête. « Âge » compte les jours à la date de la collecte, pas à celle où tu ouvres la page ; au-delà de 14 jours il vire au rouge.",
    },
  },

  historique: {
    titre: 'Historique',
    enBref:
      "Une ligne par collecte : quand, déclenchée par quoi, sur quel commit, avec quels grands chiffres. C'est ce qui rendra lisibles les TENDANCES — une couverture qui glisse, un nombre de tests qui stagne — et la régularité réelle de la mesure.",
    parties: [
      {
        titre: 'À quoi ça sert',
        texte: `<p>Une photo ne dit pas si ça va mieux ou moins bien. Deux photos, si. Cette page garde chaque collecte pour que les autres pages puissent un jour dire « la couverture a perdu deux points cette semaine » au lieu de « la couverture est à 81 % ».</p>`,
      },
      {
        titre: 'Comment le lire',
        texte: `<p>Une ligne par collecte, la plus récente en haut. <b>Déclencheur</b> dit d'où elle vient : <code>schedule</code> (la nuit, toute seule), <code>workflow_dispatch</code> (lancée à la main sur GitHub), <code>local</code> (lancée sur un poste — ces lignes-là ne devraient pas être poussées sur main). <b>Commit</b> est ce qui a été mesuré. Les chiffres sont ceux de la Vue d'ensemble, figés à ce moment.</p>
<p>Deux collectes par jour ou deux par semaine, ça se lit ici : c'est la régularité réelle, pas celle du cron.</p>
<p>Les <b>trois courbes</b> en haut tracent les mêmes chiffres sur 30 jours : la couverture des lignes, les capacités prouvées (sur 24), les tests cassés. Le chiffre à côté du titre est le <b>delta</b> : la différence entre la première et la dernière collecte de la fenêtre. « +2,1 % » veut dire que la couverture a gagné 2,1 points sur la période, pas qu'elle vaut 2,1 %.</p>
<p>L'axe vertical est à l'échelle des données, pas à partir de zéro : une variation de deux points de couverture est ce qu'on vient regarder, et partir de zéro la rendrait invisible. Avec une seule collecte dans la fenêtre, le point est dessiné et la courbe dit « pas encore de tendance » — deux photos font une tendance, une seule n'en fait pas.</p>`,
      },
      {
        titre: "D'où ça vient",
        texte: `<p>Du fichier <code>apps/qa/data/history.ndjson</code>, une ligne ajoutée à la fin de chaque collecte par <code>collect.mjs</code>.</p>
<p>Les courbes en écartent deux choses. Les collectes <code>local</code> d'abord : lancées depuis un poste, sur un arbre qui n'est pas main et souvent sur une partie des tests seulement. Mélangées aux mesures nocturnes, elles font des décrochages qui ne correspondent à aucun changement du dépôt. Les valeurs absentes ensuite : une couverture qui n'a pas pu être mesurée n'est pas une couverture de zéro, et la tracer comme telle inventerait une chute. Le tableau, lui, montre tout, <code>local</code> compris.</p>`,
      },
      {
        titre: 'Quand agir',
        texte: `<p>Quand les lignes <code>schedule</code> manquent : la mesure nocturne ne tourne pas. Quand un chiffre glisse plusieurs collectes de suite dans le mauvais sens : une couverture qui baisse, c'est du code ajouté sans test ; des capacités prouvées qui baissent, c'est une promesse du produit qui n'est plus tenue par aucun test joué. Un seul point de bascule ne veut rien dire, la pente de trois collectes si.</p>`,
      },
      {
        titre: 'Ce que ça ne dit pas',
        texte: `<p>Rien de plus fin qu'une collecte. Le détail test par test est dans la Mémoire des tests.</p>`,
      },
    ],
    blocs: {
      courbes:
        "Les mêmes chiffres que la Vue d'ensemble, mais sur 30 jours. Le nombre à côté du titre est l'écart entre la première et la dernière collecte de la fenêtre. Les collectes lancées depuis un poste sont écartées : elles ne mesurent pas main.",
    },
  },
};

/** Les identifiants de page que ce module connaît — pour que le rendu et le test s'accordent. */
export const PAGES_EXPLIQUEES = Object.keys(EXPLICATIONS);
