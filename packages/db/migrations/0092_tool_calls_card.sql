-- 0092 — la carte et la charge utile d'un appel d'outil (plan « De la maquette
-- au produit », P1).
--
-- Chaque outil déclare comment son résultat se montre (`card`) et, pour les
-- cartes à structure, traduit sa sortie dans la forme de cette carte
-- (`presented`, validée contre @nodal-agents/shared tool-cards.ts). Les deux
-- sont écrites par executeTool au moment de l'appel, avec la ligne d'audit :
-- l'écran de conversation lit la ligne, jamais le registre, et une ligne
-- d'hier se dessine comme le jour où elle a été écrite (modèle DeepSeek
-- Harness : le meta de présentation voyage avec le résultat).
--
-- Aucun backfill : une ligne antérieure garde card = NULL et presented = NULL,
-- et l'écran montre l'entrée et la sortie brutes en le disant. Rejouer les
-- présentateurs sur 16 000 lignes anciennes raconterait l'histoire avec les
-- outils d'aujourd'hui.
--
-- presentation_error : quand le présentateur d'un outil a violé son contrat,
-- la ligne le dit ici (presented reste NULL). Un log ne suffit pas à « fail
-- loud » : il faut pouvoir compter ces lignes (revue passe 14).
ALTER TABLE tool_calls
  ADD COLUMN IF NOT EXISTS card text;
--> statement-breakpoint
ALTER TABLE tool_calls
  ADD COLUMN IF NOT EXISTS presented jsonb;
--> statement-breakpoint
ALTER TABLE tool_calls
  ADD COLUMN IF NOT EXISTS presentation_error text;
