import { listCodingProcessesAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import CodeProcessesTable from './CodeProcessesTable.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function CodePage() {
  const result = await listCodingProcessesAction();
  const rows = result.ok ? result.data : [];

  return (
    <PageShell
      title="Code"
      subtitle={`${rows.length} coding process${rows.length !== 1 ? 'es' : ''}`}
    >
      <CodeProcessesTable initialRows={rows} error={!result.ok ? result.message : undefined} />
    </PageShell>
  );
}
