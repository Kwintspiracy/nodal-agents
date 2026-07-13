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
import Disc from '@/components/ui/Disc';
import StatusPill from '@/components/ui/StatusPill';
import CountPill from '@/components/ui/CountPill';
import RowActionButton from '@/components/ui/RowActionButton';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Modal from '@/components/ui/Modal';
import ConnectorForm from './ConnectorForm.tsx';
import { CONN_BRAND_COLORS, connGlyph, connIcon } from './connector-brand.ts';

type Props = {
  instances: ConnectorRow[];
  credsByType: Record<string, CompatibleCredential[]>;
};

/**
 * ConnectorsInstalledTable — the design's `.conn-tbl` pattern.
 * One row per installed connector instance with:
 *   Provider (brand Disc + name + auth-type mono)
 *   Account (account name from credential)
 *   Scopes (compact count pill — hover for the full list; the raw OAuth scope
 *           URLs used to blow the table width out)
 *   Status (StatusPill done|warn)
 *   Actions (Edit → non-dismissable Modal with the full ConnectorForm, Delete)
 *
 * Edit used to expand an accordion row containing ConnectorForm — replaced
 * (UX-B6, user feedback: accordion-in-a-list is bad UX for editing) by a
 * proper Modal. The modal is non-dismissable: backdrop click and Esc don't
 * close it, only ConnectorForm's own explicit actions (or the Close button)
 * do, so a mid-edit click-away can't silently discard state.
 */
export default function ConnectorsInstalledTable({ instances, credsByType }: Props) {
  return (
    <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th label="Provider" />
              <Th label="Account" />
              <Th label="Scopes" />
              <Th label="Status" />
              <Th label="Actions" align="right" />
            </tr>
          </thead>
          <tbody>
            {instances.map((inst) => {
              const raw = CONNECTOR_CATALOG.find((c) => c.slug === inst.slug);
              // Normalise CatalogEntry (credentialType?: …) → ConnectorCatalogItem (credentialType: … | null)
              const catalogEntry: ConnectorCatalogItem = raw
                ? { ...raw, credentialType: raw.credentialType ?? null }
                : {
                    slug: inst.slug,
                    label: inst.name,
                    authType: inst.authType as ConnectorCatalogItem['authType'],
                    docsHint: '',
                    credentialType: inst.credentialType ?? null,
                  };
              const compatibleCredentials = catalogEntry.credentialType
                ? (credsByType[catalogEntry.credentialType] ?? [])
                : [];
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
        </table>
      </div>
    </div>
  );
}

function Th({ label, align = 'left' }: { label: string; align?: 'left' | 'right' }) {
  return (
    <th
      className={`border-b border-rule-2 px-[18px] pt-3.5 pb-2.5 font-mono text-[9.5px] font-normal whitespace-nowrap uppercase tracking-[0.16em] text-ink-4 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
      scope="col"
    >
      {label}
    </th>
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

  const brandColor = CONN_BRAND_COLORS[instance.slug];
  const glyph = connGlyph(instance.slug, catalogEntry.label);
  const iconSrc = connIcon(instance.slug);
  const isConnected = instance.active;
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
      <tr className="border-b border-rule-2 last:border-0 hover:bg-hover">
        {/* Provider */}
        <td className="px-[18px] py-[13px] align-middle">
          <div className="flex items-center gap-3">
            <Disc
              variant="conn"
              size="sm"
              shape="square"
              background={iconSrc ? '#ffffff' : brandColor}
            >
              {iconSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={iconSrc} alt="" className="h-4 w-4 object-contain" />
              ) : (
                <span className="font-mono text-[10px] font-semibold tracking-[0.04em]">
                  {glyph}
                </span>
              )}
            </Disc>
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium leading-[1.2] text-ink">
                {catalogEntry.label}
              </div>
              <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">
                {catalogEntry.authType}
              </div>
            </div>
          </div>
        </td>

        {/* Account */}
        <td className="px-[18px] py-[13px] align-middle">
          <span className="font-sans text-[13px] leading-[1.3] text-ink-2">
            {instance.credentialAccountName ?? instance.name}
          </span>
        </td>

        {/* Scopes */}
        <td className="px-[18px] py-[13px] align-middle">
          {scopeList.length > 0 ? (
            <CountPill items={scopeList} noun="scope" />
          ) : (
            <span className="font-mono text-[11px] text-ink-4">
              {instance.authType === 'api_key' ? 'api_key' : '—'}
            </span>
          )}
        </td>

        {/* Status */}
        <td className="px-[18px] py-[13px] align-middle">
          <StatusPill
            variant={isConnected ? 'done' : 'warn'}
            label={isConnected ? 'Connected' : 'Needs auth'}
          />
        </td>

        {/* Actions */}
        <td className="px-[18px] py-[13px] align-middle">
          <div className="flex items-center justify-end gap-2">
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
          </div>
        </td>
      </tr>

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
