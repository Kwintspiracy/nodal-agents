'use client';

import { useState } from 'react';
import { PencilSimple } from '@phosphor-icons/react';
import type { McpServerInstance, McpCatalogItem } from '@/lib/actions.ts';
import Disc from '@/components/ui/Disc';
import { connIcon, connEmoji } from '../connectors/connector-brand.ts';
import MonoCode from '@/components/ui/MonoCode';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
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
    <Table>
      <THead>
        <Th>Server</Th>
        <Th>Tools</Th>
        <Th>Transport</Th>
        <Th>Status</Th>
        <Th align="right">Actions</Th>
      </THead>
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
    </Table>
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
      <Tr>
        {/* Server */}
        <Td>
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
                <span className="font-mono text-micro-10 tracking-[0.04em]">{glyph}</span>
              )}
            </Disc>
            <div className="min-w-0">
              <div className="text-medium-13 leading-[1.2]! text-ink">{instance.name}</div>
              <div className="mt-0.5 text-mono-11 uppercase tracking-[0.12em] text-ink-4">
                {catalogLabel}
              </div>
            </div>
          </div>
        </Td>

        {/* Tools */}
        <Td>
          <span className="text-mono-13 text-ink-2">{instance.toolCount}</span>
          {instance.toolCount === 0 && <span className="ml-1 text-mono-11 text-ink-4">none</span>}
        </Td>

        {/* Transport */}
        <Td>
          <MonoCode>{transport}</MonoCode>
        </Td>

        {/* Status */}
        <Td>
          <StatusPill
            variant={instance.active ? 'done' : 'warn'}
            label={instance.active ? 'Connected' : 'Inactive'}
          />
        </Td>

        {/* Actions */}
        <Td>
          <div className="flex items-center justify-end gap-2">
            <RowActionButton
              square
              icon={<PencilSimple size={16} />}
              title="Edit"
              onClick={() => setEditOpen(true)}
            />
          </div>
        </Td>
      </Tr>

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
