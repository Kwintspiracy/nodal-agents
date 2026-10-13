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
-- c'est le prompt qui le cadre.
--
-- Le cache d'outils (`available_tools`) d'un serveur connu AVANT cette
-- migration est effacé, une fois : sinon le job choisit la connexion
-- paresseuse, le serveur n'est connecté qu'au premier appel d'un de ses
-- outils, et ses instructions — qui disent justement quel outil appeler —
-- ne sont jamais lues avant (revue Codex passe 4 de #659). Sans cache, le job
-- suivant le connecte comme un serveur au cache v1 et réécrit les deux.
-- Seulement quand la colonne naît : rejouée, la migration ne touche rien.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = 'instructions'
  ) THEN
    ALTER TABLE mcp_servers ADD COLUMN instructions text;
    UPDATE mcp_servers SET available_tools = NULL WHERE available_tools IS NOT NULL;
  END IF;
END $$;
