-- L'ADRESSE qu'un modèle lit pour une conversation de canal (#824).
--
-- Un texte qui part chez un fournisseur de modèle nommait une conversation par
-- l'identifiant que le canal lui donne. Une conversation WhatsApp directe
-- s'appelle `<téléphone>@s.whatsapp.net` : le numéro partait chez le
-- fournisseur dans le contexte du job, l'avis de livraison d'un délégué,
-- `list_conversations` et le `by:` d'une réponse à une carte.
--
-- Désormais le modèle lit un HANDLE, tiré au hasard (jamais dérivé : le hachage
-- d'un numéro se renverse par énumération), une ligne par (entité, canal,
-- conversation). L'entité est la portée : deux bots d'un même propriétaire sur
-- une même conversation donnent UN handle. Les outils relisent le handle dans
-- l'entité du job avant leurs contrôles (queries/conversation-handles.ts).
CREATE TABLE IF NOT EXISTS conversation_handles (
  id text PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  channel text NOT NULL,
  conversation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_handles_entity_channel_conversation_unique
    UNIQUE (entity_id, channel, conversation_id),
  CONSTRAINT conversation_handles_id_check CHECK (id ~ '^conv_[a-z2-7]{10}$')
);
--> statement-breakpoint
-- Un NOM fait d'un identifiant de conversation est une donnée de contact. Le
-- gestionnaire WhatsApp écrivait le JID de l'expéditeur (`<téléphone>@…`) dans
-- `requester_name` quand la personne n'avait pas de nom affiché, et
-- `list_conversations` le rendait au modèle comme `name`.
--
-- Le JID est une information du PROPRIÉTAIRE : sur une demande d'accès d'un
-- GROUPE, c'est la seule trace de qui a demandé. Il n'est donc pas effacé, il
-- change de colonne : `requester_address` (lue par la carte du propriétaire et
-- la liste d'autorisation du dashboard, jamais pour un modèle), et
-- `requester_name` prend le nom de repli fixe que l'écrivain pose désormais
-- (`Someone`, celui de `sanitizeSenderName`). Rien n'est perdu. Seul cet
-- écrivain a jamais posé un JID ici : les autres canaux écrivent un nom affiché.
ALTER TABLE channel_allowed_conversations ADD COLUMN IF NOT EXISTS requester_address text;
--> statement-breakpoint
UPDATE channel_allowed_conversations
  SET requester_address = requester_name,
      requester_name = 'Someone'
  WHERE channel = 'whatsapp'
    AND requester_address IS NULL
    AND requester_name ~ '@(s\.whatsapp\.net|lid|g\.us|c\.us)$';
--> statement-breakpoint
-- Le VECTEUR d'une mémoire qui cite une conversation connue de son espace a été
-- calculé sur l'identifiant du canal ; désormais le texte part chez le
-- fournisseur d'embeddings avec les handles, et la requête d'un rappel aussi
-- (`embeddingsAddressedByHandle`, runner). Pour que les deux côtés soient
-- calculés sur la même réécriture, ces vecteurs sont effacés : le backfill du
-- démarrage (`backfillEmbeddings`) les recalcule à travers la frontière. Une
-- sous-chaîne suffit à choisir les lignes : en recalculer une de trop ne change
-- que son coût, jamais son texte (la réécriture, elle, ne remplace que des
-- identifiants entiers).
UPDATE agent_memory m
  SET embedding = NULL
  WHERE m.embedding IS NOT NULL
    AND m.entity_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM channel_allowed_conversations c
        WHERE (c.entity_id = m.entity_id
               OR c.agent_id IN (SELECT a.id FROM agents a WHERE a.entity_id = m.entity_id))
          AND strpos(m.fact, c.conversation_id) > 0
      )
      OR EXISTS (
        SELECT 1 FROM telegram_allowed_chats t
        WHERE (t.entity_id = m.entity_id
               OR t.agent_id IN (SELECT a.id FROM agents a WHERE a.entity_id = m.entity_id))
          AND strpos(m.fact, t.chat_id) > 0
      )
    );
