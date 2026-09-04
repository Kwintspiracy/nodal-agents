'use client';

/**
 * VerificationSection — ce que la preuve a fait pour ce run (plan « Vérifier
 * & Corriger », T24 / D9). Une carte entre la review et les fichiers : la
 * preuve juge tout le run, elle passe avant le détail fichier par fichier.
 *
 * En ① ces lignes sont de l'OBSERVATION : une commande, son rang, son code de
 * sortie, sa durée, son verdict — en MonoMicroTag, jamais en StatusPill, parce
 * qu'aucun état de décision (« succès vérifié / bloqué ») n'existe encore ;
 * la garde et son libellé arrivent en ②.
 *
 * La section n'est JAMAIS vide (inv. #4, « jamais silencieuse ») : quatre
 * phrases couvrent les cas sans ligne — un tour de chat (pas de job, donc pas
 * de preuve), une surface hors vérification (la TRACE du job, pas le réglage
 * courant), un projet sans commandes, et « aucune preuve n'a tourné ». Tout
 * le texte vit ici : le runner n'a journalisé que des codes (inv. #2).
 */

import type {
  VerificationSequenceView,
  VerificationUnconfiguredView,
} from '@/lib/verification-runs-view.ts';
import { surfaceLabel } from '@/lib/verification-runs-view.ts';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { relativeTime } from '@/lib/format-time';

export type VerificationSectionProps = {
  sequences: VerificationSequenceView[];
  skippedSurfaces: string[];
  unconfigured: VerificationUnconfiguredView[];
  /** 'chat' pour une session de runtime ; les étapes de job sinon. */
  stage: string;
  /** true tant que le process tourne : la phrase « pas encore » diffère de « jamais ». */
  live: boolean;
};

const VERDICT_TAG: Record<string, { tone: 'skill' | 'err' | 'warn'; label: string }> = {
  green: { tone: 'skill', label: 'green' },
  red: { tone: 'err', label: 'red' },
  infra_error: { tone: 'warn', label: 'infra error' },
};

function verdictTag(verdict: string) {
  return VERDICT_TAG[verdict] ?? { tone: 'warn' as const, label: verdict };
}

function exitLabel(run: { exitCode: number | null; outcomeKind: string }): string {
  if (run.outcomeKind === 'timeout') return 'timeout';
  if (run.outcomeKind === 'spawn_error') return 'spawn error';
  return run.exitCode === null ? 'n/a' : String(run.exitCode);
}

function durationLabel(ms: number | null): string {
  if (ms === null) return 'n/a';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export default function VerificationSection({
  sequences,
  skippedSurfaces,
  unconfigured,
  stage,
  live,
}: VerificationSectionProps) {
  const isChat = stage === 'chat';
  const nothingRan = sequences.length === 0;

  return (
    <div
      className="overflow-hidden rounded-xl border border-rule-2 bg-paper"
      data-testid="verification-section"
    >
      <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
        Verification{sequences.length > 0 ? ` · ${sequences.length}` : ''}
      </h2>

      {isChat ? (
        <p className="px-4 py-6 text-body-13 text-ink-4">
          Chat turns are not under verification yet: a chat turn has no job, so no proof runs for
          it.
        </p>
      ) : (
        <>
          {skippedSurfaces.length > 0 && (
            <ul className="space-y-1.5 border-b border-rule-2 px-4 py-3">
              {skippedSurfaces.map((key) => (
                <li
                  key={key}
                  className="flex flex-wrap items-center gap-2 text-body-13 text-ink-3"
                  data-testid={`verification-skipped-${key}`}
                >
                  <MonoMicroTag tone="warn">not verified</MonoMicroTag>
                  <span>{surfaceLabel(key)} is out of verification for this workspace.</span>
                </li>
              ))}
            </ul>
          )}

          {unconfigured.length > 0 && (
            <ul className="space-y-1.5 border-b border-rule-2 px-4 py-3">
              {unconfigured.map((u) => (
                <li
                  key={`${u.deliverableType}:${u.canonicalKey}`}
                  className="flex flex-wrap items-center gap-2 text-body-13 text-ink-3"
                >
                  <MonoMicroTag tone="ink">
                    {u.reason === 'pending_approval' ? 'awaiting approval' : 'not configured'}
                  </MonoMicroTag>
                  <span className="min-w-0 truncate font-mono" title={u.canonicalKey}>
                    {u.displayPath ?? u.canonicalKey}
                  </span>
                  <span>
                    {u.reason === 'pending_approval'
                      ? 'has proof commands waiting for the owner’s approval.'
                      : 'has no proof commands. Add them on its project card in Code.'}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {nothingRan ? (
            <p className="px-4 py-6 text-body-13 text-ink-4">
              {live
                ? 'No proof yet. Proof commands run when the process finishes.'
                : 'No proof ran for this process.'}
            </p>
          ) : (
            sequences.map((s) => <SequenceBlock key={s.sequenceId} sequence={s} />)
          )}
        </>
      )}
    </div>
  );
}

function SequenceBlock({ sequence }: { sequence: VerificationSequenceView }) {
  const tag = verdictTag(sequence.verdict);
  return (
    <div className="border-b border-rule-2 last:border-b-0" data-testid="verification-sequence">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <MonoMicroTag tone={tag.tone}>{tag.label}</MonoMicroTag>
        <span
          className="min-w-0 flex-1 truncate font-mono text-body-13 text-ink"
          title={sequence.canonicalKey}
        >
          {sequence.canonicalKey}
        </span>
        <span className="shrink-0 text-mono-11 text-ink-4">
          {sequence.runs.length} {sequence.runs.length === 1 ? 'command' : 'commands'}
          {sequence.startedAt ? ` · ${relativeTime(sequence.startedAt)}` : ''}
        </span>
      </div>
      <div className="overflow-x-auto">
        <Table frame={false}>
          <THead>
            <Th>#</Th>
            <Th>Command</Th>
            <Th align="right">Exit</Th>
            <Th align="right">Duration</Th>
            <Th>Verdict</Th>
          </THead>
          <tbody>
            {sequence.runs.map((r) => {
              const t = verdictTag(r.verdict);
              return (
                <Tr key={`${r.sequenceId}:${r.commandRank}`}>
                  <Td className="text-mono-11 text-ink-4">{r.commandRank}</Td>
                  <Td className="font-mono text-body-13 text-ink">{r.command}</Td>
                  <Td align="right" className="text-mono-11 text-ink-3">
                    {exitLabel(r)}
                  </Td>
                  <Td align="right" className="text-mono-11 text-ink-3">
                    {durationLabel(r.durationMs)}
                  </Td>
                  <Td>
                    <MonoMicroTag tone={t.tone}>{t.label}</MonoMicroTag>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
