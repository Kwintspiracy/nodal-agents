import { describe, expect, it } from 'vitest';
import {
  forwardSubject,
  parseMailAddressList,
  replySubject,
  resolveMailBodyFormat,
  resolveReplyRecipients,
} from '../mail-contract';

const me = { name: 'Me', address: 'me@example.com' };
const alias = { address: 'Me.Alias@Example.com' };
const ann = { name: 'Ann', address: 'ann@example.com' };
const bob = { address: 'bob@example.com' };
const cat = { name: 'Cat', address: 'cat@example.com' };
const own = ['me@example.com', 'me.alias@example.com'];

function addrs(list: Array<{ address: string }>): string[] {
  return list.map((a) => a.address.toLowerCase());
}

describe('mail contract — reply recipients @cap:connecter-un-service/moteur', () => {
  it('answers the sender when there is no Reply-To', () => {
    const r = resolveReplyRecipients(
      { from: [ann], replyTo: [], to: [me, bob], cc: [] },
      own,
      false,
    );
    expect(r).toEqual({ to: [ann], cc: [] });
  });

  it('answers the Reply-To before the From', () => {
    const r = resolveReplyRecipients({ from: [bob], replyTo: [cat], to: [me], cc: [] }, own, false);
    expect(addrs(r.to)).toEqual(['cat@example.com']);
  });

  it("answers the recipients of one's own message, whatever the case or alias it was sent from", () => {
    const r = resolveReplyRecipients(
      { from: [alias], replyTo: [], to: [bob, me], cc: [cat] },
      own,
      false,
    );
    expect(addrs(r.to)).toEqual(['bob@example.com']);
    expect(r.cc).toEqual([]);
  });

  it('reply to all: the other participants in Cc, oneself and duplicates removed', () => {
    const r = resolveReplyRecipients(
      { from: [ann], replyTo: [], to: [me, bob, ann], cc: [cat, { address: 'BOB@example.com' }] },
      own,
      true,
    );
    expect(addrs(r.to)).toEqual(['ann@example.com']);
    expect(addrs(r.cc)).toEqual(['bob@example.com', 'cat@example.com']);
  });

  it('a reply whose only other party sits in Cc goes To that party', () => {
    const r = resolveReplyRecipients({ from: [me], replyTo: [], to: [me], cc: [bob] }, own, true);
    expect(addrs(r.to)).toEqual(['bob@example.com']);
    expect(r.cc).toEqual([]);
  });

  it('fails loud when nobody but oneself would receive the reply', () => {
    expect(() =>
      resolveReplyRecipients({ from: [me], replyTo: [], to: [me], cc: [] }, own, true),
    ).toThrow(/no recipient/);
  });
});

describe('mail contract — addresses, subjects, body format @cap:connecter-un-service/moteur', () => {
  it('parses an RFC 5322 list: quoted comma in a name, non-ASCII names, bare addresses', () => {
    expect(
      parseMailAddressList('"Doe, Jane" <jane@acme.com>, Zoé Lefèvre <zoe@x.fr>,bob@y.com'),
    ).toEqual([
      { name: 'Doe, Jane', address: 'jane@acme.com' },
      { name: 'Zoé Lefèvre', address: 'zoe@x.fr' },
      { address: 'bob@y.com' },
    ]);
  });

  it('returns no address for an empty value and fails loud on a word that is no address', () => {
    expect(parseMailAddressList(undefined)).toEqual([]);
    expect(parseMailAddressList('  ')).toEqual([]);
    expect(() => parseMailAddressList('Jane')).toThrow(/not an e-mail address/);
  });

  it('prefixes subjects once', () => {
    expect(replySubject('Plan')).toBe('Re: Plan');
    expect(replySubject('RE: Plan')).toBe('RE: Plan');
    expect(forwardSubject('Plan')).toBe('Fwd: Plan');
    expect(forwardSubject('Fw: Plan')).toBe('Fw: Plan');
  });

  it('defaults the body format to text, never to a guess', () => {
    expect(resolveMailBodyFormat(undefined)).toBe('text');
    expect(resolveMailBodyFormat('html')).toBe('html');
  });
});
