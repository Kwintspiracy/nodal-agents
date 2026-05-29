'use client';

// McpAddForm — form rendered directly inside a Modal panel for a single MCP catalog entry.
//
// Three flavors of form, chosen by the catalog entry's slug + transport:
//
//   1. Standard HTTP (cogni-cortex, stripe, composio, …):
//      Name + API key, plus URL when `serverUrl` is null (per-account
//      hosted servers like Composio).
//
//   2. Custom HTTP (`slug === 'custom-http-mcp'`):
//      Name + Server slug + URL + Auth scheme (radio) + Auth param name
//      (conditional on scheme) + API key. The Server slug becomes the
//      tool-name prefix at runtime so the user controls it.
//
//   3. Custom stdio (`slug === 'custom-stdio-mcp'`):
//      Name + Server slug + Command + Args (one per line) + Env vars
//      (repeater). NO api key field — secrets live in env vars (which
//      are encrypted at rest via the same master key as the API tokens).
//
// All three submit to `createMcpServerFromCatalogAction` which routes on
// the catalog slug. Form fields are sent verbatim; the action does the
// validation, slug-uniqueness check, and verify-on-connect roundtrip.

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createMcpServerFromCatalogAction, type McpCatalogItem } from '@/lib/actions.ts';

interface Props {
  catalogItem: McpCatalogItem;
  /** Called after a successful connection so the parent modal can close. */
  onDone?: () => void;
}

type AuthScheme = 'header' | 'query' | 'bearer';

interface EnvRow {
  key: string;
  value: string;
}

export default function McpAddForm({ catalogItem, onDone }: Props) {
  const [isPending, startTransition] = useTransition();

  // Common
  const [name, setName] = useState('');

  // HTTP-shared
  const [apiKey, setApiKey] = useState('');
  const [url, setUrl] = useState('');

  // Custom-shared
  const [customSlug, setCustomSlug] = useState('');

  // HTTP custom
  const [customAuthScheme, setCustomAuthScheme] = useState<AuthScheme>('header');
  const [customAuthParamName, setCustomAuthParamName] = useState('');

  // Stdio custom (custom-stdio-mcp sentinel only)
  const [customCommand, setCustomCommand] = useState('');
  const [customArgsText, setCustomArgsText] = useState('');
  // Stdio pre-filled: args are editable (user may need to fill placeholders)
  const [prefilledArgsText, setPrefilledArgsText] = useState(() =>
    (catalogItem.args ?? []).join('\n'),
  );
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => {
    // Pre-seed env var rows from envVarNames if present
    const names = catalogItem.envVarNames ?? [];
    return names.length > 0 ? names.map((k) => ({ key: k, value: '' })) : [{ key: '', value: '' }];
  });

  // ── Flavor flags ───────────────────────────────────────────────────────────
  const isCustomHttp = catalogItem.slug === 'custom-http-mcp';
  const isCustomStdio = catalogItem.slug === 'custom-stdio-mcp';
  const isStdio = catalogItem.transport === 'stdio';
  // Pre-filled stdio: a catalog entry with command/args pre-set (not custom).
  const isPrefilledStdio = isStdio && !isCustomStdio;
  const needsUrl = !isStdio && catalogItem.serverUrl === null;

  function resetForm() {
    setName('');
    setApiKey('');
    setUrl('');
    setCustomSlug('');
    setCustomAuthScheme('header');
    setCustomAuthParamName('');
    setCustomCommand('');
    setCustomArgsText('');
    setPrefilledArgsText((catalogItem.args ?? []).join('\n'));
    const names = catalogItem.envVarNames ?? [];
    setEnvRows(
      names.length > 0 ? names.map((k) => ({ key: k, value: '' })) : [{ key: '', value: '' }],
    );
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Name is required');
      return;
    }

    if (isPrefilledStdio) {
      // ── Pre-filled stdio catalog entry ────────────────────────────────────
      // command + args come from the catalog (user may have edited args to
      // fill in placeholders like <root-directory>). No slug input needed —
      // the catalog slug is used directly.
      const argList = prefilledArgsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const envMap: Record<string, string> = {};
      for (const r of envRows) {
        const k = r.key.trim();
        if (!k) continue;
        envMap[k] = r.value;
      }
      startTransition(async () => {
        const res = await createMcpServerFromCatalogAction({
          slug: catalogItem.slug,
          name: trimmedName,
          customArgs: argList,
          customEnv: Object.keys(envMap).length > 0 ? envMap : undefined,
        });
        if (!res.ok) {
          toast.error(res.message);
          return;
        }
        toast.success(`${trimmedName} connected`);
        resetForm();
        onDone?.();
      });
      return;
    }

    if (isCustomStdio) {
      // ── Custom stdio ──────────────────────────────────────────────────────
      const slug = customSlug.trim();
      const cmd = customCommand.trim();
      if (!slug) return toast.error('Server slug is required');
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return toast.error('Slug must be lowercase letters, digits, dashes');
      }
      if (!cmd) return toast.error('Command is required');
      const argList = customArgsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const envMap: Record<string, string> = {};
      for (const r of envRows) {
        const k = r.key.trim();
        if (!k) continue;
        envMap[k] = r.value;
      }
      startTransition(async () => {
        const res = await createMcpServerFromCatalogAction({
          slug: catalogItem.slug,
          name: trimmedName,
          customSlug: slug,
          customCommand: cmd,
          customArgs: argList,
          customEnv: envMap,
        });
        if (!res.ok) {
          toast.error(res.message);
          return;
        }
        toast.success(`${trimmedName} connected`);
        resetForm();
        onDone?.();
      });
      return;
    }

    // ── HTTP (standard or custom) ──────────────────────────────────────────
    const trimmedKey = apiKey.trim();
    const trimmedUrl = url.trim();
    if (!trimmedKey) {
      toast.error('API key is required');
      return;
    }
    if (needsUrl && !trimmedUrl) {
      toast.error('Server URL is required');
      return;
    }

    if (isCustomHttp) {
      const slug = customSlug.trim();
      if (!slug) return toast.error('Server slug is required');
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return toast.error('Slug must be lowercase letters, digits, dashes');
      }
      if (customAuthScheme !== 'bearer' && !customAuthParamName.trim()) {
        return toast.error('Auth param name is required for this scheme');
      }
    }

    startTransition(async () => {
      const payload: Record<string, unknown> = {
        slug: catalogItem.slug,
        name: trimmedName,
        apiKey: trimmedKey,
      };
      if (needsUrl) payload['url'] = trimmedUrl;
      if (isCustomHttp) {
        payload['customSlug'] = customSlug.trim();
        payload['customAuthScheme'] = customAuthScheme;
        if (customAuthScheme !== 'bearer') {
          payload['customAuthParamName'] = customAuthParamName.trim();
        }
      }
      const res = await createMcpServerFromCatalogAction(payload);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(`${trimmedName} connected`);
      resetForm();
      onDone?.();
    });
  }

  function addEnvRow() {
    setEnvRows((prev) => [...prev, { key: '', value: '' }]);
  }
  function removeEnvRow(idx: number) {
    setEnvRows((prev) => prev.filter((_, i) => i !== idx));
  }
  function updateEnvRow(idx: number, patch: Partial<EnvRow>) {
    setEnvRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  // Tool-prefix preview shown under the slug input. Mirrors
  // `slugToPrefix` in packages/adapters/mcp/src/tools.ts (hyphens → underscores).
  const slugPreview = customSlug.trim()
    ? `${customSlug.trim().replace(/-/g, '_')}__list_things`
    : 'my_slug__list_things';

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {catalogItem.description && <p className="text-xs text-ink-4">{catalogItem.description}</p>}

      {/* Name — common to all flavors. */}
      <div>
        <label htmlFor={`mcp-name-${catalogItem.slug}`} className="block text-xs text-ink-3 mb-1">
          Name <span className="text-ink-4">(e.g. &quot;Cortex — perso&quot;)</span>
        </label>
        <input
          id={`mcp-name-${catalogItem.slug}`}
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={catalogItem.label}
          className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
        />
      </div>

      {/* Server slug — custom only. Drives the tool-name prefix at runtime. */}
      {(isCustomHttp || isCustomStdio) && (
        <div>
          <label htmlFor={`mcp-slug-${catalogItem.slug}`} className="block text-xs text-ink-3 mb-1">
            Server slug <span className="text-ink-4">(tool name prefix)</span>
          </label>
          <input
            id={`mcp-slug-${catalogItem.slug}`}
            type="text"
            required
            value={customSlug}
            onChange={(e) => setCustomSlug(e.target.value)}
            placeholder="my-server"
            pattern="[a-z0-9-]+"
            className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
          />
          <p className="text-[11px] text-ink-4 mt-1">
            Tools will be named like <span className="font-mono text-ink-3">{slugPreview}</span>.
            Lowercase letters, digits, dashes.
          </p>
        </div>
      )}

      {/* HTTP-only: URL when catalog requires it. */}
      {needsUrl && (
        <div>
          <label htmlFor={`mcp-url-${catalogItem.slug}`} className="block text-xs text-ink-3 mb-1">
            Server URL
          </label>
          <input
            id={`mcp-url-${catalogItem.slug}`}
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
          />
        </div>
      )}

      {/* Custom HTTP: auth scheme picker. */}
      {isCustomHttp && (
        <div className="space-y-2">
          <p className="block text-xs text-ink-3">Auth scheme</p>
          <div className="flex flex-wrap gap-2">
            {(['header', 'query', 'bearer'] as const).map((scheme) => (
              <label
                key={scheme}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs cursor-pointer border ${
                  customAuthScheme === scheme
                    ? 'bg-hover border-ink-3 text-ink'
                    : 'bg-paper border-rule text-ink-3 hover:border-rule'
                }`}
              >
                <input
                  type="radio"
                  name={`mcp-scheme-${catalogItem.slug}`}
                  value={scheme}
                  checked={customAuthScheme === scheme}
                  onChange={() => setCustomAuthScheme(scheme)}
                  className="sr-only"
                />
                {scheme === 'header' ? 'Header' : scheme === 'query' ? 'Query param' : 'Bearer'}
              </label>
            ))}
          </div>

          {customAuthScheme !== 'bearer' && (
            <div>
              <label
                htmlFor={`mcp-auth-param-${catalogItem.slug}`}
                className="block text-xs text-ink-3 mb-1"
              >
                {customAuthScheme === 'header' ? 'Header name' : 'Query param name'}
              </label>
              <input
                id={`mcp-auth-param-${catalogItem.slug}`}
                type="text"
                required
                value={customAuthParamName}
                onChange={(e) => setCustomAuthParamName(e.target.value)}
                placeholder={customAuthScheme === 'header' ? 'x-api-key' : 'api_key'}
                className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
              />
            </div>
          )}
        </div>
      )}

      {/* HTTP-only: API key. */}
      {!isStdio && (
        <div>
          <label htmlFor={`mcp-key-${catalogItem.slug}`} className="block text-xs text-ink-3 mb-1">
            API key
          </label>
          <input
            id={`mcp-key-${catalogItem.slug}`}
            type="password"
            required
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={catalogItem.keyPrefix[0] ? `${catalogItem.keyPrefix[0]}…` : ''}
            className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
          />
          {catalogItem.docsHint && (
            <p className="text-[11px] text-ink-4 mt-1">{catalogItem.docsHint}</p>
          )}
        </div>
      )}

      {/* Pre-filled stdio: editable args (may contain placeholders) + env vars. */}
      {isPrefilledStdio && (
        <>
          <div>
            <label
              htmlFor={`mcp-prefilled-args-${catalogItem.slug}`}
              className="block text-xs text-ink-3 mb-1"
            >
              Arguments{' '}
              <span className="text-ink-4">
                (one per line — edit placeholders like &lt;root-directory&gt;)
              </span>
            </label>
            <textarea
              id={`mcp-prefilled-args-${catalogItem.slug}`}
              rows={Math.max(3, (catalogItem.args ?? []).length + 1)}
              value={prefilledArgsText}
              onChange={(e) => setPrefilledArgsText(e.target.value)}
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono resize-none"
            />
            <p className="text-[11px] text-ink-4 mt-1">
              Command: <span className="font-mono text-ink-3">{catalogItem.command ?? 'npx'}</span>
            </p>
          </div>

          {(catalogItem.envVarNames ?? []).length > 0 && (
            <div>
              <p className="block text-xs text-ink-3 mb-1">
                Environment variables <span className="text-ink-4">(encrypted at rest)</span>
              </p>
              <div className="space-y-2">
                {envRows.map((row, idx) => (
                  <div key={idx} className="flex gap-2">
                    <input
                      type="text"
                      value={row.key}
                      onChange={(e) => updateEnvRow(idx, { key: e.target.value })}
                      placeholder="VAR_NAME"
                      className="flex-1 bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
                    />
                    <input
                      type="password"
                      autoComplete="off"
                      value={row.value}
                      onChange={(e) => updateEnvRow(idx, { value: e.target.value })}
                      placeholder="value"
                      className="flex-1 bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => removeEnvRow(idx)}
                      disabled={envRows.length === 1}
                      aria-label="Remove env var"
                      className="px-2 text-ink-3 hover:text-err disabled:opacity-30"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={addEnvRow}
                className="mt-2 text-[11px] text-ink-3 hover:text-ink"
              >
                + Add variable
              </button>
            </div>
          )}

          {catalogItem.docsHint && <p className="text-[11px] text-ink-4">{catalogItem.docsHint}</p>}
        </>
      )}

      {/* Stdio custom: command + args + env vars. */}
      {isCustomStdio && (
        <>
          <div>
            <label
              htmlFor={`mcp-command-${catalogItem.slug}`}
              className="block text-xs text-ink-3 mb-1"
            >
              Command
            </label>
            <input
              id={`mcp-command-${catalogItem.slug}`}
              type="text"
              required
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              placeholder="npx"
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
            />
            <p className="text-[11px] text-ink-4 mt-1">
              Executable name (resolved via PATH) or absolute path.
            </p>
          </div>

          <div>
            <label
              htmlFor={`mcp-args-${catalogItem.slug}`}
              className="block text-xs text-ink-3 mb-1"
            >
              Arguments <span className="text-ink-4">(one per line)</span>
            </label>
            <textarea
              id={`mcp-args-${catalogItem.slug}`}
              rows={3}
              value={customArgsText}
              onChange={(e) => setCustomArgsText(e.target.value)}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder'}
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono resize-none"
            />
          </div>

          <div>
            <p className="block text-xs text-ink-3 mb-1">
              Environment variables <span className="text-ink-4">(encrypted at rest)</span>
            </p>
            <div className="space-y-2">
              {envRows.map((row, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => updateEnvRow(idx, { key: e.target.value })}
                    placeholder="GITHUB_TOKEN"
                    className="flex-1 bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
                  />
                  <input
                    type="password"
                    autoComplete="off"
                    value={row.value}
                    onChange={(e) => updateEnvRow(idx, { value: e.target.value })}
                    placeholder="value"
                    className="flex-1 bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => removeEnvRow(idx)}
                    disabled={envRows.length === 1}
                    aria-label="Remove env var"
                    className="px-2 text-ink-3 hover:text-err disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addEnvRow}
              className="mt-2 text-[11px] text-ink-3 hover:text-ink"
            >
              + Add variable
            </button>
            {catalogItem.docsHint && (
              <p className="text-[11px] text-ink-4 mt-2">{catalogItem.docsHint}</p>
            )}
          </div>
        </>
      )}

      <button
        type="submit"
        disabled={isPending || !name.trim()}
        className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
      >
        {isPending ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  );
}
