-- LA LANGUE PRÉFÉRÉE N'EXISTE PLUS (#986).
--
-- L'agent répond dans la langue du message auquel il répond, et rien d'autre
-- (décision de Quentin, 04/11/2026 : « si je lui parle en chinois, il me répond
-- en chinois »). L'entretien d'accueil ne demande plus de langue ; il écrivait
-- jusqu'ici un souvenir d'espace « Operator — preferred language: <réponse> »
-- (OnboardingFlow.tsx, createMemoryAction : agent_id NULL, source 'manual',
-- catégorie 'preference').
--
-- Mesuré sur le tour dit du root (5 tirages par variante, 04/11) : ce souvenir
-- était le déclencheur des accusés de réception en français à une demande
-- anglaise — 0 réponse française sur 10 une fois la ligne retirée du prompt.
--
-- Ce que la migration fait : elle ARCHIVE (archived = true, réversible depuis
-- l'écran Mémoire) les lignes dont `fact` COMMENCE EXACTEMENT par le préfixe
-- que la plateforme écrivait. Elle ne supprime rien, et ne touche à rien
-- d'autre : une ligne qui parle de langue autrement (« preferred languages »,
-- un autre préfixe, les mêmes mots au milieu d'une phrase) reste telle quelle.
-- La comparaison est un préfixe littéral (`left(...) =`), pas un LIKE : aucun
-- caractère du préfixe n'y devient un joker.
--
-- `agent_id` n'est PAS exigé NULL : le préfixe est celui de la plateforme, et
-- une copie qu'un agent en aurait faite porterait le même déclencheur.
UPDATE agent_memory
SET archived = true,
    updated_at = now()
WHERE archived = false
  AND left(fact, char_length('Operator — preferred language:')) = 'Operator — preferred language:';
