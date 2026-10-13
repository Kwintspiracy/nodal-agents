-- Un serveur MCP pose une question pendant un de ses appels (élicitation).
--
-- La question vit dans `approval_requests`, comme les approbations et les
-- questions d'`ask_user` : mêmes cartes, même cloche, même page, même balayage.
-- Ce qui la distingue, `kind = 'elicitation'` :
--   - elle ne suspend pas le job : le serveur garde son appel ouvert et le run
--     attend la réponse en sondant la ligne ;
--   - elle n'est JAMAIS un appel à rejouer. La ligne naît avec `executed_at`
--     posé (l'appel auquel elle appartient est en cours d'exécution), et chaque
--     lecteur qui rejoue des appels approuvés filtre aussi sur `kind`.
--
-- `response` : ce que la personne a rempli, validé contre le formulaire que le
-- serveur a demandé (`tool_input.requestedSchema`). NULL tant que personne n'a
-- répondu, et sur un refus.
--
-- `approval_request_attachments` : les images que le serveur joint à sa
-- question (`_meta["nodal/attachments"]`). Une table à part pour que les
-- lectures de `approval_requests` (listes, cloche, reprise) ne traînent jamais
-- plusieurs Mo de base64 qu'elles n'affichent pas.
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_kind_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_kind_check CHECK (kind IN ('approval','question','elicitation'));

ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS response jsonb;

CREATE TABLE IF NOT EXISTS approval_request_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  position integer NOT NULL,
  mime_type text NOT NULL,
  data text NOT NULL,
  byte_size integer NOT NULL,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_request_attachments_mime_check
    CHECK (mime_type IN ('image/png','image/jpeg','image/webp','image/gif')),
  CONSTRAINT approval_request_attachments_position_unique
    UNIQUE (approval_request_id, position)
);
