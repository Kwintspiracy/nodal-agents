-- 0096 — le préfixe de groupe quitte les TITRES de conversation (revue Codex
-- de P7, passe 29, doute 1).
--
-- Dans un salon partagé, les handlers préfixent la tâche par
-- `[Message from Untel]: ` pour que le modèle sache qui parle. 0094 a nommé
-- chaque conversation de canal avec la première ligne de sa première tâche —
-- préfixe compris. Résultat : une liste où toutes les lignes d'un même salon
-- commencent par les mêmes crochets, et où le sujet est repoussé hors du
-- plafond de 60 caractères. Le titre répond à « de quoi ça parle », jamais à
-- « qui a écrit le premier message ».
--
-- La TÂCHE n'est pas touchée : elle est auditée, et l'identité de celui qui
-- parle en fait partie. Seul le titre est corrigé, sur les lignes qui portent
-- réellement le préfixe — la même expression que `stripGroupPrefix`
-- (@nodal-agents/shared), qui nomme désormais les nouvelles conversations.
UPDATE conversations
SET title = regexp_replace(title, '^\[Message from [^\]]*\]:\s*', '')
WHERE title ~ '^\[Message from ';
