import { listMcpServersAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import McpClient from './McpClient.tsx';
import Banner from '@/components/ui/Banner';

export const dynamic = 'force-dynamic';

export default async function McpPage() {
  const result = await listMcpServersAction();

  if (!result.ok) {
    return (
      <PageShell title="MCP Servers">
        <Banner variant="warn">{result.message}</Banner>
      </PageShell>
    );
  }

  const { instances, catalog } = result.data;

  return <McpClient instances={instances} catalog={catalog} />;
}
