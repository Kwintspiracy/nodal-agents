// connector-access.test.ts — the grant decides what a connector may do.
//
// Pure rule, on synthetic operation lists of several shapes (one right, several
// rights, a broader right that also covers, no rights at all), so it holds for
// any provider and not only for the one that revealed the defect.

import { describe, it, expect } from 'vitest';
import {
  bindingRefusal,
  canonicalScope,
  connectorAccess,
  missingScopesOf,
  parseScopes,
  requiredScopes,
  unionScopes,
} from '../oauth/scopes';
import type { OperationDescriptor } from '../types/operation';

const op = (slug: string, scopes?: OperationDescriptor['scopes']): OperationDescriptor => ({
  slug,
  name: slug,
  risk: 'read',
  requiresApproval: false,
  ...(scopes ? { scopes } : {}),
});

// A mail-like provider: read, send, and a broad scope that covers both.
const READ = 'mail.read';
const SEND = 'mail.send';
const FULL = 'mail.full';
const MAIL_OPS = [
  op('list', [[READ, FULL]]),
  op('send', [[SEND, FULL]]),
  op('reply', [
    [READ, FULL],
    [SEND, FULL],
  ]),
];

describe('connector access from a grant @cap:connecter-un-service/moteur', () => {
  it('a grant holding every requested right is ready, with every operation granted', () => {
    expect(connectorAccess(MAIL_OPS, [READ, SEND, 'openid'])).toEqual({
      kind: 'ready',
      grantedOperations: ['list', 'send', 'reply'],
    });
  });

  it('a broader right the provider also accepts meets the requirement', () => {
    expect(connectorAccess(MAIL_OPS, [FULL]).kind).toBe('ready');
  });

  it('a partial grant withholds exactly the operations whose rights are missing', () => {
    expect(connectorAccess(MAIL_OPS, [READ])).toEqual({
      kind: 'needs_access',
      grantedOperations: ['list'],
      missingOperations: ['send', 'reply'],
      missingScopes: [SEND],
    });
  });

  it('an operation needing two rights is withheld when one of them is missing', () => {
    expect(missingScopesOf(MAIL_OPS[2]!, [SEND])).toEqual([READ]);
    expect(missingScopesOf(MAIL_OPS[2]!, [READ, SEND])).toEqual([]);
  });

  it('a grant for another service covers nothing and the binding is refused, naming the rights', () => {
    const access = connectorAccess(MAIL_OPS, ['files.all', 'openid']);
    expect(access.kind).toBe('needs_access');
    expect(bindingRefusal(access)).toEqual({ missingScopes: [READ, SEND] });
  });

  it('a partial grant binds: what it covers is usable, the rest stays needs_access', () => {
    expect(bindingRefusal(connectorAccess(MAIL_OPS, [READ]))).toBeNull();
  });

  it('a connector whose operations need no right (API key, capability-based OAuth) is ready on any grant', () => {
    const ops = [op('search'), op('create')];
    expect(connectorAccess(ops, [])).toEqual({
      kind: 'ready',
      grantedOperations: ['search', 'create'],
    });
    expect(bindingRefusal(connectorAccess(ops, []))).toBeNull();
  });

  it('the rights a connector requires are the union of what its operations ask for', () => {
    expect(requiredScopes(MAIL_OPS)).toEqual([READ, SEND]);
    expect(requiredScopes([op('a'), op('b', [['x', 'y']])])).toEqual(['x']);
  });
});

describe('grant parsing and union', () => {
  it('reads the provider scope string, whatever the whitespace', () => {
    expect(parseScopes(' a  b\tc ')).toEqual(['a', 'b', 'c']);
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
  });

  it('keeps first-seen order without duplicates', () => {
    expect(unionScopes(['a', 'b'], ['b', 'c'], ['a'])).toEqual(['a', 'b', 'c']);
  });
});

describe('the form in which a provider writes what it granted @cap:connecter-un-service/moteur', () => {
  // A provider that writes a permission with or without its resource prefix,
  // in any case (what Microsoft documents), declares it as data.
  const MS = { resourcePrefix: 'https://graph.microsoft.com/', caseInsensitive: true };
  const OPS = [
    op('read', [
      ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Read'],
    ]),
    op('send', [['https://graph.microsoft.com/Mail.Send']]),
  ];

  it('a short-form, differently-cased, percent-encoded grant meets the prefixed requirement', () => {
    expect(
      connectorAccess(OPS, ['https%3A%2F%2Fgraph.microsoft.com%2Fmail.read', 'Mail.Send'], MS),
    ).toEqual({
      kind: 'ready',
      grantedOperations: ['read', 'send'],
    });
  });

  it('the missing scope is still named as it is asked for', () => {
    const access = connectorAccess(OPS, ['mail.read'], MS);
    expect(access.kind === 'needs_access' && access.missingScopes).toEqual([
      'https://graph.microsoft.com/Mail.Send',
    ]);
  });

  it('without a declared form, scopes compare exactly (RFC 6749 §3.3): another case does not match', () => {
    const google = [op('list', [['https://www.googleapis.com/auth/gmail.readonly']])];
    expect(connectorAccess(google, ['https://www.googleapis.com/auth/GMAIL.READONLY']).kind).toBe(
      'needs_access',
    );
    expect(canonicalScope('https://www.googleapis.com/auth/drive')).toBe(
      'https://www.googleapis.com/auth/drive',
    );
  });
});
