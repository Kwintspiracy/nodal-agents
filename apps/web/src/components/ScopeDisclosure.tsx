import Banner from '@/components/ui/Banner.tsx';

/**
 * CONNECTOR-001 (audit vague D): say how far the token reaches BEFORE sending
 * the user to the provider's consent screen.
 *
 * Four Google connectors request the widest scope in their family because
 * their tools need it — `drive.file` cannot open a file the user already has,
 * and the `.readonly` variants cannot write. The scope is defensible; letting
 * "connect Google Drive" read as "the files it needs" is not. Google's own
 * screen does say it, in Google's words, at the moment the user is already
 * committed. This says it in ours, while they can still walk away.
 *
 * Shared, not duplicated: the sentence must appear on EVERY road to the
 * provider's screen. There are two — the add form (a credential already
 * exists) and the credential wizard (the very first connection, i.e. the only
 * time the warning still changes anything). It lived in the add form alone
 * until 2026-09-14 (issue #83), which is exactly the road nobody new takes.
 *
 * The text is never written here: it comes from the connector's own catalog
 * entry (`scopeDisclosure`, packages/shared/src/connector-catalog.ts), so no
 * caller needs to know which provider is wide. Renders nothing when a
 * connector's reach matches its name.
 */
export default function ScopeDisclosure({ disclosure }: { disclosure?: string | null }) {
  if (!disclosure) return null;
  return (
    <Banner variant="warn" title="What this connector can reach">
      {disclosure}
    </Banner>
  );
}
