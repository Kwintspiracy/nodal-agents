CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "credentials_type_check" CHECK ("credentials"."type" IN ('google-oauth','notion-oauth','airtable-oauth'))
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_credentials_owner" ON "credentials" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_credentials_type" ON "credentials" USING btree ("type");--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connectors_credential_id" ON "connectors" USING btree ("credential_id");--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "oauth_client_id";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "oauth_client_secret";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "oauth_refresh_token";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "oauth_access_token";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "oauth_token_expires_at";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "oauth_token_url";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "oauth_scopes";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "oauth_account_name";