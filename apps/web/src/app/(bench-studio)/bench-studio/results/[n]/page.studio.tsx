// Un essai, par son numéro de ligne dans workflows.ndjson : verdict, réponse, livrables, coûts, modèles.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { dollars, duree, nombreJetons, stackWebUrl, studioTrial } from '@nodal-agents/bench/studio';
import Banner from '@/components/ui/Banner';
import CodeBlock from '@/components/ui/CodeBlock';
import MetricCard from '@/components/ui/MetricCard';
import PrimaryButton from '@/components/ui/PrimaryButton';
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
import { assertStudioPage } from '@/lib/bench-studio/server';
import StudioPage, { Fact, Panel } from '../../_components/StudioPage';
import VerdictPill from '../../_components/VerdictPill';
import { bytes, when } from '../../_components/format';

export const dynamic = 'force-dynamic';

interface ModelUseRow {
  job: string;
  agent: string | null;
  via: string;
  requested: string | null;
  effective: string;
  provider: string | null;
  reasoningEffort: string | null;
  failover: boolean | null;
  calls: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export default async function TrialPage({ params }: { params: Promise<{ n: string }> }) {
  await assertStudioPage();
  const n = Number((await params).n);
  let trial: ReturnType<typeof studioTrial>;
  try {
    trial = studioTrial(n);
  } catch {
    notFound();
  }
  const l = trial.line;
  const reasons = list<string>(l['reasons']);
  const unverified = list<{ check: string; reason: string; ticket: string }>(l['unverified']);
  const deliverables = list<{ path: string; bytes: number }>(l['deliverables']);
  const modelUse = list<ModelUseRow>(l['modelUse']);
  const answer = str(l['answer']);
  const rootJobId = str(l['rootJobId']);

  return (
    <StudioPage
      title={str(l.title) ?? l.scenario}
      subtitle={`Trial on line ${n} of workflows.ndjson · ${l.scenario} v${l.scenarioVersion ?? '?'} · ${when(l.startedAt)}`}
      actions={
        <>
          <Link
            href={`/bench-studio/scenarios/${l.scenario}`}
            className="text-medium-13 text-ink-3 hover:text-ink"
          >
            Scenario
          </Link>
          {rootJobId && (
            <PrimaryButton href={`${stackWebUrl()}/runs/${rootJobId}`} variant="neutral" size="sm">
              Open in Nodal
            </PrimaryButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Panel title="Verdict" aside={<VerdictPill verdict={l.verdict} />}>
          {reasons.length === 0 ? (
            <p className="text-body-14 text-ink">
              {l.verdict === 'green'
                ? `Green: ${str(l.green) ?? 'every check passed.'}`
                : 'No reason recorded.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {reasons.map((r) => (
                <li key={r} className="text-body-13 text-ink-2">
                  · {r}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {unverified.length > 0 && (
          <Banner variant="warn" title="Not verified in this trial">
            <ul className="flex flex-col gap-1.5">
              {unverified.map((u) => (
                <li key={u.check}>
                  <span className="text-medium-13">{u.check}</span> ({u.ticket}): {u.reason}
                </li>
              ))}
            </ul>
          </Banner>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard
            label="Duration"
            value={duree(l.durationMs)}
            subtle={`first reply ${duree(l['firstModelReplyMs'])}`}
          />
          <MetricCard
            label="Cost"
            value={dollars(l.costUsd)}
            subtle={`${l['llmCalls'] ?? 0} API call(s) · ${l['cliRuns'] ?? 0} CLI run(s)`}
          />
          <MetricCard
            label="Tokens in"
            value={nombreJetons(l.inputTokens)}
            subtle={`cached ${nombreJetons(l['cachedTokens'])}`}
          />
          <MetricCard
            label="Tokens out"
            value={nombreJetons(l.outputTokens)}
            subtle={`${l['toolCalls'] ?? 0} tool call(s)`}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-5">
            <Panel title="Answer">
              {answer === null ? (
                <p className="text-body-13 text-ink-4">The root job left no answer.</p>
              ) : (
                <CodeBlock code={answer} lang="text" lineNumbers={false} className="" />
              )}
            </Panel>
            <Panel title="Deliverables">
              {deliverables.length === 0 ? (
                <p className="text-body-13 text-ink-4">
                  The trial left no file under nodal-bench/.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {deliverables.map((d) => (
                    <li key={d.path} className="flex items-center justify-between gap-3">
                      <Link
                        href={`/bench-studio/deliverable?path=${encodeURIComponent(d.path)}`}
                        className="truncate text-mono-12 text-ink hover:underline"
                      >
                        {d.path}
                      </Link>
                      <span className="shrink-0 text-mono-11 text-ink-4">{bytes(d.bytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
          <Panel title="Facts">
            <div className="-my-2 divide-y divide-rule-2">
              <Fact label="Model column">{trial.column}</Fact>
              <Fact label="Model under test">
                {str(l.modelUnderTest) ?? 'none (agents on their own)'}
              </Fact>
              <Fact label="Root model">{str(l.rootModel) ?? 'not recorded'}</Fact>
              <Fact label="Nodal-Agents">
                {str(l.nodalVersion) ?? '?'} @{' '}
                {str(l['stackCommit'])?.slice(0, 8) ?? 'unknown commit'}
              </Fact>
              <Fact label="Trigger">{str(l['trigger']) ?? '?'}</Fact>
              <Fact label="Jobs">{String(l['jobs'] ?? '?')}</Fact>
              <Fact label="Approvals">{String(l['approvals'] ?? 0)}</Fact>
              <Fact label="Cancelled by the bench">{l['cancelled'] === true ? 'yes' : 'no'}</Fact>
            </div>
          </Panel>
        </div>

        <section>
          <h2 className="mb-2.5 text-title-16 text-ink">Models per job, requested and effective</h2>
          {modelUse.length === 0 ? (
            <p className="text-body-13 text-ink-4">No model call recorded for this trial.</p>
          ) : (
            <Table>
              <THead>
                <Th>Job</Th>
                <Th>Requested → effective</Th>
                <Th align="right" className="hidden md:table-cell">
                  Calls
                </Th>
                <Th align="right" className="hidden sm:table-cell">
                  Tokens in / out
                </Th>
                <Th align="right">Cost</Th>
              </THead>
              <tbody>
                {modelUse.map((m, i) => (
                  <Tr key={`${m.job}-${i}`}>
                    <Td>
                      <CellTitle
                        meta={`${m.job} · ${m.via}${m.provider ? ` · ${m.provider}` : ''}`}
                      >
                        {m.agent ?? 'unknown agent'}
                      </CellTitle>
                    </Td>
                    <Td>
                      <CellText
                        meta={
                          [
                            m.requested !== null && m.requested !== m.effective
                              ? 'differs from the request'
                              : null,
                            m.failover === true ? 'served by a fallback' : null,
                            m.reasoningEffort ? `effort ${m.reasoningEffort}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || undefined
                        }
                      >
                        {m.requested ?? 'not recorded'} → {m.effective}
                      </CellText>
                    </Td>
                    <Td align="right" className="hidden md:table-cell">
                      <CellMono>{m.calls}</CellMono>
                    </Td>
                    <Td align="right" className="hidden sm:table-cell">
                      <CellMono>
                        {nombreJetons(m.inputTokens)} / {nombreJetons(m.outputTokens)}
                      </CellMono>
                    </Td>
                    <Td align="right">
                      {m.costUsd === null ? (
                        <CellMuted>not reported</CellMuted>
                      ) : (
                        <CellMono>{dollars(m.costUsd)}</CellMono>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>
    </StudioPage>
  );
}
