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
-- `list_conversations` le rendait au modèle comme `name`. L'écrivain prend
-- maintenant le nom de repli fixe (`Someone`, celui de `sanitizeSenderName`) ;
-- les lignes déjà écrites reçoivent le même. Seul cet écrivain a jamais posé un
-- JID ici : les autres canaux écrivent un nom affiché.
UPDATE channel_allowed_conversations
  SET requester_name = 'Someone'
  WHERE channel = 'whatsapp'
    AND requester_name ~ '@(s\.whatsapp\.net|lid|g\.us|c\.us)$';
