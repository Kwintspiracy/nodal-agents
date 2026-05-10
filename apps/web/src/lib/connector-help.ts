/**
 * Connector help guides — step-by-step instructions for each OAuth and api_key provider.
 *
 * Pure data, no side effects. Consumed by HelpSteps.tsx in both CredentialWizard (OAuth)
 * and ConnectorForm (api_key collapsible).
 */

export type GuideStep = {
  number: number;
  text: string;
  link?: { href: string; label: string };
  subLinks?: { href: string; label: string }[];
  hint?: string;
};

export type Guide = {
  title: string;
  intro?: string;
  warning?: string;
  steps: GuideStep[];
  format?: string;
};

// ─── OAuth guides ─────────────────────────────────────────────────────────────

export const OAUTH_GUIDES: Record<'google-oauth' | 'notion-oauth' | 'airtable-oauth', Guide> = {
  'google-oauth': {
    title: 'Get your Google OAuth credentials',
    intro: 'You need a Google Cloud project with the relevant APIs enabled.',
    steps: [
      {
        number: 1,
        text: 'Go to Google Cloud Console and create a new project (any name).',
        link: { href: 'https://console.cloud.google.com/', label: 'console.cloud.google.com' },
      },
      {
        number: 2,
        text: 'Enable each API your agents will use — click the links below, then hit Enable:',
        subLinks: [
          {
            href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
            label: 'Drive API',
          },
          {
            href: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
            label: 'Gmail API',
          },
          {
            href: 'https://console.cloud.google.com/apis/library/sheets.googleapis.com',
            label: 'Sheets API',
          },
          {
            href: 'https://console.cloud.google.com/apis/library/docs.googleapis.com',
            label: 'Docs API',
          },
        ],
      },
      {
        number: 3,
        text: 'In the left menu, go to APIs & Services → OAuth consent screen. Choose User Type: External, fill in the app name, then add your own email as a Test user.',
      },
      {
        number: 4,
        text: 'Go to APIs & Services → Credentials → Create credentials → OAuth client ID → Application type: Web application.',
      },
      {
        number: 5,
        text: 'Under Authorized JavaScript origins, add the origin shown below the form.',
      },
      {
        number: 6,
        text: 'Under Authorized redirect URIs, paste the redirect URI shown below.',
      },
      {
        number: 7,
        text: 'Click Create. A dialog shows your Client ID and Client secret. Copy both.',
      },
      {
        number: 8,
        text: 'Paste them into the fields below.',
      },
    ],
    format: 'Client ID ends with .apps.googleusercontent.com',
  },

  'notion-oauth': {
    title: 'Get your Notion OAuth credentials',
    intro: 'You need a Public integration — not an Internal one. The distinction matters.',
    steps: [
      {
        number: 1,
        text: 'Go to Notion integrations and click + New integration.',
        link: {
          href: 'https://www.notion.so/my-integrations',
          label: 'notion.so/my-integrations',
        },
      },
      {
        number: 2,
        text: 'Set Integration type to Public (not Internal — Internal tokens are single-workspace only and cannot do OAuth).',
        hint: 'If you see no "Type" field, you are on the wrong page.',
      },
      {
        number: 3,
        text: 'Fill in a name and optional logo. Under Capabilities, check at minimum: Read content, Update content, Insert content.',
      },
      {
        number: 4,
        text: 'Under OAuth Domain & URIs, paste the redirect URI shown below.',
      },
      {
        number: 5,
        text: 'Click Submit. On the integration page, open the Secrets tab.',
      },
      {
        number: 6,
        text: 'Copy the OAuth client ID (a UUID) and the OAuth client secret.',
      },
      {
        number: 7,
        text: 'Paste them into the fields below.',
      },
    ],
    format: 'Client ID is a UUID. Secret starts with secret_',
  },

  'airtable-oauth': {
    title: 'Get your Airtable OAuth credentials',
    warning:
      'Airtable only accepts localhost or an HTTPS redirect URI — raw LAN IPs (e.g. 192.168.x.x) are rejected. If you are accessing this dashboard via a LAN IP, open it at http://localhost:3000 just for this flow. The resulting credential will work from any host afterwards.',
    steps: [
      {
        number: 1,
        text: 'Go to the Airtable OAuth integration page and click Register new OAuth integration.',
        link: { href: 'https://airtable.com/create/oauth', label: 'airtable.com/create/oauth' },
      },
      {
        number: 2,
        text: 'Give it a name (e.g. NodalAI) and paste the redirect URI shown below.',
      },
      {
        number: 3,
        text: 'Under Scopes, check: data.records:read, data.records:write, schema.bases:read, schema.bases:write.',
      },
      {
        number: 4,
        text: 'Click Register integration.',
      },
      {
        number: 5,
        text: 'On the integration detail page, copy the Client ID and Client secret.',
      },
      {
        number: 6,
        text: 'Paste them into the fields below.',
      },
    ],
    format: 'Client ID is a short alphanumeric string. Secret is longer.',
  },
};

// ─── API key guides ───────────────────────────────────────────────────────────

export const APIKEY_GUIDES: Record<
  'notion' | 'airtable' | 'apify' | 'firecrawl' | 'tavily',
  Guide
> = {
  notion: {
    title: 'Get your Notion Internal Integration Token',
    intro:
      'This is the Internal integration flow — single workspace, no OAuth redirect. Different from the Notion OAuth credential.',
    steps: [
      {
        number: 1,
        text: 'Go to Notion integrations and click + New integration.',
        link: {
          href: 'https://www.notion.so/my-integrations',
          label: 'notion.so/my-integrations',
        },
      },
      {
        number: 2,
        text: 'Set Integration type to Internal (not Public). Select your workspace.',
      },
      {
        number: 3,
        text: 'Under Capabilities, check at minimum: Read content, Update content, Insert content.',
      },
      {
        number: 4,
        text: 'Click Submit. On the integration page, open the Secrets tab and copy the Internal Integration Token.',
      },
      {
        number: 5,
        text: 'Important: for each Notion page the agent should access, open the page, click the ··· menu → Connections → select your integration name.',
        hint: 'Without this step the agent gets "object not found" errors.',
      },
    ],
    format: 'Token starts with secret_',
  },

  airtable: {
    title: 'Get your Airtable Personal Access Token',
    steps: [
      {
        number: 1,
        text: 'Go to the Airtable token creation page and click Create new token.',
        link: {
          href: 'https://airtable.com/create/tokens',
          label: 'airtable.com/create/tokens',
        },
      },
      {
        number: 2,
        text: 'Give it a name. Under Scopes, add at minimum: data.records:read, data.records:write, schema.bases:read.',
      },
      {
        number: 3,
        text: 'Under Access, choose the specific bases to expose or select All workspaces.',
      },
      {
        number: 4,
        text: 'Click Create token and copy the value immediately — Airtable hides it after you close the dialog.',
      },
    ],
    format: 'Token starts with pat',
  },

  apify: {
    title: 'Get your Apify API token',
    steps: [
      {
        number: 1,
        text: 'Go to the Apify integrations page.',
        link: {
          href: 'https://console.apify.com/account/integrations',
          label: 'console.apify.com/account/integrations',
        },
      },
      {
        number: 2,
        text: 'Under API tokens, either copy the default Personal API token or click Create new token to generate a dedicated one.',
      },
      {
        number: 3,
        text: 'Paste the token into the field below.',
      },
    ],
    format: 'Token starts with apify_api_',
  },

  firecrawl: {
    title: 'Get your Firecrawl API key',
    steps: [
      {
        number: 1,
        text: 'Go to your Firecrawl account page and navigate to API Keys.',
        link: { href: 'https://www.firecrawl.dev/account', label: 'firecrawl.dev/account' },
      },
      {
        number: 2,
        text: 'Copy your existing key or click to generate a new one, then paste it below.',
      },
    ],
    format: 'Key starts with fc-',
  },

  tavily: {
    title: 'Get your Tavily API key',
    steps: [
      {
        number: 1,
        text: 'Go to the Tavily app and open the API section.',
        link: { href: 'https://app.tavily.com/', label: 'app.tavily.com' },
      },
      {
        number: 2,
        text: 'Copy your API key and paste it below.',
      },
    ],
    format: 'Key starts with tvly-',
  },
};
