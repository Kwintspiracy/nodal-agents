// device-conversation.test.ts — a device's conversation on the dashboard (#945).
//
// A device's turns are kept in `chat_messages`, like the dashboard's
// (`keepsTurnsInChat`, @nodal-agents/shared): its thread is read from them,
// and each request says it was made on the device, never "from the
// dashboard". The chat menu files it under its own folder, named.

import { describe, it, expect } from 'vitest';
import { buildConversationThread } from '../conversation-thread.ts';
import { folderLabel, folderOfJobChannel, folderOfWork } from '../chat-folders.ts';
import { originLabel } from '../../app/(dashboard)/spaces/format.ts';

const deviceConversation = {
  id: 'conv-device',
  channel: 'device',
  chatId: '6f1c2b8e-0d7a-4c55-9a3e-2b9b1f0c7d11',
  title: 'Desk',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  agentAvatarUrl: null,
  currentProject: null,
};

describe('a device’s conversation is read from its chat messages (#945) @cap:parler-par-canal-externe/ecran', () => {
  it('its turns are the messages, each request made on the device', () => {
    const { items } = buildConversationThread({
      conversation: deviceConversation,
      messages: [
        { id: 'm1', role: 'user', content: 'what time is it?', jobId: null, createdAt: null },
        { id: 'm2', role: 'assistant', content: 'It is noon.', jobId: null, createdAt: null },
      ],
      jobs: [],
    });
    expect(items.map((i) => i.kind)).toEqual(['request', 'turn']);
    const request = items[0];
    expect(request).toMatchObject({
      kind: 'request',
      text: 'what time is it?',
      origin: { channel: 'device', chatId: deviceConversation.chatId },
    });
    expect(request?.kind === 'request' ? originLabel(request.origin) : '').toBe('via Device');
  });

  it('the chat menu files it under the Device folder', () => {
    expect(folderOfJobChannel('device')).toBe('device');
    expect(folderLabel('device')).toBe('Device');
    expect(folderOfWork({ jobChannel: 'device', conversationChannel: 'device' })).toBe('device');
  });
});
