// Un scénario : la demande exacte, ce que « vert » veut dire, comment il est jugé, ce qu'il exige.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { duree, studioCatalog, studioResults } from '@nodal-agents/bench/studio';
import Banner from '@/components/ui/Banner';
import CodeBlock from '@/components/ui/CodeBlock';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { assertStudioPage, studioRuntime } from '@/lib/bench-studio/server';
import NeedStatus from '../../_components/NeedStatus';
import StudioPage, { Fact, Panel } from '../../_components/StudioPage';
import VerdictPill from '../../_components/VerdictPill';
import { bytes, when } from '../../_components/format';

export const dynamic = 'force-dynamic';

const SENDS: Record<string, string> = {
  nothing: 'Nothing may leave the machine. A send during the trial makes it red.',
  owner:
    'Sends to the owner (their default chat). Never in a set, an activity, a matrix or the night run: it runs only when named, with the explicit toggle.',
};

export default async function ScenarioPage({ params }: { params: Promise<{ id: string }> }) {
  await assertStudioPage();
  const { id } = await params;
  const catalog = studioCatalog();
  const s = catalog.scenarios.find((x) => x.id === id);
  if (!s) notFound();
  const needs = await studioRuntime().needs();
  const recent =
    studioResults()
      .activities.flatMap((a) => a.scenarios)
      .find((x) => x.id === s.id)
      ?.cells.flatMap((c) => c.last.map((l) => ({ ...l, column: c.column }))) ?? [];
  recent.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const files = catalog.fixtureFiles[s.id] ?? [];

  return (
    <StudioPage
      title={s.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{s.id}</span>
          <MonoMicroTag tone="ink">v{s.version}</MonoMicroTag>
          <MonoMicroTag tone="ink">{s.activity}</MonoMicroTag>
          <MonoMicroTag tone="ink">{s.set}</MonoMicroTag>
        </span>
      }
      actions={
        <PrimaryButton href={`/bench-studio/run?only=${encodeURIComponent(s.id)}`}>
          Run this scenario
        </PrimaryButton>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Expected path">
            <p className="text-body-14 text-ink">{s.path}</p>
            {s.productTools && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-medium-12 text-ink-4">Product tools</span>
                {s.productTools.tools.map((t) => (
                  <span
                    key={t}
                    className="rounded-md border border-rule-2 px-1.5 py-0.5 font-mono text-mono-12 text-ink-2"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            {s.subject && (
              <p className="mt-3 text-body-13 text-ink-3">
                The subject is a calibrated one (kind <span className="font-mono">{s.subject}</span>
                ), read from the bench&apos;s subjects file, never written in the request. With
                none, the trial is skipped.
              </p>
            )}
          </Panel>
          <Panel title="Deliverable">
            <p className="text-body-14 text-ink">{s.deliverable}</p>
          </Panel>
          <Panel title="Green if">
            <p className="text-body-14 text-ink">{s.green}</p>
            <details className="mt-4">
              <summary className="cursor-pointer text-medium-12 text-ink-3 hover:text-ink">
                How the bench checks it ({s.judgedBy.length})
              </summary>
              <ol className="mt-3 flex flex-col gap-2.5">
                {s.judgedBy.map((j, i) => (
                  <li key={i} className="flex gap-3 text-body-13 text-ink-2">
                    <span className="mt-0.5 text-mono-11 text-ink-4">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span>{j}</span>
                  </li>
                ))}
              </ol>
            </details>
          </Panel>
          <Panel title="Measured on every trial">
            <p className="mb-2 text-body-13 text-ink-3">
              Shown on each trial and in the comparisons. A measure never makes a trial red.
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-body-13 text-ink-2">
              {catalog.measured.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Panel>
          {s.unverified.length > 0 && (
            <Banner variant="warn" title="Not verified">
              <ul className="flex flex-col gap-1.5">
                {s.unverified.map((u) => (
                  <li key={u.check}>
                    <span className="text-medium-13">{u.check}</span> ({u.ticket}): {u.reason}
                  </li>
                ))}
              </ul>
            </Banner>
          )}
          <Panel title="Example request">
            <p className="mb-3 text-body-13 text-ink-3">
              Sent word for word to the root agent through{' '}
              <span className="font-mono">run_task</span>, the way the owner would ask.
              {s.subject && (
                <>
                  {' '}
                  <span className="font-mono">{'{subject}'}</span> is replaced by the calibrated
                  subject.
                </>
              )}
            </p>
            <CodeBlock code={s.instruction} lang="text" lineNumbers={false} className="" />
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Facts">
            <div className="-my-2 divide-y divide-rule-2">
              <Fact label="Timeout">{duree(s.timeoutMs)}</Fact>
              <Fact label="Version">v{s.version}</Fact>
              <Fact label="Set">{s.set}</Fact>
              <Fact label="Sends">
                <span className="font-mono">{s.sends}</span>
                <span className="mt-1 block text-body-12 text-ink-3">
                  {SENDS[s.sends] ??
                    'A declared test account. Any other recipient makes the trial red.'}
                </span>
              </Fact>
            </div>
          </Panel>
          <Panel title="Needs">
            {s.needs.length === 0 ? (
              <p className="text-body-13 text-ink-4">None: it runs on any stack.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {s.needs.map((n) => {
                  const missing = needs.reachable
                    ? (needs.needs.find((x) => x.need === n)?.missing ?? null)
                    : null;
                  return (
                    <li key={n} className="flex flex-col items-start gap-1">
                      <NeedStatus needs={needs} need={n} />
                      <span className="text-body-12 text-ink-3">
                        {!needs.reachable
                          ? `Bench space not read: ${needs.why}`
                          : missing
                            ? `Missing: ${missing}`
                            : 'Available in the bench space now.'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          <Panel title="Fixtures">
            {s.fixtures.length === 0 ? (
              <p className="text-body-13 text-ink-4">
                None: the trial starts from an empty folder.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {s.fixtures.map((f) => (
                  <p key={f.from} className="text-body-12 text-ink-3">
                    <span className="font-mono text-ink-2">{f.from}</span> is copied to{' '}
                    <span className="font-mono text-ink-2">{f.to}</span>
                  </p>
                ))}
                <ul className="flex flex-col gap-1">
                  {files.map((f) => (
                    <li key={f.path} className="flex items-center justify-between gap-3">
                      <Link
                        href={`/bench-studio/fixture?path=${encodeURIComponent(f.path)}`}
                        className="truncate text-mono-12 text-ink hover:underline"
                      >
                        {f.path}
                      </Link>
                      <span className="shrink-0 text-mono-11 text-ink-4">{bytes(f.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
          <Panel title="Outputs">
            {s.outputs.length === 0 ? (
              <p className="text-body-13 text-ink-4">
                None declared: the judge reads the files named above, or the answer.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {s.outputs.map((o) => (
                  <li key={o} className="text-mono-12 text-ink-2">
                    {o}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel
            title="Recent trials"
            aside={
              <Link
                href="/bench-studio/results"
                className="text-medium-12 text-ink-3 hover:text-ink"
              >
                All results
              </Link>
            }
          >
            {recent.length === 0 ? (
              <p className="text-body-13 text-ink-4">No trial of this version yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-rule-2">
                {recent.slice(0, 8).map((t, i) => (
                  <li key={`${t.n}-${i}`} className="flex flex-wrap items-center gap-3 py-2">
                    <VerdictPill verdict={t.verdict} />
                    <span className="text-mono-12 text-ink-3">{when(t.startedAt)}</span>
                    <span className="text-body-13 text-ink-2">{t.column}</span>
                    {t.n !== null && (
                      <Link
                        href={`/bench-studio/results/${t.n}`}
                        className="ml-auto text-medium-12 text-ink-3 hover:text-ink"
                      >
                        Open trial
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </StudioPage>
  );
}
