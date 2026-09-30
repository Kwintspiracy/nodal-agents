-- Où chaque carte d'approbation a été livrée (#637).
--
-- L'id du message envoyé était jeté : seul un clic SUR la carte pouvait la
-- réécrire. Une demande tranchée depuis le dashboard ou un autre canal,
-- expirée par le balayage, ou close parce que son job a été annulé laissait
-- donc une carte morte, boutons actifs, chez le propriétaire.
--
-- Une ligne par carte envoyée. Quand la demande quitte `pending`, le point de
-- mise à jour la prend (`claimed_at`, un bail), l'édite, et pose `settled_at`
-- + `outcome` seulement quand c'est fini : édition réussie, canal qui ne sait
-- pas éditer, ou abandon après `attempts` échecs (`last_error` dit le dernier).
CREATE TABLE IF NOT EXISTS approval_card_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  channel text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  settled_at timestamptz,
  outcome text,
  CONSTRAINT approval_card_messages_channel_check
    CHECK (channel IN ('telegram','discord','slack','whatsapp')),
  CONSTRAINT approval_card_messages_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('edited','cannot_edit','gave_up'))
);

CREATE INDEX IF NOT EXISTS idx_approval_card_messages_request
  ON approval_card_messages (approval_request_id);
