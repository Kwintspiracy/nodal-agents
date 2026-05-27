'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  saveApiKeyConnectorAction,
  createOrAssignOAuthConnectorAction,
  type ConnectorCatalogItem,
} from '@/lib/actions.ts';
import CredentialWizard, { type CredentialWizardType } from '../credentials/CredentialWizard.tsx';
import HelpSteps from '@/components/HelpSteps.tsx';
import { APIKEY_GUIDES } from '@/lib/connector-help.ts';
import type { CompatibleCredential } from './ConnectorForm.tsx';

/** Human-friendly label for each credential type, used in button text. */
const PROVIDER_LABEL: Record<string, string> = {
  'google-oauth': 'Google',
  'notion-oauth': 'Notion',
  'airtable-oauth': 'Airtable',
};

interface Props {
  catalogItem: ConnectorCatalogItem;
  /** OAuth credentials compatible with this connector's credentialType. Empty for api_key connectors. */
  compatibleCredentials: CompatibleCredential[];
}

/**
 * Marketplace card for a single catalog entry.
 * Clicking "+ Add" expands a form:
 *   - api_key: name (required) + apiKey (required)
 *   - oauth2: opens CredentialWizard (credential.name becomes the instance name)
 */
export default function ConnectorAddForm({ catalogItem, compatibleCredentials }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>(
    compatibleCredentials[0]?.id ?? '',
  );

  const isApiKey = catalogItem.authType === 'api_key';
  const isOAuth = catalogItem.authType === 'oauth2';
  const credentialType = catalogItem.credentialType as CredentialWizardType | undefined;

  function handleApiKeySubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get('name') as string | null)?.trim() ?? '';
    const apiKey = (fd.get('apiKey') as string | null)?.trim() ?? '';
    if (!name) {
      toast.error('Name is required');
      return;
    }
    if (!apiKey) {
      toast.error('API key is required');
      return;
    }
    startTransition(async () => {
      const result = await saveApiKeyConnectorAction({ slug: catalogItem.slug, name, apiKey });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`${name} connected`);
      setOpen(false);
    });
  }

  function performOAuthAssign(credentialId: string) {
    startTransition(async () => {
      const r = await createOrAssignOAuthConnectorAction(catalogItem.slug, credentialId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${catalogItem.label} connected`);
      setOpen(false);
    });
  }

  return (
    <div className="bg-paper border border-rule-2 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{catalogItem.label}</h3>
          <p className="text-[11px] text-ink-3 font-mono mt-0.5">
            {catalogItem.slug} · {catalogItem.authType}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (isOAuth && compatibleCredentials.length === 0) {
              // No existing credentials → launch wizard directly
              setWizardOpen(true);
            } else {
              setOpen((v) => !v);
            }
          }}
          className="shrink-0 px-3 py-1.5 text-xs font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92]"
        >
          {open
            ? 'Cancel'
            : isOAuth && compatibleCredentials.length === 0
              ? `Connect with ${credentialType ? (PROVIDER_LABEL[credentialType] ?? catalogItem.label) : catalogItem.label}`
              : '+ Add'}
        </button>
      </div>

      <p className="text-xs text-ink-4">{catalogItem.docsHint}</p>

      {/* api_key expand form */}
      {isApiKey && open && (
        <form onSubmit={handleApiKeySubmit} className="space-y-3 pt-2 border-t border-rule-2">
          <div>
            <label
              htmlFor={`add-name-${catalogItem.slug}`}
              className="block text-xs text-ink-3 mb-1"
            >
              Name <span className="text-ink-4">(e.g. &quot;Notion — perso&quot;)</span>
            </label>
            <input
              id={`add-name-${catalogItem.slug}`}
              name="name"
              required
              placeholder={catalogItem.label}
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
            />
          </div>
          {APIKEY_GUIDES[catalogItem.slug as keyof typeof APIKEY_GUIDES] && (
            <details className="group text-xs">
              <summary className="cursor-pointer text-ink-3 hover:text-ink-2">
                Where do I get this?
              </summary>
              <div className="mt-3 pl-1">
                <HelpSteps guide={APIKEY_GUIDES[catalogItem.slug as keyof typeof APIKEY_GUIDES]} />
              </div>
            </details>
          )}
          <div>
            <label
              htmlFor={`add-apikey-${catalogItem.slug}`}
              className="block text-xs text-ink-3 mb-1"
            >
              API key
            </label>
            <input
              id={`add-apikey-${catalogItem.slug}`}
              name="apiKey"
              type="password"
              required
              autoComplete="off"
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
            />
          </div>
          <div className="pt-1">
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
            >
              {isPending ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      )}

      {/* oauth2 expand: pick existing credential or launch wizard */}
      {isOAuth && open && compatibleCredentials.length > 0 && (
        <div className="space-y-3 pt-2 border-t border-rule-2">
          <div>
            <label className="block text-xs text-ink-3 mb-1">Use existing credential</label>
            <select
              value={selectedCredentialId}
              onChange={(e) => setSelectedCredentialId(e.target.value)}
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
            >
              {compatibleCredentials.map((cred) => (
                <option key={cred.id} value={cred.id}>
                  {cred.name}
                  {cred.accountName ? ` (${cred.accountName})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 items-center pt-1">
            <button
              type="button"
              onClick={() => selectedCredentialId && performOAuthAssign(selectedCredentialId)}
              disabled={isPending || !selectedCredentialId}
              className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
            >
              {isPending ? 'Connecting…' : 'Connect'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setWizardOpen(true);
              }}
              className="px-3 py-1.5 text-xs text-ink-3 hover:text-ink underline"
            >
              or create new
            </button>
          </div>
        </div>
      )}

      {/* Credential wizard modal */}
      {wizardOpen && credentialType && (
        <CredentialWizard
          initialType={credentialType}
          returnToConnectorSlug={catalogItem.slug}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </div>
  );
}
