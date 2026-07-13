'use client';

import { useState, useEffect, useRef } from 'react';
import HelpSteps from '@/components/HelpSteps.tsx';
import { OAUTH_GUIDES } from '@/lib/connector-help.ts';
import Modal, { ModalFooter } from '@/components/ui/Modal.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import { OptionRadio } from '@/components/ui/OptionRadio';
import TextInput from '@/components/ui/TextInput';
import FieldLabel from '@/components/ui/FieldLabel';
import CopyButton from '@/components/ui/CopyButton';

export type CredentialWizardType = 'google-oauth' | 'notion-oauth' | 'airtable-oauth';

interface ProviderConfig {
  label: string;
  /** Path suffix appended to window.location.origin to build the redirect URI. */
  callbackPath: string;
  clientIdLabel: string;
  clientSecretLabel: string;
  /** Display name placeholder shown in the form. */
  namePlaceholder: string;
}

const PROVIDER_CONFIGS: Record<CredentialWizardType, ProviderConfig> = {
  'google-oauth': {
    label: 'Google',
    callbackPath: '/api/oauth/google-oauth/callback',
    namePlaceholder: 'Mon Google perso',
    clientIdLabel: 'Client ID',
    clientSecretLabel: 'Client secret',
  },
  'notion-oauth': {
    label: 'Notion',
    callbackPath: '/api/oauth/notion-oauth/callback',
    namePlaceholder: 'Mon Notion',
    clientIdLabel: 'OAuth client ID',
    clientSecretLabel: 'OAuth client secret',
  },
  'airtable-oauth': {
    label: 'Airtable',
    callbackPath: '/api/oauth/airtable-oauth/callback',
    namePlaceholder: 'Mon Airtable',
    clientIdLabel: 'Client ID',
    clientSecretLabel: 'Client secret',
  },
};

const TYPE_OPTIONS: { type: CredentialWizardType; label: string; description: string }[] = [
  {
    type: 'google-oauth',
    label: 'Google Workspace',
    description: 'Drive, Gmail, Sheets, Docs',
  },
  {
    type: 'notion-oauth',
    label: 'Notion',
    description: 'Public OAuth integration',
  },
  {
    type: 'airtable-oauth',
    label: 'Airtable',
    description: 'Public OAuth integration',
  },
];

interface Props {
  /** Pre-select a credential type, skipping step 1. */
  initialType?: CredentialWizardType;
  /**
   * If set, after credential creation the OAuth callback will redirect to
   * /connectors?connected={slug}&credentialId={id} for auto-assignment.
   * If unset, the callback redirects to /credentials?created={id}.
   */
  returnToConnectorSlug?: string;
  onClose: () => void;
}

export default function CredentialWizard({ initialType, returnToConnectorSlug, onClose }: Props) {
  const [step, setStep] = useState<'type' | 'setup'>(initialType ? 'setup' : 'type');
  const [selectedType, setSelectedType] = useState<CredentialWizardType | null>(
    initialType ?? null,
  );
  const [redirectUri, setRedirectUri] = useState<string>('');
  const formRef = useRef<HTMLFormElement>(null);

  // Compute origin on the client side to avoid SSR hydration mismatch.
  // Setting state synchronously in this effect is intentional — we need
  // window.location.origin which is unavailable during SSR.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRedirectUri(
      `${window.location.origin}${selectedType ? PROVIDER_CONFIGS[selectedType].callbackPath : ''}`,
    );
  }, [selectedType]);

  function handleTypeSelect(type: CredentialWizardType) {
    setSelectedType(type);
    setStep('setup');
  }

  const config = selectedType ? PROVIDER_CONFIGS[selectedType] : null;

  // returnTo value propagated into the OAuth state cookie.
  const returnTo = returnToConnectorSlug
    ? `/connectors?connectorSlug=${returnToConnectorSlug}`
    : '/credentials';

  const formAction = selectedType ? `/api/oauth/${selectedType}/start` : '#';
  const title =
    step === 'type'
      ? 'New credential'
      : config
        ? `Configure ${config.label} credential`
        : 'Configure credential';

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      // Step 1 is a plain selector (nothing to lose) so it stays dismissable.
      // Step 2 collects typed credentials (draft) — non-dismissable, same
      // rule as every other draft form in the app (UX-B7).
      dismissable={step === 'type'}
      footer={
        step === 'type' ? (
          <ModalFooter>
            <PrimaryButton variant="neutral" onClick={onClose}>
              Cancel
            </PrimaryButton>
          </ModalFooter>
        ) : undefined
      }
    >
      {/* Step 1 — Type selection */}
      {step === 'type' && (
        <div className="space-y-3">
          <p className="text-sm text-ink-3">
            Choose the OAuth provider to connect to Nodal-Agents.
          </p>
          <div className="space-y-2">
            {TYPE_OPTIONS.map((opt) => (
              <OptionRadio
                key={opt.type}
                active={selectedType === opt.type}
                onClick={() => handleTypeSelect(opt.type)}
                name={opt.label}
                description={opt.description}
              />
            ))}
          </div>
        </div>
      )}

      {/* Step 2 — Setup screen. Its own ModalFooter (not the Modal `footer`
          prop) so the submit button stays a DESCENDANT of the <form> — it's
          a native POST redirect into the OAuth flow, not a JS handler. */}
      {step === 'setup' && config && selectedType && (
        <form
          ref={formRef}
          method="POST"
          action={formAction}
          encType="application/x-www-form-urlencoded"
          className="space-y-5"
        >
          {/* Hidden returnTo field — propagated through OAuth state cookie */}
          {/* eslint-disable-next-line no-restricted-syntax -- native hidden
              field required for the browser's own POST redirect into the
              OAuth flow; not a visible field, no design-system counterpart. */}
          <input type="hidden" name="returnTo" value={returnTo} />

          {/* Instructions */}
          <div className="space-y-2">
            <p className="text-xs text-ink-3 font-semibold uppercase tracking-wider">
              Setup instructions
            </p>
            <HelpSteps guide={OAUTH_GUIDES[selectedType]} />
          </div>

          {/* Redirect URI copy box */}
          <div className="space-y-1">
            <p className="text-xs text-ink-3">Authorized redirect URI</p>
            <div className="flex items-center gap-2 bg-hover border border-rule rounded-md px-3 py-2">
              <code className="text-xs text-ink-2 font-mono flex-1 break-all">
                {redirectUri || '…'}
              </code>
              <CopyButton value={redirectUri} className="shrink-0" />
            </div>
          </div>

          {/* Form fields */}
          <div className="space-y-3 border-t border-rule-2 pt-4">
            <div>
              <FieldLabel>
                Display name <span className="text-ink-4">(optional)</span>
              </FieldLabel>
              <TextInput name="name" placeholder={config.namePlaceholder} />
            </div>
            <div>
              <FieldLabel>{config.clientIdLabel}</FieldLabel>
              <TextInput name="clientId" required autoComplete="off" className="font-mono" />
            </div>
            <div>
              <FieldLabel>{config.clientSecretLabel}</FieldLabel>
              <TextInput
                name="clientSecret"
                type="password"
                required
                autoComplete="off"
                className="font-mono"
              />
            </div>
          </div>

          <ModalFooter className="-mx-6 -mb-6 mt-2 rounded-b-xl">
            <PrimaryButton variant="neutral" type="button" onClick={onClose}>
              Cancel
            </PrimaryButton>
            {!initialType && (
              <PrimaryButton variant="neutral" type="button" onClick={() => setStep('type')}>
                Back
              </PrimaryButton>
            )}
            <PrimaryButton variant="ink" type="submit">
              Continue with {config.label}
            </PrimaryButton>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}
