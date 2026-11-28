// connector-scopes.test.ts — one declaration of a connector's rights.
//
// Every operation of every connector names the OAuth rights its calls need
// (`OperationDescriptor.scopes`, read from the provider's API reference). From
// that single declaration:
//   - the provider entry of each OAuth connector must request every one of
//     them (it is what the start route asks for), for EVERY adapter of the
//     registry, whatever the provider;
//   - an OAuth connector whose provider has scopes declares them on every
//     operation, so a new operation cannot ship without saying what it needs;
//   - an OAuth provider without scopes (Notion's capability model) declares
//     none, so no operation is withheld by a rule that cannot apply. API-key
//     connectors store no grant: their operations are never judged by it.

import { describe, it, expect } from 'vitest';
import {
  CONNECTOR_CATALOG,
  getOAuthProvider,
  requiredScopes,
  type OperationDescriptor,
} from '@nodal-agents/shared';
import { ADAPTER_REGISTRY } from '../registry.ts';
import { connectorAccessFor } from '../connector-access.ts';

const entries = Object.entries(ADAPTER_REGISTRY);
const oauthEntries = entries.filter(([, e]) => e.credentialType !== 'api_key');

describe('connector rights come from the operations @cap:connecter-un-service/moteur', () => {
  it.each(oauthEntries.map(([slug]) => slug))(
    '%s: the provider entry requests every right its operations need',
    (slug) => {
      const provider = getOAuthProvider(slug);
      expect(provider, `${slug} is an OAuth adapter with no provider entry`).not.toBeNull();
      const requested = new Set(provider!.scopes);
      const notRequested = requiredScopes(ADAPTER_REGISTRY[slug]!.operations).filter(
        (s) => !requested.has(s),
      );
      expect(
        notRequested,
        `${slug} operations need scopes its provider entry never asks for`,
      ).toEqual([]);
    },
  );

  it.each(oauthEntries.map(([slug]) => slug))(
    '%s: the provider entry asks for nothing beyond its operations and the account',
    (slug) => {
      const provider = getOAuthProvider(slug)!;
      const allowed = new Set([
        ...provider.accountScopes,
        ...requiredScopes(ADAPTER_REGISTRY[slug]!.operations),
      ]);
      expect(
        provider.scopes.filter((s) => !allowed.has(s)),
        `${slug} asks for unused scopes`,
      ).toEqual([]);
    },
  );

  it.each(oauthEntries.map(([slug]) => slug))(
    '%s: every operation declares its rights when the provider has scopes',
    (slug) => {
      const provider = getOAuthProvider(slug)!;
      const ops = ADAPTER_REGISTRY[slug]!.operations;
      const undeclared = ops
        .filter((op: OperationDescriptor) => (op.scopes ?? []).length === 0)
        .map((op) => op.slug);
      if (provider.scopes.length === 0) {
        // Rights live outside OAuth scopes (Notion: integration capabilities).
        expect(ops.filter((op) => op.scopes !== undefined).map((op) => op.slug)).toEqual([]);
      } else {
        expect(undeclared, `${slug} operations without a declared right`).toEqual([]);
      }
    },
  );

  it('every OAuth connector of the catalog has an adapter and a provider entry of its type', () => {
    for (const c of CONNECTOR_CATALOG.filter((c) => c.authType === 'oauth2')) {
      expect(ADAPTER_REGISTRY[c.slug], `${c.slug}: no adapter`).toBeDefined();
      expect(getOAuthProvider(c.slug)?.credentialType, `${c.slug}: provider type`).toBe(
        c.credentialType,
      );
    }
  });

  it('the entries of one credential type share the token endpoint the refresh reads by type', () => {
    const byType = new Map<string, string>();
    for (const c of CONNECTOR_CATALOG.filter((c) => c.authType === 'oauth2')) {
      const p = getOAuthProvider(c.slug)!;
      const token = JSON.stringify([p.tokenUrl, p.tokenAuth, p.tokenBodyType, p.supportsRefresh]);
      const seen = byType.get(p.credentialType);
      if (seen === undefined) byType.set(p.credentialType, token);
      else expect(token, `${c.slug} differs from its type's token endpoint`).toBe(seen);
    }
  });

  it("a grant of exactly the provider entry's scopes makes every OAuth connector ready", () => {
    for (const [slug] of oauthEntries) {
      expect(connectorAccessFor(slug, getOAuthProvider(slug)!.scopes).kind, slug).toBe('ready');
    }
  });
});
