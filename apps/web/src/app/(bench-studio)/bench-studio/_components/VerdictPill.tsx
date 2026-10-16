import StatusPill from '@/components/ui/StatusPill';

/** Le verdict d'un essai, dans la grammaire des pastilles du dashboard. */
export default function VerdictPill({ verdict }: { verdict: string }) {
  if (verdict === 'green') return <StatusPill variant="done" label="Green" />;
  if (verdict === 'skipped') return <StatusPill variant="idle" label="Skipped" />;
  if (verdict === 'red') return <StatusPill variant="lvl-err" label="Red" />;
  return <StatusPill variant="warn" label={verdict} />;
}
