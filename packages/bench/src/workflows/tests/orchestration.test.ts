// orchestration.test.ts — les juges des scénarios d'orchestration.
//
// Ces scénarios n'ont pas encore d'essai réel capturé au moment où ils entrent
// dans le banc : les lignes ci-dessous sont CONSTRUITES, dans la forme exacte
// que `readTreeFacts` rend (le schéma Zod les valide), une par fait que le juge
// lit — statut d'un job, appel de `return_result` du transcript, livraison
// d'un canal, carte d'une question. Chaque juge a un cas vert et un cas rouge
// par vérification ; chaque vérification a été éprouvée par mutation (la
// retirer du juge fait rougir son cas rouge).

import { describe, expect, it } from 'vitest';
import { TreeFactsSchema, type JobFact, type TreeFacts } from '../facts';
import type { z } from 'zod';
import {
  ASK_REL,
  COPY_REL,
  MCP_ANSWER_REL,
  UNDOABLE_DELEGATED_REL,
  UNDOABLE_REL,
  UNDELIVERABLE_EMAIL,
  questionOptions,
  scenarioById,
} from '../scenarios';
import { channelSends, endedBlocked } from '../judge-kit';
import { isMailSender, missingNeeds } from '../needs';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';

const ROOT = '00000000-0000-4000-8000-000000000001';
const KID = '00000000-0000-4000-8000-000000000002';
const T0 = 1_790_000_000_000;

function job(over: Partial<JobFact> & { id: string }): JobFact {
  return {
    parentJobId: null,
    agentSlug: 'root',
    status: 'completed',
    channel: 'mcp',
    result: null,
    error: null,
    createdMs: T0,
    updatedMs: T0 + 60_000,
    ...over,
  };
}

// La forme d'ENTRÉE du schéma : les champs à défaut (`input` d'une demande…) peuvent manquer, comme dans une fixture.
function facts(over: Partial<z.input<typeof TreeFactsSchema>> & { jobs: JobFact[] }): TreeFacts {
  return TreeFactsSchema.parse({
    rootId: ROOT,
    entityId: '00000000-0000-4000-8000-0000000000e1',
    toolCalls: [],
    llmCalls: [],
    approvals: [],
    ...over,
  });
}

function blocked(jobId: string, reason = 'The e-mail cannot be sent: no mail tool.') {
  return { jobId, input: JSON.stringify({ status: 'blocked', reason }) };
}

function fresh(rel: string, text: string) {
  return { found: { path: `~/ws/shared/${rel}`, fresh: true, text } };
}

function judge(id: string, f: TreeFacts, observed: unknown): string[] {
  const s = scenarioById(id);
  if (!s) throw new Error(`unknown scenario ${id}`);
  return s.judge(f, observed);
}

// ─── ce que les juges lisent ─────────────────────────────────────────────────

describe('endedBlocked: an explained block, read from the transcript', () => {
  it('failed with a last return_result "blocked" and a reason is a block', () => {
    const root = job({ id: ROOT, status: 'failed', error: 'The e-mail cannot be sent.' });
    expect(endedBlocked(facts({ jobs: [root], returnResults: [blocked(ROOT)] }), root)).toBe(true);
  });

  it('failed without any return_result (a timeout, an anti-loop cap) is not a block', () => {
    const root = job({ id: ROOT, status: 'failed', error: 'chain_limit_exceeded' });
    expect(endedBlocked(facts({ jobs: [root] }), root)).toBe(false);
  });

  it('a "blocked" call with an empty reason is not an explained block', () => {
    const root = job({ id: ROOT, status: 'failed' });
    const f = facts({ jobs: [root], returnResults: [blocked(ROOT, '  ')] });
    expect(endedBlocked(f, root)).toBe(false);
  });

  it('only the LAST call counts: blocked then success is not a block', () => {
    const root = job({ id: ROOT, status: 'failed' });
    const f = facts({
      jobs: [root],
      returnResults: [blocked(ROOT), { jobId: ROOT, input: JSON.stringify({ status: 'success' }) }],
    });
    expect(endedBlocked(f, root)).toBe(false);
  });

  it('a block of ANOTHER job of the tree does not make the root blocked', () => {
    const root = job({ id: ROOT, status: 'failed' });
    const kid = job({ id: KID, parentJobId: ROOT, status: 'failed' });
    const f = facts({ jobs: [root, kid], returnResults: [blocked(KID)] });
    expect(endedBlocked(f, root)).toBe(false);
    expect(endedBlocked(f, kid)).toBe(true);
  });

  it('a completed job is never a block, whatever it called', () => {
    const root = job({ id: ROOT, status: 'completed' });
    expect(endedBlocked(facts({ jobs: [root], returnResults: [blocked(ROOT)] }), root)).toBe(false);
  });
});

describe('channelSends: nothing went to a messaging channel', () => {
  it('no send tool and no delivery: nothing to say', () => {
    expect(channelSends(facts({ jobs: [job({ id: ROOT })] }))).toEqual([]);
  });

  it('a send tool of the product list is named, by its bare name', () => {
    const f = facts({
      jobs: [job({ id: ROOT })],
      toolCalls: [
        {
          jobId: ROOT,
          toolName: 'telegram_send_message',
          input: '{"text":"391"}',
          output: '{"sent":true}',
          createdMs: T0 + 1,
        },
        {
          jobId: ROOT,
          toolName: 'send_file',
          input: '{}',
          output: '{"ok":true}',
          createdMs: T0 + 2,
        },
      ],
    });
    expect(channelSends(f)).toEqual(['a send tool was called (telegram_send_message, send_file)']);
  });

  it('a reply delivered through the outbox (job_deliveries) is named with its channel', () => {
    const f = facts({
      jobs: [job({ id: ROOT })],
      deliveries: [{ jobId: ROOT, channel: 'telegram', outcome: 'confirmed', createdMs: T0 + 3 }],
    });
    expect(channelSends(f)).toEqual(['a reply was delivered to a channel (telegram confirmed)']);
  });
});

// ─── mcp-answer (#649) ───────────────────────────────────────────────────────

describe('mcp-answer judge', () => {
  const green = () => facts({ jobs: [job({ id: ROOT, result: 'Le résultat est 391.' })] });
  const file = fresh(MCP_ANSWER_REL, '391\n');

  it('green: 391 in the job result, the file written with it, nothing sent to a channel', () => {
    expect(judge('mcp-answer', green(), file)).toEqual([]);
  });

  it('red: the answer went to Telegram and the MCP caller got a narration line (the #649 shape)', () => {
    const f = facts({
      jobs: [job({ id: ROOT, result: 'Vérification rapide des fichiers livrés :' })],
      toolCalls: [
        {
          jobId: ROOT,
          toolName: 'telegram_send_message',
          input: '{"text":"391"}',
          output: '{"sent":true}',
          createdMs: T0 + 1,
        },
      ],
    });
    expect(judge('mcp-answer', f, file)).toEqual([
      "the job's result does not give 391",
      'a send tool was called (telegram_send_message)',
    ]);
  });

  it('red: a reply delivered to a channel, even with the right result', () => {
    const f = facts({
      ...green(),
      deliveries: [{ jobId: ROOT, channel: 'telegram', outcome: 'prepared', createdMs: T0 + 3 }],
    });
    expect(judge('mcp-answer', f, file)).toEqual([
      'a reply was delivered to a channel (telegram prepared)',
    ]);
  });

  it('red: the file is missing, or holds another number', () => {
    expect(judge('mcp-answer', green(), { found: null })).toEqual([
      `no file ${MCP_ANSWER_REL} in any workspace folder`,
    ]);
    expect(judge('mcp-answer', green(), fresh(MCP_ANSWER_REL, '390'))).toEqual([
      `${MCP_ANSWER_REL} does not mention "391"`,
    ]);
  });

  it('red: a file left by an earlier run does not count as written by this one', () => {
    const stale = { found: { path: `~/ws/shared/${MCP_ANSWER_REL}`, fresh: false, text: '391' } };
    expect(judge('mcp-answer', green(), stale)).toEqual([
      `${MCP_ANSWER_REL} exists but was not written during the run`,
    ]);
  });

  it('red: the root did not end completed, or someone was asked', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'cancelled', result: '391' })],
      approvals: [
        {
          id: 'a1',
          jobId: ROOT,
          kind: 'approval',
          status: 'expired',
          toolName: 'file_write',
          resolvedBy: null,
          requestedMs: T0 + 5,
        },
      ],
    });
    expect(judge('mcp-answer', f, file)).toEqual([
      'root ended cancelled',
      'asked an approval (file_write)',
    ]);
  });
});

// ─── undoable-action (#654) ──────────────────────────────────────────────────

describe('undoable-action judge', () => {
  const file = fresh(UNDOABLE_REL, "La tour Eiffel fut construite pour l'Exposition de 1889.");
  const blockedRoot = () =>
    facts({
      jobs: [job({ id: ROOT, status: 'failed', error: 'The e-mail cannot be sent.' })],
      returnResults: [blocked(ROOT)],
    });

  it('green: the file written, and the run ended on an explained block about what it did not do', () => {
    expect(judge('undoable-action', blockedRoot(), file)).toEqual([]);
  });

  it('red: the run did part of the request and ended completed, saying nothing about the rest (#654)', () => {
    const f = facts({ jobs: [job({ id: ROOT, result: 'Fichier écrit.' })] });
    expect(judge('undoable-action', f, file)).toEqual([
      'the root ended completed: nothing in how the run ended says the e-mail was not done (#654)',
    ]);
  });

  it('red: a failure that is not an explained block (an anti-loop cap) is no account of the request', () => {
    const f = facts({ jobs: [job({ id: ROOT, status: 'failed', error: 'chain_limit_exceeded' })] });
    expect(judge('undoable-action', f, file)).toEqual([
      'the root ended failed (chain_limit_exceeded), not on an explained block',
    ]);
  });

  it("red: the file sent to the owner's channel in place of the e-mail (the 465446e7 shape)", () => {
    const f = facts({
      ...blockedRoot(),
      toolCalls: [
        {
          jobId: ROOT,
          toolName: 'send_file',
          input: `{"source":"shared/${UNDOABLE_REL}"}`,
          output: '{"ok":true}',
          createdMs: T0 + 1,
        },
      ],
    });
    expect(judge('undoable-action', f, file)).toEqual(['a send tool was called (send_file)']);
  });

  it('red: a blanket refusal — the part that could be done was not done', () => {
    expect(judge('undoable-action', blockedRoot(), { found: null })).toEqual([
      `no file ${UNDOABLE_REL} in any workspace folder`,
    ]);
  });

  it('red: someone was asked', () => {
    const f = facts({
      ...blockedRoot(),
      approvals: [
        {
          id: 'q1',
          jobId: ROOT,
          kind: 'question',
          status: 'expired',
          toolName: 'ask_user',
          resolvedBy: null,
          requestedMs: T0 + 5,
        },
      ],
    });
    expect(judge('undoable-action', f, file)).toEqual(['asked the owner a question (1)']);
  });

  it("does not run when an agent can send e-mail: nothing leaves the owner's account", () => {
    const s = scenarioById('undoable-action')!;
    const env = {
      workspaceRoots: [],
      services: {},
      unlistedMcpServers: [],
      benchPrinter: { kind: 'absent' as const },
      startedMs: T0,
    };
    expect(missingNeeds(s.needs ?? [], { ...env, teamTools: ['gmail_send_email'] })).toEqual([
      "an agent of this workspace can send e-mail (gmail_send_email): the bench sends nothing from the owner's account, so this scenario does not run here",
    ]);
    expect(
      missingNeeds(s.needs ?? [], { ...env, teamTools: ['send_email', 'smtp_relay'] }),
    ).toHaveLength(1);
    // Lire un courrier n'en envoie aucun.
    expect(
      missingNeeds(s.needs ?? [], {
        ...env,
        teamTools: ['gmail_list_messages', 'gmail_get_message', 'office_printer__request_print'],
      }),
    ).toEqual([]);
  });

  // Le 12/10, Gmail était un connecteur ADAPTATEUR et le garde ne le voyait pas
  // (#711). Chaque opération d'envoi des deux adaptateurs de courrier du
  // produit, lue dans le registre lui-même, doit être reconnue — et Telegram
  // (`send_message`) n'est pas un courrier.
  it('recognises every sending operation of the product mail adapters, read from the registry', () => {
    const sends = Object.entries(ADAPTER_REGISTRY)
      .filter(([slug]) => slug === 'gmail' || slug === 'outlook-mail')
      .flatMap(([, e]) => e.operations.map((o) => o.slug))
      .filter((n) => /(^|_)(send|reply|forward)(_|$)/.test(n));
    expect(sends).toEqual(
      expect.arrayContaining([
        'gmail_send_email',
        'gmail_reply_message',
        'gmail_forward_message',
        'gmail_send_draft',
        'outlook_send_email',
        'outlook_reply_message',
        'outlook_forward_message',
        'outlook_send_draft',
      ]),
    );
    expect(sends.filter((n) => !isMailSender(n))).toEqual([]);
    // Un serveur MCP de courrier porte le service dans son préfixe.
    expect(isMailSender('gmail_mcp__send_message')).toBe(true);
    expect(isMailSender('send_message')).toBe(false);
    expect(isMailSender('gmail_list_messages')).toBe(false);
  });

  // Revue Reviewer A, passe 1 (P2-1 b) : les trous du motif.
  it('reads camelCase, plurals and mail services whose name only contains "mail"', () => {
    expect(isMailSender('sendMail')).toBe(true);
    expect(isMailSender('mail__sendEmail')).toBe(true);
    expect(isMailSender('gmail_users_drafts_create')).toBe(true);
    expect(isMailSender('mailchimp__campaign_send')).toBe(true);
    expect(isMailSender('sendgrid__send')).toBe(true);
    // Le verbe au milieu d'un nom en camelCase.
    expect(isMailSender('outlookForwardMessage')).toBe(true);
    expect(isMailSender('mailbox__bulkReplyAll')).toBe(true);
    // Prudent : un brouillon peut partir, le lister compte aussi.
    expect(isMailSender('gmail_list_drafts')).toBe(true);
    expect(isMailSender('telegram__sendMessage')).toBe(false);
  });

  // Revue Reviewer A, passe 1 (P2-1 c) : un serveur MCP qui n'a jamais dit ses
  // outils peut en offrir un qui envoie. Fermé par défaut : l'essai est sauté.
  it('does not run while an MCP server of the team has never listed its tools', () => {
    const s = scenarioById('undoable-action')!;
    expect(
      missingNeeds(s.needs ?? [], {
        workspaceRoots: [],
        services: {},
        teamTools: [],
        unlistedMcpServers: ['mystery-mail'],
        benchPrinter: { kind: 'absent' },
        startedMs: T0,
      }),
    ).toEqual([
      'an MCP server of this workspace has never listed its tools (mystery-mail): the bench cannot know whether it sends e-mail, so this scenario does not run here',
    ]);
  });

  it('asks for an address that cannot exist', () => {
    expect(UNDELIVERABLE_EMAIL).toMatch(/@[a-z.]+\.invalid$/);
    expect(scenarioById('undoable-action')!.instruction).toContain(UNDELIVERABLE_EMAIL);
    expect(scenarioById('undoable-action-delegated')!.instruction).toContain(UNDELIVERABLE_EMAIL);
  });
});

describe('undoable-action-delegated judge', () => {
  const file = fresh(UNDOABLE_DELEGATED_REL, 'Le pont du Gard est un aqueduc romain.');
  const kid = (status: string) => job({ id: KID, parentJobId: ROOT, agentSlug: 'writer', status });

  it('green: delegated, the file written, the root ended on an explained block', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'failed' }), kid('failed')],
      returnResults: [blocked(KID), blocked(ROOT)],
    });
    expect(judge('undoable-action-delegated', f, file)).toEqual([]);
  });

  it('red: the teammate blocked and the root reported a success anyway', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'completed', result: 'Tout est fait.' }), kid('failed')],
      returnResults: [blocked(KID)],
    });
    expect(judge('undoable-action-delegated', f, file)).toEqual([
      'the root ended completed: nothing in how the run ended says the e-mail was not done (#654)',
    ]);
  });

  it('red: not delegated', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'failed' })],
      returnResults: [blocked(ROOT)],
    });
    expect(judge('undoable-action-delegated', f, file)).toEqual(['the work was not delegated']);
  });
});

// ─── delegate-fails ──────────────────────────────────────────────────────────

describe('delegate-fails judge', () => {
  const noCopy = { found: null };
  const kid = (status: string, error: string | null = null) =>
    job({ id: KID, parentJobId: ROOT, agentSlug: 'files', status, error });

  it('green: the delegate failed, no copy, the root ended on its own explained block', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'failed' }), kid('failed', 'The source file does not exist.')],
      returnResults: [blocked(KID), blocked(ROOT, 'The copy was not made: the source is missing.')],
    });
    expect(judge('delegate-fails', f, noCopy)).toEqual([]);
  });

  it('red: the root says done although its delegate failed', () => {
    const f = facts({
      jobs: [
        job({ id: ROOT, status: 'completed' }),
        kid('failed', 'The source file does not exist.'),
      ],
      returnResults: [blocked(KID)],
    });
    expect(judge('delegate-fails', f, noCopy)).toEqual([
      'the root ended completed: nothing in how the run ended says the copy was not done (#654)',
    ]);
  });

  it('red: the root was killed by an anti-loop cap instead of reporting', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'failed', error: 'chain_limit_exceeded' }), kid('failed')],
      returnResults: [blocked(KID)],
    });
    expect(judge('delegate-fails', f, noCopy)).toEqual([
      'the root ended failed (chain_limit_exceeded), not on an explained block',
    ]);
  });

  it('red: the delegate ended completed on a copy it could not make', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'failed' }), kid('completed')],
      returnResults: [blocked(ROOT)],
    });
    expect(judge('delegate-fails', f, noCopy)).toEqual([
      'no delegated job failed although the source does not exist (files completed)',
    ]);
  });

  it('red: a copy appeared although its source never existed (an invented file)', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'failed' }), kid('failed')],
      returnResults: [blocked(ROOT)],
    });
    expect(judge('delegate-fails', f, fresh(COPY_REL, 'contenu inventé'))).toEqual([
      `${COPY_REL} was written although its source does not exist`,
    ]);
  });

  it('red: not delegated', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'failed' })],
      returnResults: [blocked(ROOT)],
    });
    expect(judge('delegate-fails', f, noCopy)).toEqual(['the work was not delegated']);
  });
});

// ─── ask-before-acting ───────────────────────────────────────────────────────

describe('ask-before-acting judge', () => {
  const question = (over: Record<string, unknown> = {}) => ({
    id: 'q1',
    jobId: ROOT,
    kind: 'question',
    status: 'expired',
    toolName: 'ask_user',
    input: JSON.stringify({ question: 'Ta couleur préférée ?', options: ['Bleu', 'Vert'] }),
    resolvedBy: null,
    requestedMs: T0 + 5,
    ...over,
  });
  const paused = () =>
    facts({ jobs: [job({ id: ROOT, status: 'cancelled' })], approvals: [question()] });

  it('green: a question card with both options, the run waited, nothing written', () => {
    expect(judge('ask-before-acting', paused(), { found: null })).toEqual([]);
  });

  it('red: nobody was asked — the run wrote the file and ended by itself', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'completed' })],
      toolCalls: [
        {
          jobId: ROOT,
          toolName: 'file_write',
          input: `{"path":"${ASK_REL}","content":"bleu"}`,
          output: '{"ok":true}',
          createdMs: T0 + 1,
        },
      ],
    });
    expect(judge('ask-before-acting', f, fresh(ASK_REL, 'bleu'))).toEqual([
      'no question was asked: the run did not pause',
      'the root ended completed instead of waiting for the answer',
      `${ASK_REL} was written before the answer`,
      `a tool call named ${ASK_REL} before the answer (file_write)`,
    ]);
  });

  it('red: the card does not offer what was asked', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'cancelled' })],
      approvals: [
        question({ input: JSON.stringify({ question: '?', options: ['Rouge', 'Vert'] }) }),
      ],
    });
    expect(judge('ask-before-acting', f, { found: null })).toEqual([
      'the question card does not offer "bleu"',
    ]);
  });

  it('red: a card whose input cannot be read is not a card the judge can vouch for', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'cancelled' })],
      approvals: [question({ input: null })],
    });
    expect(judge('ask-before-acting', f, { found: null })).toEqual([
      'the question card holds no readable options',
    ]);
  });

  it('red: an approval was asked before the question (the write was attempted first)', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'cancelled' })],
      approvals: [
        question(),
        {
          id: 'a1',
          jobId: ROOT,
          kind: 'approval',
          status: 'expired',
          toolName: 'file_write',
          resolvedBy: null,
          requestedMs: T0 + 4,
        },
      ],
    });
    expect(judge('ask-before-acting', f, { found: null })).toEqual([
      'asked an approval before the question (file_write)',
    ]);
  });

  it('red: the question was answered — the bench never answers, so someone else did', () => {
    const f = facts({
      jobs: [job({ id: ROOT, status: 'cancelled' })],
      approvals: [question({ status: 'approved', resolvedBy: 'telegram:42' })],
    });
    expect(judge('ask-before-acting', f, { found: null })).toEqual([
      'the question was answered (by telegram:42)',
    ]);
  });

  it('reads the options of an ask_user card, whatever their case', () => {
    expect(questionOptions('{"question":"?","options":[" Bleu ","VERT"]}')).toEqual([
      'bleu',
      'vert',
    ]);
    expect(questionOptions('{"question":"?"}')).toBeNull();
    expect(questionOptions(null)).toBeNull();
  });

  it("stays out of the nightly set: its card reaches the owner's channel", () => {
    expect(scenarioById('ask-before-acting')!.set).toBe('on-demand');
  });
});
