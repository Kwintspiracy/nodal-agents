'use client';

// ServiceLogsPanel — les logs de SERVICE (runner/web) lisibles dans le
// dashboard : fin de fichier + suivi live, accès à l'archive de rotation
// (.1), effacement owner-only. Jusqu'ici ces fichiers n'étaient lisibles
// qu'au CLI (`nodal-agents logs`) — constat Quentin 24/08.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import PillTabs from '@/components/ui/PillTabs';
import PrimaryButton from '@/components/ui/PrimaryButton';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import {
  readServiceLogTailAction,
  clearServiceLogAction,
  listServiceLogsAction,
  type ServiceLogInfoRow,
} from '@/lib/actions.ts';

const POLL_MS = 5000;

type Service = 'runner' | 'web';
type Generation = 'current' | 'archive';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function ServiceLogsPanel({ initial }: { initial: ServiceLogInfoRow[] }) {
  const [rows, setRows] = useState(initial);
  const [service, setService] = useState<Service>('runner');
  const [generation, setGeneration] = useState<Generation>('current');
  const [tail, setTail] = useState('');
  const [sizeBytes, setSizeBytes] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [exists, setExists] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  const row = rows.find((r) => r.service === service);
  const isOwner = row?.isOwner ?? false;
  const hasArchive = (row?.archiveBytes ?? null) !== null;

  const applyTail = useCallback((r: Awaited<ReturnType<typeof readServiceLogTailAction>>) => {
    if (!r.ok) return;
    setTail(r.data.tail);
    setSizeBytes(r.data.sizeBytes);
    setTruncated(r.data.truncated);
    setExists(r.data.exists);
  }, []);

  // Chargement à la bascule service/génération, puis suivi live du fichier
  // COURANT uniquement (l'archive ne bouge plus). Un seul effet, annulable :
  // une réponse arrivée après un changement d'onglet est jetée.
  useEffect(() => {
    followRef.current = true;
    let cancelled = false;
    const load = () =>
      readServiceLogTailAction({ service, generation }).then((r) => {
        if (!cancelled) applyTail(r);
      });
    void load();
    const id = generation === 'current' ? setInterval(() => void load(), POLL_MS) : null;
    return () => {
      cancelled = true;
      if (id !== null) clearInterval(id);
    };
  }, [service, generation, applyTail]);

  // Auto-scroll en bas tant que l'utilisateur n'a pas remonté lui-même.
  useEffect(() => {
    const el = preRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [tail]);

  function handleScroll() {
    const el = preRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  async function doClear() {
    setClearing(true);
    const r = await clearServiceLogAction({ service });
    setClearing(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success(`Cleared ${service} logs (${fmtBytes(r.data.freedBytes)} freed).`);
    setGeneration('current');
    const [list, tailRes] = await Promise.all([
      listServiceLogsAction(),
      readServiceLogTailAction({ service, generation: 'current' }),
    ]);
    if (list.ok) setRows(list.data);
    applyTail(tailRes);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PillTabs
          tabs={[
            { value: 'runner', label: 'Runner' },
            { value: 'web', label: 'Web' },
          ]}
          value={service}
          onChange={(v) => {
            setService(v as Service);
            setGeneration('current');
          }}
          variant="inset"
        />
        <PillTabs
          tabs={[
            { value: 'current', label: `Current · ${fmtBytes(row?.currentBytes ?? 0)}` },
            ...(hasArchive
              ? [{ value: 'archive', label: `Previous · ${fmtBytes(row?.archiveBytes ?? 0)}` }]
              : []),
          ]}
          value={generation}
          onChange={(v) => setGeneration(v as Generation)}
          variant="inset"
        />
        {generation === 'current' && <MonoMicroTag tone="agent">live</MonoMicroTag>}
        <div className="ml-auto">
          {isOwner && (
            <PrimaryButton
              variant="danger"
              size="sm"
              onClick={() => setConfirmClear(true)}
              disabled={clearing || (!exists && !hasArchive)}
            >
              {clearing ? 'Clearing…' : 'Clear logs'}
            </PrimaryButton>
          )}
        </div>
      </div>

      {truncated && (
        <p className="text-body-12 text-ink-4">
          Showing the last 64 KB of {fmtBytes(sizeBytes)}. Use{' '}
          <code className="text-mono-12">nodal-agents logs {service}</code> for the full file.
        </p>
      )}

      {!exists ? (
        <div className="rounded-xl border border-rule-2 bg-paper px-6 py-10 text-center text-body-13 text-ink-4">
          No {generation === 'archive' ? 'archived ' : ''}log file yet for this service.
        </div>
      ) : (
        <pre
          ref={preRef}
          onScroll={handleScroll}
          data-testid="service-log-tail"
          className="text-mono-12 h-[60vh] overflow-auto rounded-xl border border-rule-2 bg-canvas/60 p-4 leading-[1.5]! whitespace-pre-wrap text-ink-2"
        >
          {tail || '(empty)'}
        </pre>
      )}

      <ConfirmDialog
        open={confirmClear}
        title={`Clear ${service} logs?`}
        message="This empties the current log file and deletes its archive. Useful for a fresh capture before reproducing a bug — the history is gone for good."
        confirmLabel="Clear"
        destructive
        onConfirm={() => {
          setConfirmClear(false);
          void doClear();
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
