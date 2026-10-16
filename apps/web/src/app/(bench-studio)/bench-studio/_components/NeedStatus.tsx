// L'état d'un besoin, lu sur la stack au moment de l'affichage.
import type { NeedsView } from '@nodal-agents/bench/studio';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';

export function needState(needs: NeedsView, need: string): 'met' | 'missing' | 'unknown' {
  if (!needs.reachable) return 'unknown';
  const n = needs.needs.find((x) => x.need === need);
  return n === undefined ? 'unknown' : n.missing === null ? 'met' : 'missing';
}

export default function NeedStatus({ needs, need }: { needs: NeedsView; need: string }) {
  const state = needState(needs, need);
  const why =
    needs.reachable === false
      ? `stack not read: ${needs.why}`
      : (needs.needs.find((x) => x.need === need)?.missing ?? 'available');
  return (
    <span title={why}>
      <MonoMicroTag tone={state === 'met' ? 'ok' : state === 'missing' ? 'warn' : 'ink'}>
        {need}
        {state === 'missing' ? ' · missing' : state === 'unknown' ? ' · ?' : ''}
      </MonoMicroTag>
    </span>
  );
}
