export type CredentialEntry = {
  id: string;
  name: string;
  type: 'google-oauth' | 'notion-oauth' | 'airtable-oauth' | 'microsoft-oauth';
  accountName: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  inUseBy: { connectorSlug: string; connectorId: string }[];
  /** Non-null when the at-rest payload could not be decrypted. */
  decryptError: string | null;
};
