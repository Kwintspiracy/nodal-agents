'use client';

// McpEditForm — edit the structural config of an existing MCP server.
//
// Self-contained: fetches the server's NON-SECRET config via
// getMcpServerConfigAction (slug/transport/url/auth/command/args/env KEYS —
// never secret values), prefills the form, and submits to
// updateMcpServerConfigAction. Secrets follow the rotate-key contract: the
// apiKey field and env value fields start BLANK and "leave blank = keep the
// stored value". The plaintext secret never leaves the server.
//
// slug and transport are immutable (the slug is the tool-name prefix; the
// transport drives the whole shape) — shown read-only.

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  getMcpServerConfigAction,
  updateMcpServerConfigAction,
  type McpServerConfig,
} from '@/lib/actions.ts';

type AuthScheme = 'header' | 'query' | 'bearer';
interface EnvRow {
  key: string;
  value: string;
}

interface Props {
  mcpServerId: string;
  /** Called after a successful update so the parent can refresh + collapse. */
  onDone?: () => void;
  onCancel?: () => void;
}

const INPUT =
  'w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none';

export default function McpEditForm({ mcpServerId, onDone, onCancel }: Props) {
  const [config, setConfig] = useState<McpServerConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authScheme, setAuthScheme] = useState<AuthScheme>('header');
  const [authParamName, setAuthParamName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getMcpServerConfigAction(mcpServerId);
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(res.message);
        return;
      }
      const c = res.data;
      setConfig(c);
      setName(c.name);
      setUrl(c.url ?? '');
      setAuthScheme(c.authScheme ?? 'header');
      setAuthParamName(c.authParamName ?? '');
      setCommand(c.command ?? '');
      setArgsText(c.args.join('\n'));
      setEnvRows(
        c.envKeys.length > 0
          ? c.envKeys.map((k) => ({ key: k, value: '' }))
          : [{ key: '', value: '' }],
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [mcpServerId]);

  if (loadError) {
    return (
      <div className="bg-paper border border-rule-2 rounded-xl px-5 py-4">
        <p className="text-xs text-err">{loadError}</p>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="bg-paper border border-rule-2 rounded-xl px-5 py-4">
        <p className="text-xs text-ink-4">Loading configuration…</p>
      </div>
    );
  }

  const isStdio = config.transport === 'stdio';

  function addEnvRow() {
    setEnvRows((p) => [...p, { key: '', value: '' }]);
  }
  function removeEnvRow(i: number) {
    setEnvRows((p) => p.filter((_, idx) => idx !== i));
  }
  function updateEnvRow(i: number, patch: Partial<EnvRow>) {
    setEnvRows((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const c = config;
    if (!c) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Name is required');
      return;
    }
    const payload: Record<string, unknown> = { name: trimmedName };

    if (c.transport === 'http') {
      const u = url.trim();
      if (!u) {
        toast.error('Server URL is required');
        return;
      }
      payload['url'] = u;
      payload['authScheme'] = authScheme;
      if (authScheme !== 'bearer') {
        const p = authParamName.trim();
        if (!p) {
          toast.error('Auth param name is required for this scheme');
          return;
        }
        payload['authParamName'] = p;
      }
      const k = apiKey.trim();
      if (k) payload['apiKey'] = k; // blank = keep existing
    } else {
      const cmd = command.trim();
      if (!cmd) {
        toast.error('Command is required');
        return;
      }
      payload['command'] = cmd;
      payload['args'] = argsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const env: Record<string, string> = {};
      for (const r of envRows) {
        const key = r.key.trim();
        if (!key) continue;
        env[key] = r.value; // blank value = keep existing stored value
      }
      payload['env'] = env;
    }

    startTransition(async () => {
      const res = await updateMcpServerConfigAction(c.id, payload);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success('Configuration updated');
      onDone?.();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-paper border border-rule-2 rounded-xl px-5 py-4 space-y-3"
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-ink-4 font-mono">
        <span>{config.slug}</span>
        <span>·</span>
        <span>{config.transport}</span>
      </div>

      {/* Name */}
      <div>
        <label htmlFor={`edit-name-${config.id}`} className="block text-xs text-ink-3 mb-1">
          Name
        </label>
        <input
          id={`edit-name-${config.id}`}
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={INPUT}
        />
      </div>

      {/* HTTP fields */}
      {!isStdio && (
        <>
          <div>
            <label htmlFor={`edit-url-${config.id}`} className="block text-xs text-ink-3 mb-1">
              Server URL
            </label>
            <input
              id={`edit-url-${config.id}`}
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className={`${INPUT} font-mono`}
            />
          </div>

          <div className="space-y-2">
            <p className="block text-xs text-ink-3">Auth scheme</p>
            <div className="flex flex-wrap gap-2">
              {(['header', 'query', 'bearer'] as const).map((scheme) => (
                <label
                  key={scheme}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs cursor-pointer border ${
                    authScheme === scheme
                      ? 'bg-hover border-ink-3 text-ink'
                      : 'bg-paper border-rule text-ink-3 hover:border-rule'
                  }`}
                >
                  <input
                    type="radio"
                    name={`edit-scheme-${config.id}`}
                    value={scheme}
                    checked={authScheme === scheme}
                    onChange={() => setAuthScheme(scheme)}
                    className="sr-only"
                  />
                  {scheme === 'header' ? 'Header' : scheme === 'query' ? 'Query param' : 'Bearer'}
                </label>
              ))}
            </div>
            {authScheme !== 'bearer' && (
              <div>
                <label
                  htmlFor={`edit-auth-param-${config.id}`}
                  className="block text-xs text-ink-3 mb-1"
                >
                  {authScheme === 'header' ? 'Header name' : 'Query param name'}
                </label>
                <input
                  id={`edit-auth-param-${config.id}`}
                  type="text"
                  required
                  value={authParamName}
                  onChange={(e) => setAuthParamName(e.target.value)}
                  placeholder={authScheme === 'header' ? 'x-api-key' : 'api_key'}
                  className={`${INPUT} font-mono`}
                />
              </div>
            )}
          </div>

          <div>
            <label htmlFor={`edit-key-${config.id}`} className="block text-xs text-ink-3 mb-1">
              API key
            </label>
            <input
              id={`edit-key-${config.id}`}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                config.apiKeyLast4
                  ? `•••• ${config.apiKeyLast4} — leave blank to keep`
                  : 'Paste a key'
              }
              className={`${INPUT} font-mono`}
            />
            <p className="text-[11px] text-ink-4 mt-1">
              Leave blank to keep the current key. The new config is verified against the live
              server before saving.
            </p>
          </div>
        </>
      )}

      {/* stdio fields */}
      {isStdio && (
        <>
          <div>
            <label htmlFor={`edit-command-${config.id}`} className="block text-xs text-ink-3 mb-1">
              Command
            </label>
            <input
              id={`edit-command-${config.id}`}
              type="text"
              required
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              className={`${INPUT} font-mono`}
            />
          </div>

          <div>
            <label htmlFor={`edit-args-${config.id}`} className="block text-xs text-ink-3 mb-1">
              Arguments <span className="text-ink-4">(one per line)</span>
            </label>
            <textarea
              id={`edit-args-${config.id}`}
              rows={Math.max(3, argsText.split('\n').length)}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              className={`${INPUT} font-mono resize-none`}
            />
          </div>

          <div>
            <p className="block text-xs text-ink-3 mb-1">
              Environment variables{' '}
              <span className="text-ink-4">(encrypted — leave value blank to keep)</span>
            </p>
            <div className="space-y-2">
              {envRows.map((row, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => updateEnvRow(idx, { key: e.target.value })}
                    placeholder="VAR_NAME"
                    className={`${INPUT} flex-1 font-mono`}
                  />
                  <input
                    type="password"
                    autoComplete="off"
                    value={row.value}
                    onChange={(e) => updateEnvRow(idx, { value: e.target.value })}
                    placeholder={config.envKeys.includes(row.key) ? 'leave blank to keep' : 'value'}
                    className={`${INPUT} flex-1 font-mono`}
                  />
                  <button
                    type="button"
                    onClick={() => removeEnvRow(idx)}
                    aria-label="Remove env var"
                    className="px-2 text-ink-3 hover:text-err"
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
        </>
      )}

      <div className="flex gap-2 items-center pt-1">
        <button
          type="submit"
          disabled={isPending || !name.trim()}
          className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
        >
          {isPending ? 'Verifying…' : 'Save changes'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-ink-3 hover:text-ink underline"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
