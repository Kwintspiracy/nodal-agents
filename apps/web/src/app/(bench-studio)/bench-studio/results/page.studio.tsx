// Results — la matrice activités × modèles, calculée par results.ts (le même code que le portail).
import { Fragment } from 'react';
import Link from 'next/link';
import { aideDeColonne, dollars, duree, studioResults } from '@nodal-agents/bench/studio';
import Banner from '@/components/ui/Banner';
import EmptyState from '@/components/ui/EmptyState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Table, { CellMono, CellMuted, CellTitle, THead, Td, Th, Tr } from '@/components/ui/Table';
import { assertStudioPage } from '@/lib/bench-studio/server';
import StudioPage from '../_components/StudioPage';
import { greenRate } from '../_components/format';

export const dynamic = 'force-dynamic';

const DOT: Record<string, string> = {
  green: 'bg-ok',
  red: 'bg-err',
  skipped: 'bg-ink-4',
};

interface Summary {
  tentes: number;
  verts: number;
  dureeMs: number | null;
  coutMedianUsd: number | null;
}

function SummaryCell({ s }: { s: Summary | undefined }) {
  if (!s || s.tentes === 0) return <CellMuted>no trial</CellMuted>;
  return (
    <div className="flex flex-col gap-0.5">
      <CellMono>
        {greenRate(s.verts, s.tentes)} · {s.verts}/{s.tentes}
      </CellMono>
      <CellMuted>
        {s.verts > 0 ? `${duree(s.dureeMs)} · ${dollars(s.coutMedianUsd)}` : 'no green trial'}
      </CellMuted>
    </div>
  );
}

export default async function ResultsPage() {
  await assertStudioPage();
  const r = studioResults();
  const shown = r.activities.filter((a) => a.scenarios.some((s) => s.cells.length > 0));
  return (
    <StudioPage
      title="Results"
      subtitle={
        r.period
          ? `Trials from ${r.period.de} to ${r.period.a}. Each cell counts the last five trials of the current scenario version; time and cost are medians of the green ones.`
          : 'No trial recorded yet.'
      }
    >
      {r.unreadable > 0 && (
        <Banner variant="warn" className="mb-5">
          {r.unreadable} line(s) of workflows.ndjson could not be read and are left out.
        </Banner>
      )}
      {r.columns.length === 0 ? (
        <EmptyState
          title="No result yet"
          description="Every trial adds one line to apps/qa/data/workflows.ndjson; its results show here."
          action={<PrimaryButton href="/bench-studio/run">Open Run</PrimaryButton>}
        />
      ) : (
        <div className="flex flex-col gap-8">
          <section>
            <h2 className="mb-2.5 text-title-16 text-ink">By model</h2>
            <Table>
              <THead>
                <Th>Model</Th>
                <Th align="right">Green</Th>
                <Th align="right" className="hidden sm:table-cell">
                  Median time
                </Th>
                <Th align="right" className="hidden sm:table-cell">
                  Median cost
                </Th>
                <Th align="right" className="hidden md:table-cell">
                  Total cost
                </Th>
              </THead>
              <tbody>
                {r.summaries.map((s) => (
                  <Tr key={s.column}>
                    <Td>
                      <CellTitle
                        title={aideDeColonne(s.column) ?? undefined}
                        meta={`${s.tentes} trial(s)${s.sautes > 0 ? ` · ${s.sautes} skipped` : ''}`}
                      >
                        {s.column}
                      </CellTitle>
                    </Td>
                    <Td align="right">
                      <CellMono>
                        {greenRate(s.verts, s.tentes)} · {s.verts}/{s.tentes}
                      </CellMono>
                    </Td>
                    <Td align="right" className="hidden sm:table-cell">
                      <CellMono>{duree(s.dureeMs)}</CellMono>
                    </Td>
                    <Td align="right" className="hidden sm:table-cell">
                      <CellMono>{dollars(s.coutMedianUsd)}</CellMono>
                    </Td>
                    <Td align="right" className="hidden md:table-cell">
                      <CellMono>
                        {dollars(s.coutTotalUsd)}
                        {s.coutInconnu > 0 ? ` + ${s.coutInconnu} unknown` : ''}
                      </CellMono>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </section>

          <section>
            <h2 className="mb-2.5 text-title-16 text-ink">Activity × model</h2>
            <Table>
              <THead>
                <Th>Activity · scenario</Th>
                {r.columns.map((c) => (
                  <Th key={c}>
                    <span title={aideDeColonne(c) ?? undefined}>{c}</span>
                  </Th>
                ))}
              </THead>
              <tbody>
                {shown.map((a) => (
                  <Fragment key={a.activity}>
                    <Tr hover={false} className="bg-canvas">
                      <Td>
                        <CellTitle meta={`${a.scenarios.length} scenario(s)`}>
                          {a.activity}
                        </CellTitle>
                      </Td>
                      {r.columns.map((c) => (
                        <Td key={c}>
                          <SummaryCell s={a.summaries.find((x) => x.column === c)} />
                        </Td>
                      ))}
                    </Tr>
                    {a.scenarios
                      .filter((s) => s.cells.length > 0)
                      .map((s) => (
                        <Tr key={s.id}>
                          <Td className="max-w-[18rem]">
                            <CellTitle
                              href={s.closed ? undefined : `/bench-studio/scenarios/${s.id}`}
                              meta={`${s.id} · v${s.version ?? '?'}${
                                s.closed
                                  ? s.closed.renommeEn
                                    ? ` · closed series, renamed ${s.closed.renommeEn}`
                                    : ' · closed series, retired'
                                  : ''
                              }`}
                              title={s.title}
                            >
                              {s.title}
                            </CellTitle>
                          </Td>
                          {r.columns.map((c) => {
                            const cell = s.cells.find((x) => x.column === c);
                            return (
                              <Td key={c}>
                                {!cell ? (
                                  <CellMuted>·</CellMuted>
                                ) : (
                                  <div className="flex flex-col gap-1">
                                    <SummaryCell
                                      s={{
                                        tentes: cell.tried,
                                        verts: cell.green,
                                        dureeMs: cell.medianMs,
                                        coutMedianUsd: cell.medianUsd,
                                      }}
                                    />
                                    <div className="flex gap-1">
                                      {cell.last.map((l, i) =>
                                        l.n === null ? null : (
                                          <Link
                                            key={`${l.n}-${i}`}
                                            href={`/bench-studio/results/${l.n}`}
                                            title={`${l.verdict} · ${l.startedAt ?? 'no date'}`}
                                            aria-label={`Trial on line ${l.n}: ${l.verdict}`}
                                            className={`block h-2.5 w-2.5 rounded-full ${DOT[l.verdict] ?? 'bg-warn'}`}
                                          />
                                        ),
                                      )}
                                    </div>
                                  </div>
                                )}
                              </Td>
                            );
                          })}
                        </Tr>
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </Table>
          </section>
        </div>
      )}
    </StudioPage>
  );
}
