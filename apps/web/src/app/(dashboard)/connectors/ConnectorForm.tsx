'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { toast } from 'sonner';
import { PencilSimple } from '@phosphor-icons/react';
import {
  deleteConnectorAction,
  renameConnectorAction,
  assignCredentialAction,
  updateConnectorApiKeyAction,
  type ConnectorRow,
  type ConnectorCatalogItem,
} from '@/lib/actions.ts';
import { refreshCredentialAction } from '@/lib/credentials.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import StatusPill from '@/components/ui/StatusPill.tsx';
import TextInput from '@/components/ui/TextInput';
import Select from '@/components/ui/Select';
import FieldLabel from '@/components/ui/FieldLabel';
import { ModalFooter } from '@/components/ui/Modal.tsx';
import CredentialWizard, { type CredentialWizardType } from '../credentials/CredentialWizard.tsx';

/** One labelled row in the connector's metadata block — replaces the old
 *  unlabelled "gmail · oauth2" stack (UX-B7: raw values with no context). */
function MetaField({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-legacy-10-5 font-medium uppercase tracking-wider text-ink-4">{label}</dt>
      <dd className={`mt-0.5 truncate text-body-13 text-ink-2 ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

/** Credential types that do not support access-token refresh (Notion). */
const OAUTH_NO_REFRESH_SLUGS: ReadonlySet<string> = new Set(['notion-oauth']);

/**
 * Renders a relative time string for an OAuth token expiry date.
 */
function formatTokenExpiry(date: Date | null): string {
  if (!date) return '';
  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const abs = Math.abs(diffSec);

  let magnitude: string;
  if (abs < 60) {
    magnitude = `${abs}s`;
  } else if (abs < 3600) {
    magnitude = `${Math.round(abs / 60)} min`;
  } else if (abs < 86400) {
    magnitude = `${Math.round(abs / 3600)} h`;
  } else {
    magnitude = `${Math.round(abs / 86400)} d`;
  }

  return diffSec >= 0 ? `expires in ${magnitude}` : `expired ${magnitude} ago`;
}

function isExpiredDate(date: Date | null): boolean {
  if (!date) return false;
  return date.getTime() < Date.now();
}

export type CompatibleCredential = {
  id: string;
  name: string;
  accountName: string | null;
};

interface Props {
  instance: ConnectorRow;
  catalogEntry: ConnectorCatalogItem;
  /** OAuth credentials compatible with this connector's credentialType. Empty for api_key connectors. */
  compatibleCredentials: CompatibleCredential[];
  /** Closes the wrapping edit Modal (UX-B6). Called automatically after a
   *  successful delete/disconnect (the instance no longer exists) and by the
   *  explicit "Close" button — the modal itself is non-dismissable so this is
   *  the only way out besides those. */
  onClose: () => void;
}

export default function ConnectorForm({
  instance,
  catalogEntry,
  compatibleCredentials,
  onClose,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, startRefreshTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  // Rename state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(instance.name);

  // Switch credential state
  const [switchOpen, setSwitchOpen] = useState(false);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>(
    instance.credentialId ?? compatibleCredentials[0]?.id ?? '',
  );

  // Rotate-key state (api_key connectors only). Collapsed by default so a
  // sensitive input doesn't sit visible on the page; revealed via a button.
  const [rotateOpen, setRotateOpen] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');

  const isApiKey = instance.authType === 'api_key';
  const isOAuth = instance.authType === 'oauth2';
  const isConnected = instance.active;
  const supportsRefresh = isOAuth && !OAUTH_NO_REFRESH_SLUGS.has(catalogEntry.credentialType ?? '');
  const credentialType = catalogEntry.credentialType as CredentialWizardType | undefined;

  const connectedCredentialId = instance.credentialId;
  const connectedCredentialName = instance.credentialName;
  const connectedAccountName = instance.credentialAccountName;
  const connectedExpiresAt = instance.credentialExpiresAt;
  const connectedScopes = instance.credentialScopes;
  const isTokenExpired = isExpiredDate(connectedExpiresAt ?? null);

  const status: 'connected' | 'inactive' = isConnected ? 'connected' : 'inactive';

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteConnectorAction(instance.id);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${instance.name} removed`);
      onClose();
    });
  }

  function performRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === instance.name) {
      setIsRenaming(false);
      return;
    }
    startTransition(async () => {
      const r = await renameConnectorAction(instance.id, trimmed);
      if (!r.ok) {
        toast.error(r.message);
      } else {
        toast.success('Renamed');
        setIsRenaming(false);
      }
    });
  }

  function performAssign(credentialId: string) {
    startTransition(async () => {
      const r = await assignCredentialAction(instance.id, credentialId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${instance.name} credential updated`);
      setSwitchOpen(false);
    });
  }

  function performRefresh() {
    if (!connectedCredentialId) return;
    startRefreshTransition(async () => {
      const r = await refreshCredentialAction(connectedCredentialId);
      if (!r.ok) {
        toast.error(r.message ?? 'Refresh failed');
      } else {
        toast.success('Token refreshed');
      }
    });
  }

  function performRotate() {
    const trimmed = newApiKey.trim();
    if (!trimmed) {
      toast.error('New API key is required');
      return;
    }
    startTransition(async () => {
      const r = await updateConnectorApiKeyAction(instance.id, trimmed);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${instance.name} key rotated`);
      setRotateOpen(false);
      setNewApiKey('');
    });
  }

  return (
    <div className="bg-paper border border-rule-2 rounded-xl p-5 space-y-4">
      {/* Header row — name + status ONLY. Action buttons used to live here
          too (UX-B6) and would wrap onto a second line that overlapped the
          status pill on anything narrower than the modal's max width; they
          now live in their own row in the body (below), well clear of it. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Instance name — inline rename */}
          {isRenaming ? (
            <div className="flex items-center gap-2">
              <TextInput
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') performRename();
                  if (e.key === 'Escape') {
                    setRenameValue(instance.name);
                    setIsRenaming(false);
                  }
                }}
                containerClassName="max-w-xs w-full"
              />
              <PrimaryButton variant="ink" size="sm" onClick={performRename} disabled={isPending}>
                Save
              </PrimaryButton>
              <PrimaryButton
                variant="neutral"
                size="sm"
                onClick={() => {
                  setRenameValue(instance.name);
                  setIsRenaming(false);
                }}
              >
                Cancel
              </PrimaryButton>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-ink truncate">{instance.name}</h3>
              <RowActionButton
                square
                onClick={() => setIsRenaming(true)}
                title="Rename"
                icon={<PencilSimple size={14} />}
              />
            </div>
          )}
        </div>
        <StatusPill
          variant={status === 'connected' ? 'done' : 'warn'}
          label={status === 'connected' ? 'Connected' : 'Needs auth'}
          className="shrink-0"
        />
      </div>

      {/* Labelled metadata — replaces the old unlabelled "gmail / oauth2 /
          account" stack (UX-B7: raw values with no context). */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-lg border border-rule-2 bg-hover/40 px-4 py-3">
        <MetaField label="Provider" value={catalogEntry.label} />
        <MetaField label="Auth method" value={instance.authType} mono />
        {connectedAccountName && <MetaField label="Account" value={connectedAccountName} />}
        {isOAuth && connectedCredentialName && (
          <MetaField label="Credential" value={connectedCredentialName} />
        )}
        {isApiKey && instance.hasApiKey && (
          <MetaField label="Credential" value={`…${instance.credentialId ?? '????'}`} mono />
        )}
      </dl>

      {catalogEntry.docsHint && <p className="text-xs text-ink-3">{catalogEntry.docsHint}</p>}

      {/* Contextual actions — a row of neutral PrimaryButtons in the body,
          not the header (UX-B7). Disconnect/Delete is NOT here: it's the
          destructive action, isolated in the modal's ModalFooter below. */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {isOAuth ? (
          <>
            {supportsRefresh && (
              <PrimaryButton
                variant="neutral"
                size="sm"
                onClick={performRefresh}
                disabled={isRefreshing || isPending}
              >
                {isRefreshing ? 'Refreshing…' : 'Refresh now'}
              </PrimaryButton>
            )}
            <PrimaryButton
              variant="neutral"
              size="sm"
              onClick={() => setWizardOpen(true)}
              disabled={isPending || isRefreshing}
            >
              Reconnect
            </PrimaryButton>
            {compatibleCredentials.length > 0 && (
              <PrimaryButton
                variant="neutral"
                size="sm"
                onClick={() => setSwitchOpen((v) => !v)}
                disabled={isPending || isRefreshing}
              >
                {switchOpen ? 'Cancel' : 'Switch credential'}
              </PrimaryButton>
            )}
          </>
        ) : (
          <PrimaryButton
            variant="neutral"
            size="sm"
            onClick={() => setRotateOpen((v) => !v)}
            disabled={isPending}
          >
            {rotateOpen ? 'Cancel' : 'Rotate key'}
          </PrimaryButton>
        )}
      </div>

      {/* Rotate API key panel — api_key connectors only.
          Existing assignments to agents are preserved because we update the
          row in place rather than delete + recreate. */}
      {isApiKey && rotateOpen && (
        <div className="space-y-3 pt-2 border-t border-rule-2">
          <div>
            <FieldLabel htmlFor={`rotate-${instance.id}`}>New API key</FieldLabel>
            <TextInput
              id={`rotate-${instance.id}`}
              type="password"
              autoComplete="off"
              autoFocus
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') performRotate();
                if (e.key === 'Escape') {
                  setNewApiKey('');
                  setRotateOpen(false);
                }
              }}
              placeholder="Paste the new key"
              className="font-mono"
            />
            <p className="text-body-12 text-ink-4 mt-1">
              Agent assignments stay intact - only the stored key changes.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <PrimaryButton
              variant="ink"
              size="sm"
              onClick={performRotate}
              disabled={isPending || !newApiKey.trim()}
            >
              {isPending ? 'Saving…' : 'Save new key'}
            </PrimaryButton>
            <PrimaryButton
              variant="neutral"
              size="sm"
              onClick={() => {
                setNewApiKey('');
                setRotateOpen(false);
              }}
            >
              Cancel
            </PrimaryButton>
          </div>
        </div>
      )}

      {/* Connected OAuth status panel */}
      {isOAuth && connectedCredentialId && (
        <div className="pt-2 border-t border-rule-2 space-y-2">
          {connectedCredentialName && (
            <p className="text-xs text-ink-3">
              Credential: <span className="text-ink font-medium">{connectedCredentialName}</span>
            </p>
          )}
          {connectedScopes && (
            <div className="flex flex-wrap gap-1">
              {connectedScopes.split(/\s+/).map((scope) => (
                <span
                  key={scope}
                  className="px-1.5 py-0.5 bg-hover text-ink-3 rounded text-mono-11"
                >
                  {scope}
                </span>
              ))}
            </div>
          )}
          {supportsRefresh && <p className="text-xs text-ink-3">Auto-refreshes when used</p>}
          {!supportsRefresh && connectedExpiresAt && (
            <p className={`text-xs ${isTokenExpired ? 'text-warn' : 'text-ink-3'}`}>
              {formatTokenExpiry(connectedExpiresAt)}
            </p>
          )}
        </div>
      )}

      {/* Switch credential panel */}
      {isOAuth && switchOpen && (
        <div className="space-y-3 pt-2 border-t border-rule-2">
          {compatibleCredentials.length > 0 ? (
            <>
              <div>
                <FieldLabel>Use credential</FieldLabel>
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
              <div className="flex gap-2 items-center pt-1">
                <PrimaryButton
                  variant="ink"
                  size="sm"
                  onClick={() => selectedCredentialId && performAssign(selectedCredentialId)}
                  disabled={isPending || !selectedCredentialId}
                >
                  {isPending ? 'Saving…' : 'Save'}
                </PrimaryButton>
                <PrimaryButton
                  variant="neutral"
                  size="sm"
                  onClick={() => {
                    setSwitchOpen(false);
                    setWizardOpen(true);
                  }}
                >
                  or create new
                </PrimaryButton>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-ink-3">
              No compatible credentials found.
              <PrimaryButton
                variant="neutral"
                size="sm"
                onClick={() => {
                  setSwitchOpen(false);
                  setWizardOpen(true);
                }}
              >
                Create one
              </PrimaryButton>
            </div>
          )}
        </div>
      )}

      {/* Delete / Disconnect confirmation */}
      <ConfirmDialog
        open={confirmOpen}
        title={`${isOAuth ? 'Disconnect' : 'Delete'} "${instance.name}"?`}
        message={
          isOAuth
            ? 'Tools that depend on this connector will fail until you reconnect. Existing job history is preserved.'
            : 'This connector instance will be permanently removed. Existing job history is preserved.'
        }
        confirmLabel={isOAuth ? 'Disconnect' : 'Delete'}
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />

      {/* Credential wizard modal */}
      {wizardOpen && credentialType && (
        <CredentialWizard
          initialType={credentialType}
          returnToConnectorSlug={catalogEntry.slug}
          onClose={() => setWizardOpen(false)}
        />
      )}

      {/* Modal footer — Disconnect/Delete isolated on the left (the wrapping
          Modal is non-dismissable, so Close is the only way out besides a
          successful delete above). Negative margins cancel this card's own
          p-5 so the separator + buttons run edge-to-edge like every other
          modal footer in the app. */}
      <ModalFooter
        className="-mx-5 -mb-5 mt-1 rounded-b-xl"
        danger={
          // `size` is irrelevant here — ModalFooter forces every button in a
          // footer to `md` (UX-DS Phase 1: this `size="sm"` used to render
          // smaller than the `Close` button on the right until that fix).
          <PrimaryButton
            variant="danger"
            onClick={() => setConfirmOpen(true)}
            disabled={isPending || isRefreshing}
          >
            {isOAuth ? 'Disconnect' : 'Delete'}
          </PrimaryButton>
        }
      >
        <PrimaryButton variant="neutral" onClick={onClose}>
          Close
        </PrimaryButton>
      </ModalFooter>
    </div>
  );
}
