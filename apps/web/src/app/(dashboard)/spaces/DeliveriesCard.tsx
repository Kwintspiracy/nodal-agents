// DeliveriesCard — ce que Nodal a envoyé, ou essaie encore d'envoyer, vers un
// canal pour ce travail (P3, plan « De la maquette au produit »). Lu depuis
// `job_deliveries` : la file d'envoi est reprise tant que ce n'est pas parti,
// et le fil le dit tel quel — une tentative en cours n'est ni un succès ni un
// échec.

import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { relativeTime } from '@/lib/format-time';

export type DeliveryView = {
  channel: string;
  chatId: string;
  outcome: string;
  attempts: number;
  createdAt: Date | null;
  updatedAt: Date | null;
};

const OUTCOME_TAG: Record<string, { tone: 'agent' | 'warn' | 'err' | 'ink'; label: string }> = {
  confirmed: { tone: 'agent', label: 'sent' },
  attempted: { tone: 'warn', label: 'retrying' },
  prepared: { tone: 'ink', label: 'queued' },
  rejected: { tone: 'err', label: 'rejected' },
};

export default function DeliveriesCard({ deliveries }: { deliveries: DeliveryView[] }) {
  if (deliveries.length === 0) return null;
  const pending = deliveries.filter(
    (d) => d.outcome === 'prepared' || d.outcome === 'attempted',
  ).length;
  return (
    <div className="mt-6 max-w-[760px] overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <div className="flex items-center gap-2.5 border-b border-rule-2 bg-sidebar px-4 py-2.5">
        <span className="text-medium-13 text-ink">Deliveries</span>
        <span className="text-mono-11 text-ink-4">
          {deliveries.length} {deliveries.length === 1 ? 'message' : 'messages'}
          {pending > 0 ? ` · ${pending} pending` : ''}
        </span>
      </div>
      <ul className="py-1">
        {deliveries.map((d, i) => {
          const tag = OUTCOME_TAG[d.outcome] ?? { tone: 'ink' as const, label: d.outcome };
          return (
            <li key={i} className="flex items-center gap-3 px-4 py-1.5 text-body-12 text-ink-2">
              <span className="text-mono-12 text-ink">{d.channel}</span>
              <span className="text-mono-11 text-ink-4">to {d.chatId}</span>
              <MonoMicroTag tone={tag.tone}>{tag.label}</MonoMicroTag>
              {d.attempts > 0 && (
                <span className="text-mono-11 text-ink-4">
                  {d.attempts} {d.attempts === 1 ? 'attempt' : 'attempts'}
                </span>
              )}
              <span className="ml-auto text-mono-11 text-ink-4">
                {d.updatedAt
                  ? relativeTime(d.updatedAt)
                  : d.createdAt
                    ? relativeTime(d.createdAt)
                    : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
