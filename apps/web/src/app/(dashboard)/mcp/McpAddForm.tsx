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
import { Trash } from '@phosphor-icons/react';
import { createMcpServerFromCatalogAction, type McpCatalogItem } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import TextInput from '@/components/ui/TextInput';
import TextArea from '@/components/ui/TextArea';
import FieldLabel from '@/components/ui/FieldLabel';
import McpAuthSchemePicker from '@/components/ui/McpAuthSchemePicker';
import { ModalFooter } from '@/components/ui/Modal.tsx';

interface Props {
  catalogItem: McpCatalogItem;
  /** Called after a successful connection so the parent modal can close. */
  onDone?: () => void;
  /** Closes the wrapping modal without connecting (the modal is
   *  non-dismissable while this draft form is open — see UX-B7). */
  onCancel?: () => void;
}

type AuthScheme = 'header' | 'query' | 'bearer';

interface EnvRow {
  key: string;
  value: string;
}

export default function McpAddForm({ catalogItem, onDone, onCancel }: Props) {
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
        <FieldLabel htmlFor={`mcp-name-${catalogItem.slug}`}>
          Name <span className="text-ink-4">(e.g. &quot;Cortex perso&quot;)</span>
        </FieldLabel>
        <TextInput
          id={`mcp-name-${catalogItem.slug}`}
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={catalogItem.label}
        />
      </div>

      {/* Server slug — custom only. Drives the tool-name prefix at runtime. */}
      {(isCustomHttp || isCustomStdio) && (
        <div>
          <FieldLabel htmlFor={`mcp-slug-${catalogItem.slug}`}>
            Server slug <span className="text-ink-4">(tool name prefix)</span>
          </FieldLabel>
          <TextInput
            id={`mcp-slug-${catalogItem.slug}`}
            type="text"
            required
            value={customSlug}
            onChange={(e) => setCustomSlug(e.target.value)}
            placeholder="my-server"
            pattern="[a-z0-9-]+"
            className="font-mono"
          />
          <p className="text-body-12 text-ink-4 mt-1">
            Tools will be named like <span className="font-mono text-ink-3">{slugPreview}</span>.
            Lowercase letters, digits, dashes.
          </p>
        </div>
      )}

      {/* HTTP-only: URL when catalog requires it. */}
      {needsUrl && (
        <div>
          <FieldLabel htmlFor={`mcp-url-${catalogItem.slug}`}>Server URL</FieldLabel>
          <TextInput
            id={`mcp-url-${catalogItem.slug}`}
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className="font-mono"
          />
        </div>
      )}

      {/* Custom HTTP: auth scheme picker. */}
      {isCustomHttp && (
        <div className="space-y-2">
          <p className="block text-xs text-ink-3">Auth scheme</p>
          <McpAuthSchemePicker
            name={`mcp-scheme-${catalogItem.slug}`}
            value={customAuthScheme}
            onChange={setCustomAuthScheme}
          />

          {customAuthScheme !== 'bearer' && (
            <div>
              <FieldLabel htmlFor={`mcp-auth-param-${catalogItem.slug}`}>
                {customAuthScheme === 'header' ? 'Header name' : 'Query param name'}
              </FieldLabel>
              <TextInput
                id={`mcp-auth-param-${catalogItem.slug}`}
                type="text"
                required
                value={customAuthParamName}
                onChange={(e) => setCustomAuthParamName(e.target.value)}
                placeholder={customAuthScheme === 'header' ? 'x-api-key' : 'api_key'}
                className="font-mono"
              />
            </div>
          )}
        </div>
      )}

      {/* HTTP-only: API key. */}
      {!isStdio && (
        <div>
          <FieldLabel htmlFor={`mcp-key-${catalogItem.slug}`}>API key</FieldLabel>
          <TextInput
            id={`mcp-key-${catalogItem.slug}`}
            type="password"
            required
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={catalogItem.keyPrefix[0] ? `${catalogItem.keyPrefix[0]}…` : ''}
            className="font-mono"
          />
          {catalogItem.docsHint && (
            <p className="text-body-12 text-ink-4 mt-1">{catalogItem.docsHint}</p>
          )}
        </div>
      )}

      {/* Pre-filled stdio: editable args (may contain placeholders) + env vars. */}
      {isPrefilledStdio && (
        <>
          <div>
            <FieldLabel htmlFor={`mcp-prefilled-args-${catalogItem.slug}`}>
              Arguments{' '}
              <span className="text-ink-4">
                (one per line, edit placeholders like &lt;root-directory&gt;)
              </span>
            </FieldLabel>
            <TextArea
              id={`mcp-prefilled-args-${catalogItem.slug}`}
              rows={Math.max(3, (catalogItem.args ?? []).length + 1)}
              value={prefilledArgsText}
              onChange={(e) => setPrefilledArgsText(e.target.value)}
              className="font-mono resize-none"
            />
            <p className="text-body-12 text-ink-4 mt-1">
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
                    <TextInput
                      type="text"
                      value={row.key}
                      onChange={(e) => updateEnvRow(idx, { key: e.target.value })}
                      placeholder="VAR_NAME"
                      containerClassName="flex-1"
                      className="font-mono"
                    />
                    <TextInput
                      type="password"
                      autoComplete="off"
                      value={row.value}
                      onChange={(e) => updateEnvRow(idx, { value: e.target.value })}
                      placeholder="value"
                      containerClassName="flex-1"
                      className="font-mono"
                    />
                    <RowActionButton
                      square
                      tone="danger"
                      onClick={() => removeEnvRow(idx)}
                      disabled={envRows.length === 1}
                      title="Remove variable"
                      icon={<Trash size={14} />}
                    />
                  </div>
                ))}
              </div>
              <RowActionButton onClick={addEnvRow} className="mt-2">
                + Add variable
              </RowActionButton>
            </div>
          )}

          {catalogItem.docsHint && <p className="text-body-12 text-ink-4">{catalogItem.docsHint}</p>}
        </>
      )}

      {/* Stdio custom: command + args + env vars. */}
      {isCustomStdio && (
        <>
          <div>
            <FieldLabel htmlFor={`mcp-command-${catalogItem.slug}`}>Command</FieldLabel>
            <TextInput
              id={`mcp-command-${catalogItem.slug}`}
              type="text"
              required
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              placeholder="npx"
              className="font-mono"
            />
            <p className="text-body-12 text-ink-4 mt-1">
              Executable name (resolved via PATH) or absolute path.
            </p>
          </div>

          <div>
            <FieldLabel htmlFor={`mcp-args-${catalogItem.slug}`}>
              Arguments <span className="text-ink-4">(one per line)</span>
            </FieldLabel>
            <TextArea
              id={`mcp-args-${catalogItem.slug}`}
              rows={3}
              value={customArgsText}
              onChange={(e) => setCustomArgsText(e.target.value)}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder'}
              className="font-mono resize-none"
            />
          </div>

          <div>
            <p className="block text-xs text-ink-3 mb-1">
              Environment variables <span className="text-ink-4">(encrypted at rest)</span>
            </p>
            <div className="space-y-2">
              {envRows.map((row, idx) => (
                <div key={idx} className="flex gap-2">
                  <TextInput
                    type="text"
                    value={row.key}
                    onChange={(e) => updateEnvRow(idx, { key: e.target.value })}
                    placeholder="GITHUB_TOKEN"
                    containerClassName="flex-1"
                    className="font-mono"
                  />
                  <TextInput
                    type="password"
                    autoComplete="off"
                    value={row.value}
                    onChange={(e) => updateEnvRow(idx, { value: e.target.value })}
                    placeholder="value"
                    containerClassName="flex-1"
                    className="font-mono"
                  />
                  <RowActionButton
                    square
                    tone="danger"
                    onClick={() => removeEnvRow(idx)}
                    disabled={envRows.length === 1}
                    title="Remove variable"
                    icon={<Trash size={14} />}
                  />
                </div>
              ))}
            </div>
            <RowActionButton onClick={addEnvRow} className="mt-2">
              + Add variable
            </RowActionButton>
            {catalogItem.docsHint && (
              <p className="text-body-12 text-ink-4 mt-2">{catalogItem.docsHint}</p>
            )}
          </div>
        </>
      )}

      <ModalFooter className="-mx-6 -mb-6 mt-2 rounded-b-xl">
        {onCancel && (
          <PrimaryButton variant="neutral" type="button" onClick={onCancel}>
            Cancel
          </PrimaryButton>
        )}
        <PrimaryButton variant="ink" type="submit" disabled={isPending || !name.trim()}>
          {isPending ? 'Connecting…' : 'Connect'}
        </PrimaryButton>
      </ModalFooter>
    </form>
  );
}
