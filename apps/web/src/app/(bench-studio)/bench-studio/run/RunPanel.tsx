'use client';

// Le panneau de lancement. Il ne décide de rien : la sélection, le plan et la
// porte de lancement sont ceux du banc (selection.ts, matrix.ts, launch-gate.ts),
// rendus par les routes du studio. Le bouton désactivé dit pourquoi, et le
// serveur tient la même porte (RunManager.launch).
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { LaunchGate, PlanView, StudioModel } from '@nodal-agents/bench/studio';
import { dollars, duree } from '@nodal-agents/bench/results';
import Banner from '@/components/ui/Banner';
import Checkbox from '@/components/ui/Checkbox';
import MetricCard from '@/components/ui/MetricCard';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Switch from '@/components/ui/Switch';
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
import TextInput from '@/components/ui/TextInput';
import { Panel } from '../_components/StudioPage';
import { studioPost } from '../_components/studio-fetch';

interface ScenarioPick {
  id: string;
  title: string;
  activity: string;
  sends: string;
  set: string;
}

type Mode = 'activities' | 'scenarios';

export default function RunPanel({
  activities,
  scenarios,
  models,
  gate,
  initialOnly,
}: {
  activities: string[];
  scenarios: ScenarioPick[];
  models: StudioModel[];
  gate: LaunchGate;
  initialOnly: string[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialOnly.length > 0 ? 'scenarios' : 'activities');
  const [pickedActivities, setPickedActivities] = useState<string[]>([]);
  const [pickedScenarios, setPickedScenarios] = useState<string[]>(initialOnly);
  const [pickedModels, setPickedModels] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState('');
  const [trials, setTrials] = useState('1');
  const [allowOwnerSends, setAllowOwnerSends] = useState(false);
  // Le plan porte la clé de la demande qui l'a produit : un plan d'une autre
  // sélection n'est jamais montré pour celle-ci.
  const [answer, setAnswer] = useState<{
    key: string;
    plan: { view: PlanView } | { error: string };
  } | null>(null);
  const [launching, setLaunching] = useState(false);

  const selection = useMemo(
    () =>
      mode === 'activities'
        ? pickedActivities.length > 0
          ? { activity: pickedActivities }
          : null
        : pickedScenarios.length > 0
          ? { only: pickedScenarios }
          : null,
    [mode, pickedActivities, pickedScenarios],
  );
  const trialsN = Number(trials);
  const ownerPicked =
    mode === 'scenarios'
      ? scenarios.filter((s) => s.sends === 'owner' && pickedScenarios.includes(s.id))
      : [];

  // Le plan suit la sélection : demandé au banc, jamais calculé ici.
  const planKey = selection
    ? JSON.stringify({ selection, models: pickedModels.join(','), trials: trialsN })
    : null;
  useEffect(() => {
    if (planKey === null) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      void studioPost('/bench-studio/api/plan', planKey, ctl.signal)
        .then(async (r) => {
          const body = (await r.json()) as PlanView | { error: string };
          setAnswer({
            key: planKey,
            plan: 'error' in body ? { error: body.error } : { view: body },
          });
        })
        .catch((e: unknown) => {
          if (!ctl.signal.aborted) setAnswer({ key: planKey, plan: { error: String(e) } });
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [planKey]);
  const plan = answer !== null && answer.key === planKey ? answer.plan : null;

  const blocked: string | null = !gate.enabled
    ? gate.reason
    : !selection
      ? 'Pick at least one activity or scenario.'
      : pickedModels.length > 0
        ? 'Models are for the estimate only: running a model matrix waits for the owner’s decision. Clear them to launch on the agents’ own models.'
        : ownerPicked.length > 0 && !allowOwnerSends
          ? `${ownerPicked.map((s) => s.id).join(', ')} sends to the owner: allow it below to launch.`
          : plan && 'error' in plan
            ? plan.error
            : null;

  async function launch(): Promise<void> {
    if (!selection) return;
    setLaunching(true);
    try {
      const r = await studioPost('/bench-studio/api/launch', {
        selection,
        trials: trialsN,
        allowOwnerSends,
      });
      const body = (await r.json()) as { id: string } | { error: string };
      if ('error' in body) {
        toast.error(body.error);
        return;
      }
      router.push(`/bench-studio/live/${body.id}`);
    } finally {
      setLaunching(false);
    }
  }

  const toggle = (list: string[], v: string): string[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const shownModels = models.filter((m) =>
    `${m.key} ${m.label}`.toLowerCase().includes(modelFilter.trim().toLowerCase()),
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-5">
        <Panel
          title="What to run"
          aside={
            <SegmentedControl<Mode>
              ariaLabel="Pick by"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'activities', label: 'Activities' },
                { value: 'scenarios', label: 'Scenarios' },
              ]}
            />
          }
        >
          {mode === 'activities' ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {activities.map((a) => {
                const n = scenarios.filter((s) => s.activity === a && s.sends !== 'owner').length;
                return (
                  <Checkbox
                    key={a}
                    checked={pickedActivities.includes(a)}
                    onChange={() => setPickedActivities((l) => toggle(l, a))}
                    containerClassName="rounded-lg border border-rule-2 px-3 py-2.5 hover:bg-hover"
                    label={
                      <span className="flex w-full items-center justify-between gap-2">
                        <span>{a}</span>
                        <span className="text-mono-11 text-ink-4">{n}</span>
                      </span>
                    }
                  />
                );
              })}
              <p className="col-span-full mt-1 text-body-12 text-ink-4">
                An activity never includes a scenario that sends to the owner: name it under
                Scenarios.
              </p>
            </div>
          ) : (
            <div className="-mx-1 flex max-h-[30rem] flex-col gap-4 overflow-y-auto px-1">
              {activities.map((a) => (
                <div key={a}>
                  <div className="mb-1.5 text-label-11 tracking-wider text-ink-4 uppercase">
                    {a}
                  </div>
                  <div className="flex flex-col">
                    {scenarios
                      .filter((s) => s.activity === a)
                      .map((s) => (
                        <Checkbox
                          key={s.id}
                          checked={pickedScenarios.includes(s.id)}
                          onChange={() => setPickedScenarios((l) => toggle(l, s.id))}
                          containerClassName="rounded-md px-2 py-1.5 hover:bg-hover"
                          label={
                            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="text-body-13 text-ink">{s.title}</span>
                              <span className="text-mono-11 text-ink-4">{s.id}</span>
                              {s.sends !== 'nothing' && (
                                <MonoMicroTag tone="warn">sends {s.sends}</MonoMicroTag>
                              )}
                            </span>
                          }
                        />
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Estimate">
          {!selection ? (
            <p className="text-body-13 text-ink-4">Pick something to run to see its estimate.</p>
          ) : plan === null ? (
            <p className="text-body-13 text-ink-4">Estimating…</p>
          ) : 'error' in plan ? (
            <Banner variant="warn">{plan.error}</Banner>
          ) : (
            <PlanTable view={plan.view} />
          )}
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-20 lg:self-start">
        <Panel title="Models">
          <TextInput
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            placeholder="Filter the catalog"
            aria-label="Filter models"
          />
          <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-rule-2">
            {shownModels.length === 0 && (
              <p className="px-2.5 py-2 text-body-12 text-ink-4">No catalog model matches.</p>
            )}
            {shownModels.map((m, i) => (
              <div key={m.key}>
                {(i === 0 ||
                  (shownModels[i - 1]!.unavailable === null) !== (m.unavailable === null)) && (
                  <div className="border-b border-rule-2 bg-canvas px-2.5 py-1.5 text-label-11 tracking-wider text-ink-4 uppercase">
                    {m.unavailable === null ? 'The bench space can call' : 'Not callable'}
                  </div>
                )}
                <Checkbox
                  checked={pickedModels.includes(m.key)}
                  disabled={m.unavailable !== null}
                  onChange={() => setPickedModels((l) => toggle(l, m.key))}
                  containerClassName={`border-b border-rule-2 px-2.5 py-1.5 ${m.unavailable === null ? 'hover:bg-hover' : 'opacity-60'}`}
                  label={
                    <span
                      className="flex min-w-0 flex-1 flex-col"
                      title={m.unavailable ?? undefined}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-body-13 text-ink">{m.label}</span>
                        <span className="shrink-0 text-mono-11 text-ink-3">
                          {m.pricing
                            ? `$${m.pricing.inputPerMillionUsd} / $${m.pricing.outputPerMillionUsd}`
                            : 'no price'}
                        </span>
                      </span>
                      <span className="truncate text-mono-11 text-ink-4">
                        {m.provider} · {m.key.slice(m.provider.length + 1)}
                      </span>
                      {m.unavailable !== null && (
                        <span className="text-body-12 text-ink-4">{m.unavailable}</span>
                      )}
                    </span>
                  }
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-body-12 text-ink-4">
            Prices are the catalog&apos;s, in dollars per million tokens in / out. The estimate
            below turns them into a cost per trial from past runs.
          </p>
          <p className="mt-2 text-body-12 text-ink-4">
            {pickedModels.length === 0
              ? 'None picked: the agents run on their own models.'
              : `${pickedModels.length} picked, for the estimate.`}
          </p>
        </Panel>

        <Panel title="Launch">
          <div className="flex flex-col gap-4">
            <TextInput
              label="Trials per scenario"
              type="number"
              min={1}
              max={20}
              value={trials}
              onChange={(e) => setTrials(e.target.value)}
            />
            {ownerPicked.length > 0 && (
              <div className="flex items-start gap-3 rounded-lg border border-rule-2 px-3 py-2.5">
                <Switch
                  checked={allowOwnerSends}
                  onChange={() => setAllowOwnerSends((v) => !v)}
                  ariaLabel="Allow sends to the owner"
                />
                <div className="text-body-12 text-ink-3">
                  <div className="text-medium-13 text-ink">Allow sends to the owner</div>
                  {ownerPicked.map((s) => s.id).join(', ')} sends a real message to the owner’s
                  chat.
                </div>
              </div>
            )}
            <PrimaryButton
              variant="agent"
              disabled={blocked !== null || launching}
              onClick={() => void launch()}
            >
              {launching ? 'Launching…' : 'Launch'}
            </PrimaryButton>
            {blocked !== null && (
              <p className="text-body-12 text-ink-3" data-testid="launch-blocked">
                {blocked}
              </p>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function PlanTable({ view }: { view: PlanView }) {
  const p = view.plan;
  const total = p.cells.reduce((t, c) => t + c.trials, 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard
          label="Trials"
          value={String(total)}
          subtle={`${view.scenarios.length} scenario(s) × ${view.columns.length === 1 ? view.columns[0] : `${view.columns.length} models`} × ${view.trials}`}
        />
        <MetricCard
          label="Estimated cost"
          value={dollars(p.knownUsd)}
          subtle={
            p.unknownCells > 0
              ? `plus ${p.unknownCells} cell(s) with no estimate`
              : 'every cell estimated'
          }
        />
        <MetricCard
          label="Estimated time"
          value={p.knownDurationMs > 0 ? duree(p.knownDurationMs) : 'unknown'}
          subtle="one after the other, cells with a past run"
        />
      </div>
      {view.unreadableLines > 0 && (
        <Banner variant="warn">
          {view.unreadableLines} line(s) of workflows.ndjson could not be read and were left out.
        </Banner>
      )}
      <Table>
        <THead>
          <Th>Scenario</Th>
          {view.columns.length > 1 && <Th className="hidden md:table-cell">Model</Th>}
          <Th align="right">Cost</Th>
          <Th align="right" className="hidden sm:table-cell">
            Median time
          </Th>
        </THead>
        <tbody>
          {p.cells.map((c) => (
            <Tr key={`${c.scenario}|${c.model}`}>
              <Td>
                <CellTitle meta={`${c.activity} · ${c.pastRuns} past run(s) · ×${c.trials}`}>
                  {c.scenario}
                </CellTitle>
              </Td>
              {view.columns.length > 1 && (
                <Td className="hidden md:table-cell">
                  <CellText>{c.model}</CellText>
                </Td>
              )}
              <Td align="right">
                {c.estimatedUsd === null ? (
                  <CellMuted>{c.why}</CellMuted>
                ) : (
                  <CellMono>{dollars(c.estimatedUsd)}</CellMono>
                )}
              </Td>
              <Td align="right" className="hidden sm:table-cell">
                <CellMono>{duree(c.medianDurationMs)}</CellMono>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
