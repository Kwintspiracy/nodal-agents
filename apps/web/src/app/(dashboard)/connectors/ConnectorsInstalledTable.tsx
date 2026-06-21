'use client';

import { useState } from 'react';
import type { ConnectorRow, ConnectorCatalogItem } from '@/lib/actions.ts';
import type { CompatibleCredential } from './ConnectorForm.tsx';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog.ts';
import Disc from '@/components/ui/Disc';
import MonoCode from '@/components/ui/MonoCode';
import StatusPill from '@/components/ui/StatusPill';
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
 *   Scopes (MonoCode chips, truncated past 4)
 *   Status (StatusPill done|warn)
 *   Actions (Configure link + ⋯ expand → ConnectorForm)
 */
export default function ConnectorsInstalledTable({ instances, credsByType }: Props) {
  return (
    <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
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
  const [expanded, setExpanded] = useState(false);

  const brandColor = CONN_BRAND_COLORS[instance.slug];
  const glyph = connGlyph(instance.slug, catalogEntry.label);
  const iconSrc = connIcon(instance.slug);
  const isConnected = instance.active;
  const scopeList = instance.credentialScopes
    ? instance.credentialScopes.split(/\s+/).filter(Boolean)
    : [];

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
            <div className="flex flex-wrap items-center gap-1.5">
              {scopeList.slice(0, 4).map((s) => (
                <MonoCode key={s}>{s}</MonoCode>
              ))}
              {scopeList.length > 4 && (
                <span className="font-mono text-[11px] text-ink-4">+{scopeList.length - 4}</span>
              )}
            </div>
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
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-[7px] border border-rule bg-paper px-3 text-[12px] font-medium leading-none text-ink-2 transition-colors hover:bg-hover hover:text-ink"
            >
              {expanded ? 'Close' : 'Configure'}
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded ConnectorForm panel */}
      {expanded && (
        <tr className="border-b border-rule-2 last:border-0 bg-hover/40">
          <td colSpan={5} className="px-[18px] py-3">
            <ConnectorForm
              instance={instance}
              catalogEntry={catalogEntry}
              compatibleCredentials={compatibleCredentials}
            />
          </td>
        </tr>
      )}
    </>
  );
}
