-- Où chaque carte d'approbation a été livrée (#637).
--
-- L'id du message envoyé était jeté : seul un clic SUR la carte pouvait la
-- réécrire. Une demande tranchée depuis le dashboard ou un autre canal,
-- expirée par le balayage, ou close parce que son job a été annulé laissait
-- donc une carte morte, boutons actifs, chez le propriétaire.
--
-- Une ligne par carte envoyée ; `settled_at` est posé une seule fois par le
-- point qui réécrit la carte quand la demande quitte `pending`.
CREATE TABLE IF NOT EXISTS approval_card_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  channel text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT approval_card_messages_channel_check
    CHECK (channel IN ('telegram','discord','slack','whatsapp'))
);

CREATE INDEX IF NOT EXISTS idx_approval_card_messages_request
  ON approval_card_messages (approval_request_id);
