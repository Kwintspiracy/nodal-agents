'use client';

import { useState } from 'react';
import { PencilSimple } from '@phosphor-icons/react';
import type { McpServerInstance, McpCatalogItem } from '@/lib/actions.ts';
import Disc from '@/components/ui/Disc';
import { connIcon, connEmoji } from '../connectors/connector-brand.ts';
import MonoCode from '@/components/ui/MonoCode';
import StatusPill from '@/components/ui/StatusPill';
import RowActionButton from '@/components/ui/RowActionButton';
import Modal from '@/components/ui/Modal';
import McpServerRow from './McpServerRow.tsx';

const MCP_BLUE = '#3565ff';

type Props = {
  instances: McpServerInstance[];
  catalog: McpCatalogItem[];
};

/**
 * McpInstalledTable — the design's `.conn-tbl` pattern adapted for MCP servers.
 * Columns: Server, Tools discovered, Transport, Status, Actions.
 *
 * Edit → non-dismissable Modal with the full edit surface (McpServerRow).
 * No more row accordion (UX-B6): the old accordion nested a SECOND "Edit
 * config" accordion inside it, the exact double-Edit pattern flagged as bad
 * UX. The modal closes only via its own Save/Cancel/Disconnect actions.
 */
export default function McpInstalledTable({ instances, catalog }: Props) {
  return (
    <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th label="Server" />
              <Th label="Tools" />
              <Th label="Transport" />
              <Th label="Status" />
              <Th label="Actions" align="right" />
            </tr>
          </thead>
          <tbody>
            {instances.map((inst) => {
              const catalogItem = catalog.find((c) => c.slug === inst.slug);
              return (
                <McpRow
                  key={inst.id}
                  instance={inst}
                  catalogLabel={catalogItem?.label ?? inst.name}
                  description={catalogItem?.description ?? ''}
                  transport={catalogItem?.transport ?? 'http'}
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
      className={`border-b border-rule-2 px-[18px] pt-3.5 pb-2.5 font-mono text-legacy-9-5 font-normal whitespace-nowrap uppercase tracking-[0.16em] text-ink-4 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
      scope="col"
    >
      {label}
    </th>
  );
}

function McpRow({
  instance,
  catalogLabel,
  description,
  transport,
}: {
  instance: McpServerInstance;
  catalogLabel: string;
  description: string;
  transport: 'http' | 'stdio';
}) {
  const [editOpen, setEditOpen] = useState(false);
  const glyph = catalogLabel.slice(0, 2).toUpperCase();
  const iconSrc = connIcon(instance.slug);
  const emoji = connEmoji(instance.slug);

  return (
    <>
      <tr className="border-b border-rule-2 last:border-0 hover:bg-hover">
        {/* Server */}
        <td className="px-[18px] py-[13px] align-middle">
          <div className="flex items-center gap-3">
            <Disc
              variant="conn"
              size="sm"
              shape="square"
              background={iconSrc || emoji ? '#ffffff' : MCP_BLUE}
            >
              {iconSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={iconSrc} alt="" className="h-4 w-4 object-contain" />
              ) : emoji ? (
                <span className="text-body-15 leading-none!">{emoji}</span>
              ) : (
                <span className="font-mono text-micro-10 tracking-[0.04em]">
                  {glyph}
                </span>
              )}
            </Disc>
            <div className="min-w-0">
              <div className="text-legacy-13-5 font-medium leading-[1.2]! text-ink">
                {instance.name}
              </div>
              <div className="mt-0.5 font-mono text-legacy-10-5 uppercase tracking-[0.12em] text-ink-4">
                {catalogLabel}
              </div>
            </div>
          </div>
        </td>

        {/* Tools */}
        <td className="px-[18px] py-[13px] align-middle">
          <span className="font-mono text-legacy-12-5 text-ink-2">{instance.toolCount}</span>
          {instance.toolCount === 0 && (
            <span className="ml-1 text-mono-11 text-ink-4">none</span>
          )}
        </td>

        {/* Transport */}
        <td className="px-[18px] py-[13px] align-middle">
          <MonoCode>{transport}</MonoCode>
        </td>

        {/* Status */}
        <td className="px-[18px] py-[13px] align-middle">
          <StatusPill
            variant={instance.active ? 'done' : 'warn'}
            label={instance.active ? 'Connected' : 'Inactive'}
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
        <McpServerRow
          instance={instance}
          catalogLabel={catalogLabel}
          description={description}
          onClose={() => setEditOpen(false)}
        />
      </Modal>
    </>
  );
}
