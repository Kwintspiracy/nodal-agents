-- 0166 — ce qu'un outil MCP déclarait, rangé avec son appel (#1075).
--
-- Le relevé que le runner redonne d'un échange passé cite le résultat de chaque
-- appel qui n'était pas déclaré en lecture seule. « Déclaré » est un fait de
-- l'APPEL : relu sur les déclarations du jour, le relevé d'un échange fini
-- changeait dès qu'un serveur rafraîchissait ses outils, était supprimé, ou
-- qu'un second serveur prêtait le même nom, et le préfixe que le modèle avait
-- déjà vu cassait le cache.
--
-- `risk_level` (0095) le dit déjà pour les outils du produit et des
-- connecteurs. Pas pour un outil MCP : son niveau ne descend jamais sous
-- `write` (MCP-001, l'indice d'un serveur n'abaisse jamais la porte). Cette
-- colonne garde l'indice tel que le serveur le donnait à l'appel. NULL : pas
-- d'indice, ou une ligne d'avant 0166. Elle ne décide que de ce que le relevé
-- cite, jamais d'une approbation.

ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS read_only_hint boolean;
