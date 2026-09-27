'use client';

import { useState } from 'react';
import { PencilSimple } from '@phosphor-icons/react';
import type { McpServerInstance, McpCatalogItem } from '@/lib/actions.ts';
import ConnectorDisc from '../connectors/ConnectorDisc.tsx';
import MonoCode from '@/components/ui/MonoCode';
import Table, {
  THead,
  Th,
  Tr,
  Td,
  CellTitle,
  CellMono,
  CellMuted,
  CellActions,
} from '@/components/ui/Table';
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

  return (
    <>
      <Tr>
        <Td>
          <CellTitle
            lead={<ConnectorDisc slug={instance.slug} glyph={glyph} color={MCP_BLUE} />}
            meta={catalogLabel}
          >
            {instance.name}
          </CellTitle>
        </Td>

        <Td>
          {instance.toolCount === 0 ? (
            <CellMuted>none</CellMuted>
          ) : (
            <CellMono>{instance.toolCount}</CellMono>
          )}
        </Td>

        <Td>
          <MonoCode>{transport}</MonoCode>
        </Td>

        <Td>
          <StatusPill
            variant={instance.active ? 'done' : 'warn'}
            label={instance.active ? 'Connected' : 'Inactive'}
          />
        </Td>

        <Td align="right">
          <CellActions>
            <RowActionButton
              square
              icon={<PencilSimple size={16} />}
              title="Edit"
              onClick={() => setEditOpen(true)}
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
