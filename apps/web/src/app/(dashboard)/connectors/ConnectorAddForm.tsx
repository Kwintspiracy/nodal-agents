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
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import TextInput from '@/components/ui/TextInput';
import Select from '@/components/ui/Select';
import FieldLabel from '@/components/ui/FieldLabel';
import { ModalFooter } from '@/components/ui/Modal.tsx';
import type { CompatibleCredential } from './ConnectorForm.tsx';

interface Props {
  catalogItem: ConnectorCatalogItem;
  /** OAuth credentials compatible with this connector's credentialType. Empty for api_key connectors. */
  compatibleCredentials: CompatibleCredential[];
  /** Called after a successful connection so the parent modal can close. */
  onDone?: () => void;
  /** Closes the wrapping modal without connecting (the modal is
   *  non-dismissable while this draft form is open — see UX-B7). */
  onCancel?: () => void;
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
  onCancel,
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
          <FieldLabel htmlFor={`add-name-${catalogItem.slug}`}>
            Name <span className="text-ink-4">(e.g. &quot;Notion perso&quot;)</span>
          </FieldLabel>
          <TextInput
            id={`add-name-${catalogItem.slug}`}
            name="name"
            required
            placeholder={catalogItem.label}
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
          <FieldLabel htmlFor={`add-apikey-${catalogItem.slug}`}>API key</FieldLabel>
          <TextInput
            id={`add-apikey-${catalogItem.slug}`}
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            className="font-mono"
          />
        </div>
        <ModalFooter className="-mx-6 -mb-6 mt-2 rounded-b-xl">
          {onCancel && (
            <PrimaryButton variant="neutral" type="button" onClick={onCancel}>
              Cancel
            </PrimaryButton>
          )}
          <PrimaryButton variant="ink" type="submit" disabled={isPending}>
            {isPending ? 'Connecting…' : 'Connect'}
          </PrimaryButton>
        </ModalFooter>
      </form>
    );
  }

  // ── oauth2 branch: has existing compatible credentials ──────────────────────
  if (isOAuth && compatibleCredentials.length > 0) {
    return (
      <div className="space-y-3">
        <div>
          <FieldLabel>Use existing credential</FieldLabel>
          <Select
            value={selectedCredentialId}
            onChange={(e) => setSelectedCredentialId(e.target.value)}
          >
            {compatibleCredentials.map((cred) => (
              <option key={cred.id} value={cred.id}>
                {cred.name}
                {cred.accountName ? ` (${cred.accountName})` : ''}
              </option>
            ))}
          </Select>
        </div>
        <ModalFooter className="-mx-6 -mb-6 mt-2 rounded-b-xl">
          {onCancel && (
            <PrimaryButton variant="neutral" type="button" onClick={onCancel}>
              Cancel
            </PrimaryButton>
          )}
          <PrimaryButton variant="neutral" onClick={() => onCreateNew?.()}>
            or create new
          </PrimaryButton>
          <PrimaryButton
            variant="ink"
            onClick={() => selectedCredentialId && performOAuthAssign(selectedCredentialId)}
            disabled={isPending || !selectedCredentialId}
          >
            {isPending ? 'Connecting…' : 'Connect'}
          </PrimaryButton>
        </ModalFooter>
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
      <ModalFooter className="-mx-6 -mb-6 mt-2 rounded-b-xl">
        {onCancel && (
          <PrimaryButton variant="neutral" type="button" onClick={onCancel}>
            Cancel
          </PrimaryButton>
        )}
        <PrimaryButton variant="ink" onClick={() => onCreateNew?.()}>
          Create credential
        </PrimaryButton>
      </ModalFooter>
    </div>
  );
}
