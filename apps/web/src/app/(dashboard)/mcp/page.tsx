import { listMcpServersAction } from '@/lib/actions.ts';
import McpClient from './McpClient.tsx';

export const dynamic = 'force-dynamic';

export default async function McpPage() {
  const result = await listMcpServersAction();

  if (!result.ok) {
    return (
      <div className="py-7">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          MCP Servers
        </h1>
        <div className="mt-4 rounded-2xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
          {result.message}
        </div>
      </div>
    );
  }

  const { instances, catalog } = result.data;

  return <McpClient instances={instances} catalog={catalog} />;
}
