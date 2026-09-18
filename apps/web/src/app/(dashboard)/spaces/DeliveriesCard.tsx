'use client';

// DeliveriesCard — ce que Nodal a envoyé, ou essaie encore d'envoyer, vers un
// canal pour ce travail (P3, plan « De la maquette au produit »). Lu depuis
// `job_deliveries` : la file d'envoi est reprise tant que ce n'est pas parti,
// et le fil le dit tel quel — une tentative en cours n'est ni un succès ni un
// échec.
//
// 18/09 — une SECTION comme les autres : même largeur, même titre mono en
// capitales, et surtout le MESSAGE. La carte disait « Deliveries · 1 · telegram »
// sans montrer ce qui avait été envoyé ni offrir de l'ouvrir (Quentin) : elle
// annonçait un envoi dont le contenu restait invisible. Chaque ligne se déplie
// maintenant sur le texte parti, dans la voix de l'agent, et sur la raison
// quand l'envoi a été refusé.

import { useState } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import Markdown from '@/components/Markdown.tsx';
import { relativeTime } from '@/lib/format-time';

export type DeliveryView = {
  channel: string;
  chatId: string;
  outcome: string;
  attempts: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  /**
   * LE MESSAGE, tel qu'il est parti (`job_deliveries.payload`), secrets
   * masqués à l'affichage comme partout ailleurs. Absent d'une donnée ancienne
   * qui ne le portait pas jusqu'ici : la ligne ne s'ouvre alors pas.
   */
  payload?: string | null;
  /**
   * La raison écrite sur le reçu quand l'envoi n'est pas parti
   * (`allowlist_refused`, `attempts_exhausted`). C'est un code du runner, pas
   * une phrase : il est rendu tel quel, jamais traduit en une explication qu'on
   * aurait inventée.
   */
  reason?: string | null;
};

const OUTCOME_TAG: Record<string, { tone: 'agent' | 'warn' | 'err' | 'ink'; label: string }> = {
  confirmed: { tone: 'agent', label: 'sent' },
  attempted: { tone: 'warn', label: 'retrying' },
  prepared: { tone: 'ink', label: 'queued' },
  rejected: { tone: 'err', label: 'rejected' },
};

export default function DeliveriesCard({ deliveries }: { deliveries: DeliveryView[] }) {
  if (deliveries.length === 0) return null;
  return (
    <div
      className="overflow-hidden rounded-xl border border-rule-2 bg-paper"
      data-testid="deliveries-section"
    >
      <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
        Deliveries · {deliveries.length}
      </h2>
      {deliveries.map((d, i) => (
        <DeliveryRow key={i} delivery={d} />
      ))}
    </div>
  );
}

/**
 * UN envoi : sa ligne, et dessous le message. La ligne ne s'ouvre que s'il y a
 * quelque chose à lire — un envoi dont le texte n'est pas connu garde sa ligne,
 * sans chevron, plutôt qu'un bouton qui n'ouvrirait rien.
 */
function DeliveryRow({ delivery }: { delivery: DeliveryView }) {
  const [open, setOpen] = useState(false);
  const tag = OUTCOME_TAG[delivery.outcome] ?? { tone: 'ink' as const, label: delivery.outcome };
  const text = delivery.payload?.trim() ?? '';
  const reason = delivery.reason?.trim() ?? '';
  const openable = text !== '' || reason !== '';
  const at = delivery.updatedAt ?? delivery.createdAt;

  const line = (
    <>
      <span className="shrink-0 text-mono-12 text-ink">{delivery.channel}</span>
      <span className="min-w-0 truncate text-mono-11 text-ink-4">to {delivery.chatId}</span>
      <MonoMicroTag tone={tag.tone}>{tag.label}</MonoMicroTag>
      {delivery.attempts > 0 && (
        <span className="shrink-0 text-mono-11 text-ink-4">
          {delivery.attempts} {delivery.attempts === 1 ? 'attempt' : 'attempts'}
        </span>
      )}
      <span className="ml-auto shrink-0 text-mono-11 text-ink-4">
        {at === null ? '' : relativeTime(at)}
      </span>
    </>
  );

  return (
    <div className="border-b border-rule-2 last:border-b-0" data-testid="delivery-row">
      {openable ? (
        <DisclosureButton open={open} onClick={() => setOpen((v) => !v)} inset="tight">
          {line}
        </DisclosureButton>
      ) : (
        <div className="flex items-center gap-2 px-4 py-3">{line}</div>
      )}
      {open && (
        <div className="space-y-2 border-t border-rule-2 px-4 py-3">
          {text !== '' && <Markdown text={text} />}
          {reason !== '' && <p className="text-mono-11 text-warn">{reason}</p>}
        </div>
      )}
    </div>
  );
}
