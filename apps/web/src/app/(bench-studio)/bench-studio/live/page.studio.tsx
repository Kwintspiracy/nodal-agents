// Live — les lancements de cette session de Bench Studio, le plus récent d'abord.
import Link from 'next/link';
import EmptyState from '@/components/ui/EmptyState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import StatusPill from '@/components/ui/StatusPill';
import Table, { CellMono, CellText, CellTitle, THead, Td, Th, Tr } from '@/components/ui/Table';
import { assertStudioPage, studioRuntime } from '@/lib/bench-studio/server';
import StudioPage from '../_components/StudioPage';

export const dynamic = 'force-dynamic';

function describe(sel: Record<string, unknown>): string {
  return Object.entries(sel)
    .filter(([, v]) => Array.isArray(v) || typeof v === 'string')
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ');
}

export default async function LivePage() {
  await assertStudioPage();
  const runs = studioRuntime().manager.list();
  return (
    <StudioPage
      title="Live"
      subtitle="The runs launched from this Bench Studio session. Each one plays its trials one after the other."
    >
      {runs.length === 0 ? (
        <EmptyState
          title="No run yet"
          description="Launched runs appear here, trial by trial, while they play."
          action={<PrimaryButton href="/bench-studio/run">Open Run</PrimaryButton>}
        />
      ) : (
        <Table>
          <THead>
            <Th>Run</Th>
            <Th className="hidden md:table-cell">Selection</Th>
            <Th>State</Th>
            <Th align="right">Trials done</Th>
          </THead>
          <tbody>
            {runs.map((r) => {
              const ends = r.events.filter((e) => e.type === 'trial-end').length;
              const start = r.events.find((e) => e.type === 'trial-start');
              const total = start && start.type === 'trial-start' ? start.total : null;
              const failed = r.events.some((e) => e.type === 'error');
              return (
                <Tr key={r.id}>
                  <Td>
                    <CellTitle
                      href={`/bench-studio/live/${r.id}`}
                      meta={new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 19)}
                    >
                      {r.id}
                    </CellTitle>
                  </Td>
                  <Td className="hidden md:table-cell">
                    <CellText>{describe(r.request.selection as Record<string, unknown>)}</CellText>
                  </Td>
                  <Td>
                    {!r.finished ? (
                      <StatusPill variant="run" />
                    ) : failed ? (
                      <StatusPill variant="lvl-err" label="Stopped" />
                    ) : (
                      <StatusPill variant="done" label="Finished" />
                    )}
                  </Td>
                  <Td align="right">
                    <CellMono>
                      {ends}
                      {total !== null ? ` / ${total}` : ''}
                    </CellMono>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <p className="mt-6 text-body-12 text-ink-4">
        Runs live in this Bench Studio process: stopping it forgets the list, never the results,
        which are in{' '}
        <Link href="/bench-studio/results" className="text-ink-2 hover:underline">
          Results
        </Link>
        .
      </p>
    </StudioPage>
  );
}
