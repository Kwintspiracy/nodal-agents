// Catalog — les activités, puis leurs scénarios : ce que chacun demande et ce qu'il exige.
import Link from 'next/link';
import { studioCatalog, duree } from '@nodal-agents/bench/studio';
import Banner from '@/components/ui/Banner';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import Table, {
  CellMono,
  CellMuted,
  CellText,
  CellTitle,
  THead,
  Td,
  Th,
  Tr,
} from '@/components/ui/Table';
import { assertStudioPage, studioRuntime } from '@/lib/bench-studio/server';
import NeedStatus from './_components/NeedStatus';
import StudioPage from './_components/StudioPage';

export const dynamic = 'force-dynamic';

export default async function CatalogPage() {
  await assertStudioPage();
  const catalog = studioCatalog();
  const needs = await studioRuntime().needs();
  const byActivity = catalog.activities
    .map((a) => ({ activity: a, scenarios: catalog.scenarios.filter((s) => s.activity === a) }))
    .filter((g) => g.scenarios.length > 0);
  return (
    <StudioPage
      title="Catalog"
      subtitle={`${catalog.scenarios.length} scenarios in ${byActivity.length} activities. Open one to read the exact request, what green means and how it is judged.`}
    >
      <div className="mb-6 flex flex-col gap-3">
        {needs.reachable ? (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-rule-2 bg-paper px-5 py-3">
            <span className="mr-1 text-medium-12 text-ink-4">Needs of the bench space now</span>
            {needs.needs.map((n) => (
              <NeedStatus key={n.need} needs={needs} need={n.need} />
            ))}
          </div>
        ) : (
          <Banner variant="warn" title="The bench space could not be read">
            {needs.why}. Needs show as unknown until it answers.
          </Banner>
        )}
        <div className="flex flex-wrap gap-1.5">
          {byActivity.map((g) => (
            <a
              key={g.activity}
              href={`#${g.activity}`}
              className="rounded-md border border-rule-2 bg-paper px-2.5 py-1 text-medium-12 text-ink-2 hover:bg-hover"
            >
              {g.activity} <span className="text-ink-4">{g.scenarios.length}</span>
            </a>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-8">
        {byActivity.map((g) => (
          <section key={g.activity} id={g.activity} className="scroll-mt-20">
            <h2 className="mb-2.5 text-title-16 text-ink">{g.activity}</h2>
            <Table>
              <THead>
                <Th>Scenario</Th>
                <Th className="hidden md:table-cell">Set</Th>
                <Th className="hidden md:table-cell">Sends</Th>
                <Th className="hidden sm:table-cell">Needs</Th>
                <Th align="right" className="hidden sm:table-cell">
                  Timeout
                </Th>
              </THead>
              <tbody>
                {g.scenarios.map((s) => (
                  <Tr key={s.id}>
                    <Td className="max-w-[17rem] sm:max-w-[28rem]">
                      <CellTitle
                        href={`/bench-studio/scenarios/${s.id}`}
                        title={s.title}
                        meta={`${s.id} · v${s.version}${s.unverified.length > 0 ? ` · ${s.unverified.length} not verified` : ''}`}
                        description={
                          s.needs.length > 0 && (
                            <span className="mt-1 flex flex-wrap gap-1 sm:hidden">
                              {s.needs.map((n) => (
                                <NeedStatus key={n} needs={needs} need={n} />
                              ))}
                            </span>
                          )
                        }
                      >
                        {s.title}
                      </CellTitle>
                    </Td>
                    <Td className="hidden md:table-cell">
                      <CellText>{s.set}</CellText>
                    </Td>
                    <Td className="hidden md:table-cell">
                      {s.sends === 'nothing' ? (
                        <CellMuted>nothing</CellMuted>
                      ) : (
                        <MonoMicroTag tone="warn">{s.sends}</MonoMicroTag>
                      )}
                    </Td>
                    <Td className="hidden sm:table-cell">
                      {s.needs.length === 0 ? (
                        <CellMuted>none</CellMuted>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {s.needs.map((n) => (
                            <NeedStatus key={n} needs={needs} need={n} />
                          ))}
                        </div>
                      )}
                    </Td>
                    <Td align="right" className="hidden sm:table-cell">
                      <CellMono>{duree(s.timeoutMs)}</CellMono>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </section>
        ))}
      </div>
      <p className="mt-8 text-body-12 text-ink-4">
        The catalog is read from the bench itself (packages/bench). To run a scenario, open the{' '}
        <Link href="/bench-studio/run" className="text-ink-2 underline-offset-2 hover:underline">
          Run
        </Link>{' '}
        screen.
      </p>
    </StudioPage>
  );
}
