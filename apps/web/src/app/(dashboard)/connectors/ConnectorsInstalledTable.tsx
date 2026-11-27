'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { PencilSimple, Trash } from '@phosphor-icons/react';
import {
  deleteConnectorAction,
  type ConnectorRow,
  type ConnectorCatalogItem,
} from '@/lib/actions.ts';
import type { CompatibleCredential } from './ConnectorForm.tsx';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog.ts';
import ConnectionStatusPill from '@/components/ConnectionStatusPill.tsx';
import CountPill from '@/components/ui/CountPill';
import Table, {
  THead,
  Th,
  Tr,
  Td,
  CellTitle,
  CellText,
  CellMuted,
  CellActions,
} from '@/components/ui/Table';
import RowActionButton from '@/components/ui/RowActionButton';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Modal from '@/components/ui/Modal';
import ConnectorForm from './ConnectorForm.tsx';
import { CONN_BRAND_COLORS, connGlyph } from './connector-brand.ts';
import ConnectorDisc from './ConnectorDisc.tsx';
import ReauthoriseButton from './ReauthoriseButton.tsx';

type Props = {
  instances: ConnectorRow[];
  credsBySlug: Record<string, CompatibleCredential[]>;
};

/**
 * ConnectorsInstalledTable — the design's `.conn-tbl` pattern.
 * One row per installed connector instance with:
 *   Provider (ConnectorDisc + name + auth-type meta line)
 *   Account (account name from credential)
 *   Scopes (compact count pill — hover for the full list; the raw OAuth scope
 *           URLs used to blow the table width out)
 *   Status (ConnectionStatusPill: the connection's state)
 *   Actions (Edit → non-dismissable Modal with the full ConnectorForm, Delete)
 *
 * Edit used to expand an accordion row containing ConnectorForm — replaced
 * (UX-B6, user feedback: accordion-in-a-list is bad UX for editing) by a
 * proper Modal. The modal is non-dismissable: backdrop click and Esc don't
 * close it, only ConnectorForm's own explicit actions (or the Close button)
 * do, so a mid-edit click-away can't silently discard state.
 */
export default function ConnectorsInstalledTable({ instances, credsBySlug }: Props) {
  return (
    <Table>
      <THead>
        <Th>Provider</Th>
        <Th>Account</Th>
        <Th>Scopes</Th>
        <Th>Status</Th>
        <Th align="right">Actions</Th>
      </THead>
      <tbody>
        {instances.map((inst) => {
          const raw = CONNECTOR_CATALOG.find((c) => c.slug === inst.slug);
          // Normalise CatalogEntry (credentialType?: …) → ConnectorCatalogItem (credentialType: … | null)
          const catalogEntry: ConnectorCatalogItem = raw
            ? {
                ...raw,
                credentialType: raw.credentialType ?? null,
                scopeDisclosure: raw.scopeDisclosure ?? null,
              }
            : {
                slug: inst.slug,
                label: inst.name,
                authType: inst.authType as ConnectorCatalogItem['authType'],
                docsHint: '',
                credentialType: inst.credentialType ?? null,
                scopeDisclosure: null,
              };
          const compatibleCredentials = credsBySlug[inst.slug] ?? [];
          return (
            <ConnectorRow
              key={inst.id}
              instance={inst}
              catalogEntry={catalogEntry}
              compatibleCredentials={compatibleCredentials}
            />
          );
        })}
      </tbody>
    </Table>
  );
}

function ConnectorRow({
  instance,
  catalogEntry,
  compatibleCredentials,
}: {
  instance: ConnectorRow;
  catalogEntry: ConnectorCatalogItem;
  compatibleCredentials: CompatibleCredential[];
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // The connection's state decides, as it does for a job's tools: the same
  // rows, the same rule (`connectorConnection`, `connectorAccessFor`).
  const missingAccess = instance.access?.kind === 'needs_access' ? instance.access : null;
  // A grant the provider ended is authorised again in place, on the same
  // credential: every connector and agent using it works again.
  const reconnectInPlace =
    instance.connection.state === 'needs_reauth' &&
    instance.connection.cause !== 'rights_missing' &&
    instance.connection.cause !== 'credential_removed' &&
    instance.credentialId !== null &&
    instance.credentialType !== null;
  const scopeList = instance.credentialScopes
    ? instance.credentialScopes.split(/\s+/).filter(Boolean)
    : [];

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteConnectorAction(instance.id);
      if (!r.ok) toast.error(r.message);
      else toast.success(`${instance.name} removed`);
    });
  }

  return (
    <>
      <Tr>
        <Td>
          <CellTitle
            lead={
              <ConnectorDisc
                slug={instance.slug}
                glyph={connGlyph(instance.slug, catalogEntry.label)}
                color={CONN_BRAND_COLORS[instance.slug]}
              />
            }
            meta={catalogEntry.authType}
          >
            {catalogEntry.label}
          </CellTitle>
        </Td>

        <Td>
          <CellText>{instance.credentialAccountName ?? instance.name}</CellText>
        </Td>

        <Td>
          {scopeList.length > 0 ? (
            <CountPill items={scopeList} noun="scope" />
          ) : (
            <CellMuted>{instance.authType === 'api_key' ? 'api_key' : 'none'}</CellMuted>
          )}
        </Td>

        <Td>
          <ConnectionStatusPill connection={instance.connection} />
        </Td>

        <Td align="right">
          <CellActions>
            {missingAccess && instance.credentialId && instance.credentialType && (
              <ReauthoriseButton
                label="Add access"
                credentialType={instance.credentialType}
                connector={instance.slug}
                credentialId={instance.credentialId}
                returnTo={`/connectors?connected=${instance.slug}`}
              />
            )}
            {reconnectInPlace && instance.credentialId && instance.credentialType && (
              <ReauthoriseButton
                label="Reconnect"
                credentialType={instance.credentialType}
                connector={instance.slug}
                credentialId={instance.credentialId}
                returnTo={`/connectors?connected=${instance.slug}`}
              />
            )}
            <RowActionButton
              square
              icon={<PencilSimple size={16} />}
              title="Edit"
              onClick={() => setEditOpen(true)}
            />
            <RowActionButton
              square
              icon={<Trash size={16} />}
              title={instance.authType === 'oauth2' ? 'Disconnect' : 'Delete'}
              tone="danger"
              disabled={isPending}
              onClick={() => setConfirmOpen(true)}
            />
          </CellActions>
        </Td>
      </Tr>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={instance.name}
        dismissable={false}
        className="max-w-xl"
      >
        <ConnectorForm
          instance={instance}
          catalogEntry={catalogEntry}
          compatibleCredentials={compatibleCredentials}
          onClose={() => setEditOpen(false)}
        />
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        title={`${instance.authType === 'oauth2' ? 'Disconnect' : 'Delete'} "${instance.name}"?`}
        message={
          instance.authType === 'oauth2'
            ? 'Tools that depend on this connector will fail until you reconnect. Existing job history is preserved.'
            : 'This connector instance will be permanently removed. Existing job history is preserved.'
        }
        confirmLabel={instance.authType === 'oauth2' ? 'Disconnect' : 'Delete'}
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
