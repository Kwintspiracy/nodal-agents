-- 0164 — l'appairage d'un appareil et sa clé (#946).
--
-- Un appareil s'appaire DE SON CÔTÉ, à la manière de la RFC 8628 : sans clé,
-- il demande un code à Nodal, le montre ou le dit, et interroge jusqu'à ce que
-- le propriétaire confirme ou refuse dans Réglages → Appareils. Confirmé, il
-- reçoit UNE fois sa propre clé, limitée à ses routes et à sa conversation.
-- Un appareil ne détient jamais le secret du worker.
--
-- `device_pairings` : une demande d'appairage. Elle n'appartient à AUCUN espace
-- tant que le propriétaire ne l'a pas confirmée depuis la page Appareils d'un
-- espace ; la confirmer la rattache à cet espace (`entity_id`) et crée
-- l'appareil (`device_id`). Le code de l'appareil n'est gardé que haché.
--
-- `devices` gagne sa clé : seul son haché (sha256) est gardé, et `revoked_at`
-- la refuse dès la requête suivante. Un appareil retiré reste en base : sa
-- conversation passée reste dans Chat, nommée d'après lui.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS token_hash text;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
--> statement-breakpoint
-- L'adresse d'où il s'est appairé. NULL : il n'est pas passé par l'appairage.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS paired_from text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS devices_token_hash_unique
  ON devices (token_hash) WHERE token_hash IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS device_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE,
  user_code text NOT NULL CHECK (user_code ~ '^[0-9]{6}$'),
  -- Le nom que l'appareil se donne : du TEXTE, affiché comme tel.
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  capabilities text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (capabilities <@ ARRAY['microphone','speaker','screen','buttons']::text[]),
  protocol_version integer NOT NULL CHECK (protocol_version >= 1),
  requested_from text NOT NULL,
  -- pending → confirmed → delivered (la clé est remise) ; pending → refused.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','refused','delivered')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_polled_at timestamptz,
  decided_at timestamptz,
  entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
  conversation_id uuid,
  -- Confirmée = rattachée à un espace, avec son appareil et sa conversation.
  CONSTRAINT device_pairings_confirmed_check CHECK (
    (status IN ('confirmed','delivered'))
      = (entity_id IS NOT NULL AND device_id IS NOT NULL AND conversation_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_device_pairings_status ON device_pairings (status, expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_device_pairings_from ON device_pairings (requested_from, created_at);
