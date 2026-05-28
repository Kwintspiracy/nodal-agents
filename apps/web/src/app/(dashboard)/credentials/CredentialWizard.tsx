'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import HelpSteps from '@/components/HelpSteps.tsx';
import { OAUTH_GUIDES } from '@/lib/connector-help.ts';

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
  const [mounted, setMounted] = useState(false);
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

  // SSR-safe portal gate: createPortal needs document, only present after hydration.
  // Setting state in this effect is intentional.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // ESC to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleTypeSelect(type: CredentialWizardType) {
    setSelectedType(type);
    setStep('setup');
  }

  function copyRedirectUri() {
    if (redirectUri) {
      void navigator.clipboard.writeText(redirectUri).then(() => {
        // No toast here — visual feedback via button text change is enough.
      });
    }
  }

  const config = selectedType ? PROVIDER_CONFIGS[selectedType] : null;

  // returnTo value propagated into the OAuth state cookie.
  const returnTo = returnToConnectorSlug
    ? `/connectors?connectorSlug=${returnToConnectorSlug}`
    : '/credentials';

  const formAction = selectedType ? `/api/oauth/${selectedType}/start` : '#';

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative bg-paper border border-rule-2 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header — sticky so close button is always visible */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-rule-2 shrink-0">
          <h2 id="wizard-title" className="text-base font-semibold text-ink">
            {step === 'type'
              ? 'New credential'
              : config
                ? `Configure ${config.label} credential`
                : 'Configure credential'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Step 1 — Type selection */}
        {step === 'type' && (
          <div className="overflow-y-auto px-6 py-5 space-y-3">
            <p className="text-sm text-ink-3">
              Choose the OAuth provider to connect to Nodal-Agents.
            </p>
            <div className="space-y-2">
              {TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.type}
                  type="button"
                  onClick={() => handleTypeSelect(opt.type)}
                  className="w-full text-left px-4 py-3 rounded-lg border border-rule-2 hover:border-rule hover:bg-hover transition-colors group"
                >
                  <div className="text-sm font-semibold text-ink group-hover:text-ink">
                    {opt.label}
                  </div>
                  <div className="text-xs text-ink-3 mt-0.5">{opt.description}</div>
                </button>
              ))}
            </div>
            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — Setup screen */}
        {step === 'setup' && config && selectedType && (
          <form
            ref={formRef}
            method="POST"
            action={formAction}
            encType="application/x-www-form-urlencoded"
            className="overflow-y-auto px-6 py-5 space-y-5"
          >
            {/* Hidden returnTo field — propagated through OAuth state cookie */}
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
                <button
                  type="button"
                  onClick={copyRedirectUri}
                  className="shrink-0 px-2 py-0.5 text-xs font-medium border border-rule text-ink-3 rounded hover:border-ink-3 hover:text-ink transition-colors"
                >
                  Copy
                </button>
              </div>
            </div>

            {/* Form fields */}
            <div className="space-y-3 border-t border-rule-2 pt-4">
              <div>
                <label className="block text-xs text-ink-3 mb-1">
                  Display name <span className="text-ink-4">(optional)</span>
                </label>
                <input
                  name="name"
                  placeholder={config.namePlaceholder}
                  className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-ink-3 mb-1">{config.clientIdLabel}</label>
                <input
                  name="clientId"
                  required
                  autoComplete="off"
                  className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-ink-3 mb-1">{config.clientSecretLabel}</label>
                <input
                  name="clientSecret"
                  type="password"
                  required
                  autoComplete="off"
                  className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none font-mono"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink"
              >
                Cancel
              </button>
              {!initialType && (
                <button
                  type="button"
                  onClick={() => setStep('type')}
                  className="px-4 py-2 text-sm font-medium border border-rule-2 text-ink-3 rounded-md hover:border-rule hover:text-ink"
                >
                  Back
                </button>
              )}
              <button
                type="submit"
                className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92]"
              >
                Continue with {config.label}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
