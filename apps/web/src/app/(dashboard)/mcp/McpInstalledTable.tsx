'use client';

import { useState } from 'react';
import { GearSix } from '@phosphor-icons/react';
import type { McpServerInstance, McpCatalogItem } from '@/lib/actions.ts';
import Disc from '@/components/ui/Disc';
import { connIcon, connEmoji } from '../connectors/connector-brand.ts';
import MonoCode from '@/components/ui/MonoCode';
import StatusPill from '@/components/ui/StatusPill';
import RowActionButton from '@/components/ui/RowActionButton';
import McpServerRow from './McpServerRow.tsx';

const MCP_BLUE = '#3565ff';

type Props = {
  instances: McpServerInstance[];
  catalog: McpCatalogItem[];
};

/**
 * McpInstalledTable — the design's `.conn-tbl` pattern adapted for MCP servers.
 * Columns: Server, Tools discovered, Transport, Status, Actions.
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
      className={`border-b border-rule-2 px-[18px] pt-3.5 pb-2.5 font-mono text-[9.5px] font-normal whitespace-nowrap uppercase tracking-[0.16em] text-ink-4 ${
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
  const [expanded, setExpanded] = useState(false);
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
                <span className="text-[15px] leading-none">{emoji}</span>
              ) : (
                <span className="font-mono text-[10px] font-semibold tracking-[0.04em]">
                  {glyph}
                </span>
              )}
            </Disc>
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium leading-[1.2] text-ink">
                {instance.name}
              </div>
              <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">
                {catalogLabel}
              </div>
            </div>
          </div>
        </td>

        {/* Tools */}
        <td className="px-[18px] py-[13px] align-middle">
          <span className="font-mono text-[12.5px] text-ink-2">{instance.toolCount}</span>
          {instance.toolCount === 0 && (
            <span className="ml-1 font-mono text-[11px] text-ink-4">none</span>
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
            <RowActionButton icon={<GearSix size={13} />} onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Close' : 'Configure'}
            </RowActionButton>
          </div>
        </td>
      </tr>

      {/* Expanded McpServerRow panel */}
      {expanded && (
        <tr className="border-b border-rule-2 last:border-0 bg-hover/40">
          <td colSpan={5} className="px-[18px] py-3">
            <McpServerRow
              instance={instance}
              catalogLabel={catalogLabel}
              description={description}
            />
          </td>
        </tr>
      )}
    </>
  );
}
