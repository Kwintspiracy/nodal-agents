import { listMcpServersAction } from '@/lib/actions.ts';
import McpServerForm from './McpServerForm.tsx';
import McpServerRow from './McpServerRow.tsx';

export const dynamic = 'force-dynamic';

export default async function McpPage() {
  const result = await listMcpServersAction();

  if (!result.ok) {
    return (
      <div className="space-y-6 max-w-4xl">
        <h1 className="text-2xl font-bold text-white">MCP Connectors</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  const connected = result.data.filter((e) => e.server !== null);
  const available = result.data.filter((e) => e.server === null);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-white">MCP Connectors</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {connected.length} connected · remote MCP servers whose tools your agents can use
        </p>
      </div>

      <McpServerForm available={available} />

      {connected.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-12 text-center text-neutral-600 text-sm">
          No MCP connectors yet. Pick one above and paste your API key — its tools become available
          to any agent you assign it to.
        </div>
      ) : (
        <div className="space-y-3">
          {connected.map((e) => (
            <McpServerRow key={e.catalogSlug} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}
