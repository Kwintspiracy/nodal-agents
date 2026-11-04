-- LA LANGUE PRÉFÉRÉE N'EXISTE PLUS (#986).
--
-- L'agent répond dans la langue du message auquel il répond, et rien d'autre
-- (décision de Quentin, 04/11/2026 : « si je lui parle en chinois, il me répond
-- en chinois »). Aucun réglage ne la remplace. L'entretien d'accueil ne demande
-- plus de langue ; il écrivait jusqu'ici un souvenir d'espace
-- « Operator — preferred language: <réponse> » (OnboardingFlow.tsx,
-- createMemoryAction : agent_id NULL, source 'manual', catégorie 'preference').
--
-- Mesuré sur le tour dit du root (5 tirages par variante, 04/11) : ce souvenir
-- était le déclencheur des accusés de réception en français à une demande
-- anglaise — 0 réponse française sur 10 une fois la ligne retirée du prompt.
--
-- Ce que la migration fait : elle ARCHIVE (archived = true, valid_to = now() —
-- réversible depuis l'écran Mémoire) les lignes ACTIVES que l'entretien a
-- écrites, et elles seules : souvenir d'espace (agent_id NULL), saisi
-- (source 'manual'), catégorie 'preference', dont `fact` COMMENCE par le
-- préfixe de la plateforme. Plusieurs lignes dans un même espace : toutes
-- archivées. Rien n'est supprimé, aucune valeur n'est recopiée ailleurs, et
-- rien d'autre n'est touché : un préfixe voisin (« preferred languages »), un
-- autre préfixe, les mêmes mots au milieu d'une phrase, une ligne écrite par un
-- agent restent tels quels.
--
-- Le préfixe se compare littéralement (`left(...) =`), pas par un LIKE : aucun
-- de ses caractères ne peut devenir un joker.
UPDATE agent_memory
SET archived = true,
    valid_to = now(),
    updated_at = now()
WHERE agent_id IS NULL
  AND source = 'manual'
  AND category = 'preference'
  AND archived = false
  AND valid_to IS NULL
  AND left(fact, char_length('Operator — preferred language:')) = 'Operator — preferred language:';
