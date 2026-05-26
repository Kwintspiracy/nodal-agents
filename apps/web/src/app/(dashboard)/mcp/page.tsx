import { listMcpServersAction } from '@/lib/actions.ts';
import McpServerRow from './McpServerRow.tsx';
import McpAddForm from './McpAddForm.tsx';

export const dynamic = 'force-dynamic';

export default async function McpPage() {
  const result = await listMcpServersAction();

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">MCP Connectors</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  const { instances, catalog } = result.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">MCP Connectors</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {instances.length} active instance{instances.length === 1 ? '' : 's'} · remote MCP servers
          whose tools your agents can use
        </p>
      </div>

      {/* ── Active Servers ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider">
          Active Servers
        </h2>

        {instances.length === 0 ? (
          <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-12 text-center text-neutral-600 text-sm">
            No MCP connectors yet. Pick one from the Marketplace below and paste your API key — its
            tools become available to any agent you assign it to.
          </div>
        ) : (
          <div className="space-y-3">
            {instances.map((instance) => {
              const catalogItem = catalog.find((c) => c.slug === instance.slug);
              return (
                <McpServerRow
                  key={instance.id}
                  instance={instance}
                  catalogLabel={catalogItem?.label ?? instance.name}
                  description={catalogItem?.description ?? ''}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* ── Marketplace ───────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider">
          Marketplace
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {catalog.map((item) => (
            <McpAddForm key={item.slug} catalogItem={item} />
          ))}
        </div>
      </section>
    </div>
  );
}
