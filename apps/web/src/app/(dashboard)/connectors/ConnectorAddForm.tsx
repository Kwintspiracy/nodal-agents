'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  saveApiKeyConnectorAction,
  createOrAssignOAuthConnectorAction,
  type ConnectorCatalogItem,
} from '@/lib/actions.ts';
import HelpSteps from '@/components/HelpSteps.tsx';
import { APIKEY_GUIDES } from '@/lib/connector-help.ts';
import type { CompatibleCredential } from './ConnectorForm.tsx';

interface Props {
  catalogItem: ConnectorCatalogItem;
  /** OAuth credentials compatible with this connector's credentialType. Empty for api_key connectors. */
  compatibleCredentials: CompatibleCredential[];
  /** Called after a successful connection so the parent modal can close. */
  onDone?: () => void;
  /**
   * Called when the user clicks "or create new" in the OAuth branch.
   * The grid owns the CredentialWizard to avoid nesting two z-50 portals.
   */
  onCreateNew?: () => void;
}

/**
 * Inline form rendered directly inside a Modal panel for a single catalog entry.
 *   - api_key: name + apiKey fields + Connect button, immediately visible.
 *   - oauth2 with compatible credentials: credential select + Connect + "or create new" link.
 *   - oauth2 with no credentials: Connect button delegates entirely to onCreateNew (grid opens wizard).
 */
export default function ConnectorAddForm({
  catalogItem,
  compatibleCredentials,
  onDone,
  onCreateNew,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>(
    compatibleCredentials[0]?.id ?? '',
  );

  const isApiKey = catalogItem.authType === 'api_key';
  const isOAuth = catalogItem.authType === 'oauth2';

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
      onDone?.();
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
      onDone?.();
    });
  }

  // ── api_key branch ──────────────────────────────────────────────────────────
  if (isApiKey) {
    return (
      <form onSubmit={handleApiKeySubmit} className="space-y-3">
        <div>
          <label htmlFor={`add-name-${catalogItem.slug}`} className="block text-xs text-ink-3 mb-1">
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
    );
  }

  // ── oauth2 branch: has existing compatible credentials ──────────────────────
  if (isOAuth && compatibleCredentials.length > 0) {
    return (
      <div className="space-y-3">
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
            onClick={() => onCreateNew?.()}
            className="px-3 py-1.5 text-xs text-ink-3 hover:text-ink underline"
          >
            or create new
          </button>
        </div>
      </div>
    );
  }

  // ── oauth2 branch: no compatible credentials — grid opens wizard directly ───
  // This branch is only rendered if the grid somehow opens the modal for a
  // no-credentials oauth2 connector (needsWizard path should prevent this, but
  // guard defensively). Show a prompt to create a credential.
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-3">{catalogItem.docsHint}</p>
      <button
        type="button"
        onClick={() => onCreateNew?.()}
        className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92]"
      >
        Create credential
      </button>
    </div>
  );
}
