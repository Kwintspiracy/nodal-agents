'use client';

/**
 * SettingsList — UNE liste de réglages, et un panneau ancré à droite (S3 + P1,
 * #231).
 *
 * Ce qui change par rapport à l'empilement de onze blocs : rien ne se modifie
 * SUR la page. Une ligne montre son nom et sa valeur courante ; cliquer dessus
 * ouvre SON réglage dans le panneau, où vivent le formulaire existant et son
 * Save. La ligne ouverte reste surlignée, la liste reste cliquable — le
 * panneau pousse la page, il ne la couvre pas.
 *
 * L'interrupteur de deux lignes est une IMAGE de l'état (`Switch readOnly`),
 * jamais un geste : le geste, avec sa confirmation, est dans le panneau.
 *
 * L'URL porte le réglage ouvert (`/settings?open=network`) pour qu'un lien
 * direct ouvre le panneau. La page serveur lit `?open` au premier rendu ; les
 * clics suivants réécrivent l'URL sans repasser par le serveur, sinon chaque
 * ligne cliquée rechargerait les onze lectures.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Browser,
  Checks,
  Clock,
  EyeSlash,
  IdentificationCard,
  Key,
  LinkSimple,
  ListBullets,
  Pause,
  PlugsConnected,
  ShieldCheck,
  UsersThree,
  WifiHigh,
  type Icon,
} from '@phosphor-icons/react';
import DockedPanel from '@/components/ui/DockedPanel';
import DisclosureButton from '@/components/ui/DisclosureButton';
import PageSearchInput from '@/components/ui/PageSearchInput';
import SetListRow from '@/components/ui/SetListRow';
import Switch from '@/components/ui/Switch';
import { TagMini } from '@/components/ui/TagMini.tsx';
import {
  filterSettingRows,
  type SettingGroup,
  type SettingId,
  type SettingRow,
} from './settings-rows.ts';

const ICONS: Record<SettingId, Icon> = {
  'sign-in': Key,
  network: WifiHigh,
  password: EyeSlash,
  'worker-secret': ShieldCheck,
  'auto-run-brake': Pause,
  verification: Checks,
  'root-agent': UsersThree,
  'mcp-server': PlugsConnected,
  timezone: Clock,
  'install-notes': ListBullets,
  workspaces: Browser,
  urls: LinkSimple,
  session: IdentificationCard,
};

const GROUPS: ReadonlyArray<{ key: Exclude<SettingGroup, 'advanced'>; label: string }> = [
  { key: 'access', label: 'Access' },
  { key: 'safety', label: 'Safety' },
  { key: 'workspace', label: 'Workspace' },
];

type Props = {
  rows: SettingRow[];
  /** Le contenu du panneau, par réglage — les formulaires existants, tels quels. */
  panels: Partial<Record<SettingId, ReactNode>>;
  /** Le réglage porté par l'URL au premier rendu, ou null. */
  initialOpen: SettingId | null;
};

export default function SettingsList({ rows, panels, initialOpen }: Props) {
  const [query, setQuery] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [open, setOpen] = useState<SettingId | null>(initialOpen);

  const visible = useMemo(() => filterSettingRows(rows, query), [rows, query]);
  const filtering = query.trim() !== '';
  const advancedRows = visible.filter((r) => r.group === 'advanced');
  const advancedTotal = rows.filter((r) => r.group === 'advanced').length;
  // Un filtre qui ne trouve que des lignes repliées ne trouverait rien : quand
  // il tape, le repli s'ouvre de lui-même sur ce qui correspond.
  const advancedExpanded = advancedOpen || (filtering && advancedRows.length > 0);

  // L'URL suit le panneau, sans repasser par le serveur.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (open === null) url.searchParams.delete('open');
    else url.searchParams.set('open', open);
    window.history.replaceState(null, '', url.toString());
  }, [open]);

  const openRow = open === null ? null : (rows.find((r) => r.id === open) ?? null);
  const panel = openRow === null ? null : (panels[openRow.id] ?? null);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-5 pt-6 pb-10 sm:px-8 lg:px-9">
        <div className="flex max-w-3xl flex-col gap-4">
          <PageSearchInput
            value={query}
            onChange={setQuery}
            placeholder="Filter settings: network, brake, timezone"
            ariaLabel="Filter settings"
            testId="settings-filter"
            minWidth={0}
            className="w-full"
          />

          {GROUPS.map(({ key, label }) => {
            const groupRows = visible.filter((r) => r.group === key);
            if (groupRows.length === 0) return null;
            return (
              <section key={key} className="flex flex-col gap-1.5">
                <h2 className="text-mono-11-caps text-ink-4">{label}</h2>
                <div className="overflow-hidden rounded-lg border border-rule-2 bg-paper">
                  {groupRows.map((row) => (
                    <ListRow
                      key={row.id}
                      row={row}
                      selected={row.id === open}
                      onOpen={() => setOpen(row.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {advancedTotal > 0 && (
            <div className="overflow-hidden rounded-lg border border-rule-2 bg-paper">
              <DisclosureButton
                open={advancedExpanded}
                onClick={() => setAdvancedOpen((v) => !v)}
                testId="settings-advanced-toggle"
              >
                <span className="shrink-0 text-medium-14 text-ink">Advanced</span>
                <span className="min-w-0 flex-1 truncate text-body-13 text-ink-3">
                  URLs, session IDs. Read only.
                </span>
                <span className="shrink-0 text-mono-11 text-ink-4">{advancedTotal}</span>
              </DisclosureButton>
              {advancedExpanded &&
                advancedRows.map((row) => (
                  <div key={row.id} className="border-t border-rule-2">
                    <ListRow row={row} selected={row.id === open} onOpen={() => setOpen(row.id)} />
                  </div>
                ))}
            </div>
          )}

          {visible.length === 0 && (
            <p className="text-body-14 text-ink-3" data-testid="settings-no-match">
              No setting matches {query.trim()}.
            </p>
          )}
        </div>
      </div>

      <DockedPanel
        open={openRow !== null}
        onClose={() => setOpen(null)}
        title={openRow?.name ?? ''}
        testId="settings-panel"
      >
        {openRow !== null && <p className="text-body-13 text-ink-3">{openRow.lede}</p>}
        {panel}
      </DockedPanel>
    </div>
  );
}

function ListRow({
  row,
  selected,
  onOpen,
}: {
  row: SettingRow;
  selected: boolean;
  onOpen: () => void;
}) {
  const Glyph = ICONS[row.id];
  return (
    <SetListRow
      icon={<Glyph size={16} />}
      name={row.name}
      value={row.value}
      selected={selected}
      onClick={onOpen}
      testId={`setting-row-${row.id}`}
      trailing={
        <>
          {row.toggle !== undefined && (
            <Switch
              readOnly
              checked={row.toggle}
              onChange={() => {}}
              size="sm"
              trackClassName={
                row.toggle ? 'border-agent/40 bg-agent/20' : 'border-rule-2 bg-canvas'
              }
              thumbClassName={
                row.toggle ? 'translate-x-[18px] bg-agent' : 'translate-x-[2px] bg-ink-3'
              }
            />
          )}
          {row.tag && <TagMini variant={row.tag.variant}>{row.tag.label}</TagMini>}
        </>
      }
    />
  );
}
