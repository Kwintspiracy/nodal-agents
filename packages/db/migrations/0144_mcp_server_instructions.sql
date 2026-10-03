-- Les `instructions` qu'un serveur MCP publie à l'initialisation (étape 3 de la
-- 0.9.5, « hôte MCP », PR 1).
--
-- Le protocole laisse un serveur dire, une fois, comment se servir de ses
-- outils : le déroulé d'une impression, l'ordre des appels, ce qui revient à
-- l'utilisateur. Le SDK les garde (`Client.getInstructions()`), Nodal ne les
-- lisait jamais : l'agent qui tenait le serveur ne voyait que des outils isolés.
--
-- Écrite à CHAQUE connexion réussie, au même endroit qu'`available_tools`
-- (runner, actions du dashboard, `create_mcp`) : une valeur retirée par le
-- serveur est effacée, jamais gardée. NULL : le serveur n'en publie pas, ou
-- n'a pas été connecté depuis cette migration. Le texte est stocké tel quel ;
-- c'est le prompt qui le cadre et le plafonne.
ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS instructions text;
