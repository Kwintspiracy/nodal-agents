# AUDIT_SUMMARY — Nodal-Agents 0.8.1

**2026-08-07** · `main` @ `144383f` · tarball 0.8.1 installé et démarré en environnement isolé

---

## Verdict

Le produit est **mieux construit que la moyenne sur les mécanismes**, et **exposé sur les
frontières**. Le chiffrement est correct, les comparaisons de secrets sont à temps constant, le claim
de job est atomique, le découpage de cache de prompt est juste, le durcissement ACL Windows fonctionne
réellement — ce sont des choses que la plupart des projets ratent, et elles ont été vérifiées en
exécution, pas supposées.

Ce qui manque, c'est la frontière : le runner accepte des ordres de n'importe quelle page web, et le
contenu écrit par des tiers entre dans le contexte du modèle sans le moindre marquage. Ces deux
défauts partagent une racine — le bon motif existe dans le projet (l'enveloppe anti-injection des
webhooks, `isPrivateOrigin`), il n'a simplement jamais été généralisé.

Et un point sans rapport avec la sécurité domine tout le reste : **la version publiée est cassée**.

**P0 : 2 · P1 : 6 · P2 : 6** · 13 findings `Confirmed`, 1 `Likely`, 0 `Unverified`.

---

## Les cinq choses qui comptent, en clair

**1. Le dashboard de la 0.8.1 ne démarre pas sur une installation neuve.** Le paquet publié demande
« Next 16.2.6 ou plus récent » alors que le dashboard est livré pré-compilé contre 16.2.6 exactement.
npm installe aujourd'hui la 16.3.0, et le serveur plante au démarrage. Vérifié en installant le vrai
tarball, puis prouvé en épinglant 16.2.6 : le dashboard remonte immédiatement. C'est le même symptôme
que l'incident de la 0.8.0, par un autre mécanisme — et cette fois il est apparu **sans qu'aucune
ligne de code ne change**, le jour où Next a publié une version mineure.

**2. N'importe quel site web que vous visitez peut piloter vos agents.** Le runner n'écoute que sur
la machine locale, ce qui est correct — mais votre navigateur est sur la machine locale. Une page web
quelconque peut envoyer une requête à `127.0.0.1:3001/api/agent` et créer une tâche. Testé : sans
en-tête d'authentification → accepté ; avec une origine attaquante → accepté ; avec un `Host`
falsifié → accepté ; en `text/plain`, donc sans que le navigateur ne demande la permission au
serveur → accepté, tâche créée, et les journaux confirment que l'agent a bien démarré son exécution.
Le code qui corrige ça existe déjà dans le projet, il n'a jamais été branché sur le runner.

**3. Rien ne dit au modèle « ceci est une donnée, pas un ordre ».** Sur dix-huit endroits où du texte
écrit par un tiers entre dans le contexte de l'agent — page web, document Notion, réponse d'un
serveur MCP, message reçu, fichier lu — un seul est encadré : les webhooks. Le commentaire de ce
code dit d'ailleurs très bien pourquoi c'est nécessaire. Le raisonnement n'a pas été appliqué
ailleurs.

**4. Les deux surfaces qui rendent une injection permanente sont mal protégées.** La mémoire est
filtrée par une liste de mots-clés anglais : sur seize formulations testées, **quatorze passent** —
la même consigne en espagnol, en allemand, ou simplement reformulée en anglais, n'est pas vue. Les
skills apprises, elles, n'ont **aucun** filtre, et sont auto-attachées à l'agent qui les écrit. La
seconde n'est pas active par défaut, ce qui la maintient en P1 plutôt qu'en P0 — mais elle le
deviendra le jour où la fonctionnalité sera activée.

**5. Le « plafond en dollars » ne plafonne rien, sauf sur OpenRouter.** Il ne se déclenche que si le
fournisseur renvoie lui-même le montant facturé. Un seul le fait. Pour les onze autres, le compteur
reste à zéro. Ce qui protège réellement est le plafond en **tokens** — qui est, lui, bien fait, et
même intelligemment calculé hors cache. Le problème n'est pas la protection, c'est la promesse.

---

## Si vous ne faites que trois choses

1. **Épingler `next` à la version exacte** dans le `package.json` du pack, et republier. Un caractère.
   Le produit publié est actuellement inutilisable pour un nouvel installateur.

2. **Brancher `isPrivateOrigin` sur le runner** en middleware, plus une validation du `Host`. Le
   fichier existe, il est testé, il n'a jamais été appelé. Cela ferme le seul chemin de l'audit qui
   donne le contrôle d'un agent à un inconnu.

3. **Câbler `scripts/verify-install.mjs` dans la CI** : packer, installer proprement, démarrer,
   interroger `/api/health` du runner **et** du dashboard. Ce script a été écrit après l'incident de
   la 0.8.0 et n'a jamais été appelé par la CI. Il aurait attrapé la 0.8.0 et il aurait attrapé
   celle-ci.

---

## Ce qui n'a pas été couvert, et pourquoi

Cet audit couvre **51 des 137 contrôles** prévus. Le détail est dans `AUDIT_COVERAGE.md` ; les zones
manquantes en résumé :

- **Tout ce qui exige un fournisseur LLM en fonctionnement** : taux de succès réel d'une injection sur
  un modèle donné, taux de hit du cache mesuré côté fournisseur, déclenchement du plafond de coût en
  charge, coût réel d'un job délégué. Aucune clé fournisseur n'était disponible dans l'environnement
  d'audit, et l'onboarding du dashboard en exige une pour aller plus loin. Les mesures de tokens ont
  donc été faites **localement avec un vrai tokenizer** sur les blocs constants — c'est précis, mais
  ça ne couvre pas l'historique de conversation ni la délégation.
- **Les onze harnais LLM autres qu'Anthropic**, contrôle par contrôle. Seul le drapeau `promptCaching`
  a été relevé pour les douze.
- **Les canaux Slack, Discord, WhatsApp et email** : vérification de signature, portées OAuth, gestion
  de session. Seul Telegram a été instruit, et partiellement.
- **Les 153 server actions du dashboard** : l'onboarding bloque sans clé LLM, donc la surface
  authentifiée n'a pas pu être atteinte.
- **Le comportement sous Docker et WSL**, la croissance disque sur un an, l'accessibilité WCAG, les
  fuites mémoire sur session longue.
Cette liste **ne contient plus** le tarball npm : il a été retéléchargé depuis le registre en fin
d'audit, son empreinte SHA-256 est identique à celle du tarball testé, et `dist-tags.latest` vaut
bien `0.8.1`. SUPPLY-001 porte donc sur l'artefact que reçoit tout nouvel installateur.

Aucune de ces zones n'est marquée « conforme ». Elles sont marquées `BLOCKED`, avec la raison exacte.
Ne pas avoir trouvé de faille n'est pas la même chose que ne pas avoir cherché.
