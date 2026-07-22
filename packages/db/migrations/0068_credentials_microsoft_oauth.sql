-- microsoft-oauth credential type (0.8 Office brick, M365 socle). The
-- credentials table gates types with a CHECK constraint (0006) — widening it
-- is the whole migration; the payload shape is the same encrypted blob as
-- google-oauth (clientId/clientSecret/refreshToken/accessToken/expiresAt/
-- scopes/accountName/tokenUrl), validated at the shared layer.
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_type_check";--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_type_check" CHECK ("type" IN ('google-oauth','notion-oauth','airtable-oauth','microsoft-oauth'));
