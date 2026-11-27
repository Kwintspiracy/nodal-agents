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
import ScopeDisclosure from '@/components/ScopeDisclosure.tsx';
import Select from '@/components/ui/Select';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog.ts';
import { getOAuthProvider } from '@/lib/oauth-providers.ts';

export type CredentialWizardType =
  | 'google-oauth'
  | 'notion-oauth'
  | 'airtable-oauth'
  | 'microsoft-oauth';

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
  'microsoft-oauth': {
    label: 'Microsoft 365',
    callbackPath: '/api/oauth/microsoft-oauth/callback',
    namePlaceholder: 'Mon compte Microsoft',
    clientIdLabel: 'Application (client) ID',
    clientSecretLabel: 'Client secret value',
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
  {
    // Account-level credential, like google-oauth: one Microsoft credential
    // backs every M365 connector. The description lists the connectors wired
    // so far — grow it with each 0.8 office brick (Calendar, OneDrive, Excel),
    // exactly like the Google Workspace line above.
    type: 'microsoft-oauth',
    label: 'Microsoft 365',
    description: 'Outlook Mail',
  },
];

interface Props {
  /** Pre-select a credential type, skipping step 1. */
  initialType?: CredentialWizardType;
  /**
   * The connector the credential is created for: the authorisation asks for
   * ITS scopes, and after creation the OAuth callback redirects to
   * /connectors?connectorSlug={slug}&credentialId={id} for auto-assignment.
   * If unset (opened from the Credentials page), the person picks the service
   * in the form, and the callback redirects to /credentials?created={id}.
   */
  returnToConnectorSlug?: string;
  /**
   * The connector INSTANCE the new credential repairs (Reconnect on a
   * connector whose credential was deleted or cannot be read): the return
   * binds the credential to that row instead of creating a connector, so its
   * agents keep it. Needs `returnToConnectorSlug`.
   */
  rebindConnectorId?: string;
  /**
   * How far the connector's token reaches, in the product's own words — the
   * `scopeDisclosure` of the catalog entry the user clicked, passed straight
   * through (the wizard never decides which provider is wide; the connector
   * declares it). Undefined when the wizard is opened from the Credentials
   * page, where no connector is in play. Issue #83: on a fresh install this
   * wizard IS the first connection, so it is the only screen where the
   * warning can still change the user's mind.
   */
  scopeDisclosure?: string | null;
  onClose: () => void;
}

export default function CredentialWizard({
  initialType,
  returnToConnectorSlug,
  rebindConnectorId,
  scopeDisclosure,
  onClose,
}: Props) {
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

  // An authorisation is asked for one connector: the services this credential
  // type backs, one of which the person names when no card opened the wizard.
  const services = selectedType
    ? CONNECTOR_CATALOG.filter((c) => c.authType === 'oauth2' && c.credentialType === selectedType)
    : [];
  const [chosenService, setChosenService] = useState<string>('');
  const connector =
    returnToConnectorSlug ??
    (services.length === 1 ? services[0]!.slug : chosenService !== '' ? chosenService : null);
  const requestedScopes = connector ? (getOAuthProvider(connector)?.scopes ?? []) : [];

  // returnTo value propagated into the OAuth state cookie.
  const returnTo =
    returnToConnectorSlug && rebindConnectorId
      ? `/connectors?rebind=${rebindConnectorId}&connected=${returnToConnectorSlug}`
      : returnToConnectorSlug
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
      // L'ancre du PREMIER branchement : on atterrit ici quand aucun
      // identifiant compatible n'existe, donc la toute première fois qu'on
      // connecte un fournisseur — le seul moment où la portée du jeton se lit
      // avant de la donner (issues #72 et #83).
      testId="credential-wizard-dialog"
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
      {/* The reach is stated on BOTH steps: whichever one the user landed on,
          it is read before the submit button hands them to the provider. */}
      {scopeDisclosure && (
        <div className="mb-4">
          <ScopeDisclosure disclosure={scopeDisclosure} />
        </div>
      )}

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
                // Ancre stable (issue #55) : l'étape 1 de l'assistant est le
                // passage obligé d'une PREMIÈRE connexion, et un parcours qui
                // désignait ces options par leur libellé se cassait dès qu'on
                // reformulait « Google Workspace ».
                testId={`credential-type-${opt.type}`}
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
          {connector && (
            // eslint-disable-next-line no-restricted-syntax -- same native POST as above.
            <input type="hidden" name="connector" value={connector} />
          )}

          {/* Which service the authorisation is for, when no card said it. */}
          {!returnToConnectorSlug && services.length > 1 && (
            <div>
              <FieldLabel>Service</FieldLabel>
              <Select
                value={chosenService}
                onChange={(e) => setChosenService(e.target.value)}
                required
              >
                <option value="" disabled>
                  Choose the service to connect
                </option>
                {services.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>
          )}

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

          {/* What will be asked of the provider for this service. */}
          {requestedScopes.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-ink-3">Access requested</p>
              <div className="flex flex-wrap gap-1">
                {requestedScopes.map((scope) => (
                  <span
                    key={scope}
                    className="px-1.5 py-0.5 bg-hover text-ink-3 rounded text-mono-11"
                  >
                    {scope}
                  </span>
                ))}
              </div>
            </div>
          )}

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
            <PrimaryButton variant="ink" type="submit" disabled={!connector}>
              Continue with {config.label}
            </PrimaryButton>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}
