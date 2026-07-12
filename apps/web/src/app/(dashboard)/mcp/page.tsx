import { listMcpServersAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import McpClient from './McpClient.tsx';

export const dynamic = 'force-dynamic';

export default async function McpPage() {
  const result = await listMcpServersAction();

  if (!result.ok) {
    return (
      <PageShell title="MCP Servers">
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {result.message}
        </div>
      </PageShell>
    );
  }

  const { instances, catalog } = result.data;

  return <McpClient instances={instances} catalog={catalog} />;
}
