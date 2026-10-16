// Results — la matrice activités × modèles, calculée par results.ts (le même code que le portail).
//
// L'état se lit d'abord en couleur (les coches des derniers essais, la barre
// empilée d'une activité, la barre de verts d'un modèle), les chiffres
// ensuite. Les comptes sont ceux de results.ts, sans autre règle.
import { Fragment } from 'react';
import { aideDeColonne, dollars, duree, studioResults } from '@nodal-agents/bench/studio';
import Banner from '@/components/ui/Banner';
import EmptyState from '@/components/ui/EmptyState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Table, { CellMono, CellMuted, CellTitle, THead, Td, Th, Tr } from '@/components/ui/Table';
import { assertStudioPage } from '@/lib/bench-studio/server';
import StudioPage from '../_components/StudioPage';
import { ColumnHead, StackBar, TickLegend, TrialTicks } from '../_components/Ticks';

export const dynamic = 'force-dynamic';

export default async function ResultsPage() {
  await assertStudioPage();
  const r = studioResults();
  const shown = r.activities.filter((a) => a.scenarios.some((s) => s.cells.length > 0));
  return (
    <StudioPage
      title="Results"
      subtitle={
        r.period
          ? `Trials from ${r.period.de} to ${r.period.a}. Each cell shows the last five trials of the current scenario version; time and cost are medians of the green ones.`
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
        <div className="flex flex-col gap-3">
          <TickLegend />
          <Table>
            <THead>
              <Th className="sm:min-w-56">Activity · scenario</Th>
              {r.summaries.map((s) => (
                <Th key={s.column}>
                  <ColumnHead
                    name={s.column}
                    help={aideDeColonne(s.column)}
                    green={s.verts}
                    tried={s.tentes}
                    skipped={s.sautes}
                    medianMs={s.dureeMs}
                    medianUsd={s.coutMedianUsd}
                    totalUsd={s.coutTotalUsd}
                    unknownCost={s.coutInconnu}
                  />
                </Th>
              ))}
            </THead>
            <tbody>
              {shown.map((a) => (
                <Fragment key={a.activity}>
                  <Tr hover={false} className="bg-canvas">
                    <Td>
                      <CellTitle meta={`${a.scenarios.length} scenario(s)`}>{a.activity}</CellTitle>
                    </Td>
                    {r.columns.map((c) => {
                      const s = a.summaries.find((x) => x.column === c);
                      return (
                        <Td key={c}>
                          {!s || s.tentes + s.sautes === 0 ? (
                            <CellMuted>no trial</CellMuted>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              <StackBar
                                green={s.verts}
                                notGreen={s.tentes - s.verts}
                                skipped={s.sautes}
                              />
                              <CellMono>
                                {s.verts}/{s.tentes} green
                                {s.sautes > 0 ? ` · ${s.sautes} skipped` : ''}
                              </CellMono>
                            </div>
                          )}
                        </Td>
                      );
                    })}
                  </Tr>
                  {a.scenarios
                    .filter((s) => s.cells.length > 0)
                    .map((s) => (
                      <Tr key={s.id}>
                        <Td className="max-w-[9.5rem] sm:max-w-[18rem]">
                          <CellTitle
                            href={`/bench-studio/scenarios/${s.id}`}
                            meta={`${s.id} · v${s.version ?? '?'}`}
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
                                <TrialTicks trials={[]} />
                              ) : (
                                <div className="flex flex-col gap-1">
                                  <TrialTicks trials={cell.last} />
                                  <CellMuted>
                                    {cell.tried === 0
                                      ? `${cell.skipped} skipped`
                                      : `${cell.green}/${cell.tried}${cell.green > 0 ? ` · ${duree(cell.medianMs)} · ${dollars(cell.medianUsd)}` : ''}`}
                                  </CellMuted>
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
        </div>
      )}
    </StudioPage>
  );
}
