// telegram-commands.test.ts — the platform commands join the bot's command menu
// without erasing the owner's own (#602). `setMyCommands` REPLACES the whole
// list, so a blind call would wipe what the owner set in BotFather.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { addTelegramBotCommands, setTelegramMessageReaction } from '../channels/telegram.ts';

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Records every Bot API call (method + JSON body) and answers from `answers`. */
function botApi(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    return Promise.resolve(ok(answers[method] ?? true));
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const PLATFORM = [
  { command: 'stop', description: 'Stop everything running in this conversation' },
  { command: 'new', description: 'Start a new conversation' },
];

describe('addTelegramBotCommands @cap:parler-par-canal-externe/moteur', () => {
  it("adds the missing commands after the owner's own, which it keeps", async () => {
    const owners = [{ command: 'weather', description: 'Weather today' }];
    const calls = botApi({ getMyCommands: owners });

    const added = await addTelegramBotCommands('1:tok', PLATFORM);

    expect(added).toEqual(['stop', 'new']);
    expect(calls).toEqual([
      { method: 'getMyCommands', body: {} },
      { method: 'setMyCommands', body: { commands: [...owners, ...PLATFORM] } },
    ]);
  });

  it('writes nothing when the menu already has every command', async () => {
    const calls = botApi({
      getMyCommands: [
        { command: 'new', description: 'x' },
        { command: 'stop', description: 'y' },
      ],
    });

    expect(await addTelegramBotCommands('1:tok', PLATFORM)).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(['getMyCommands']);
  });
});

describe('setTelegramMessageReaction', () => {
  it('sends one emoji reaction on the given message', async () => {
    const calls = botApi({});

    await setTelegramMessageReaction({ botToken: '1:tok', chatId: 555, messageId: 9, emoji: '👌' });

    expect(calls).toEqual([
      {
        method: 'setMessageReaction',
        body: { chat_id: 555, message_id: 9, reaction: [{ type: 'emoji', emoji: '👌' }] },
      },
    ]);
  });
});
