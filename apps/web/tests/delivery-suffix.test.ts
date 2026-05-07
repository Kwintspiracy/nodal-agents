// delivery-suffix.test.ts — pure unit tests for formatPromptDeliverySuffix

import { describe, it, expect } from 'vitest';
import { formatPromptDeliverySuffix, type DeliveryChannel } from '../src/lib/delivery-suffix.ts';

describe('formatPromptDeliverySuffix', () => {
  it('returns empty string for empty array', () => {
    expect(formatPromptDeliverySuffix([])).toBe('');
  });

  it('returns correct suffix for one telegram channel', () => {
    const channels: DeliveryChannel[] = [{ kind: 'telegram', identifier: '99887766' }];
    const result = formatPromptDeliverySuffix(channels);
    expect(result).toBe(
      '\n\n## Delivery channels\n- Telegram (chat_id: 99887766)\n\nUse the corresponding tool(s) to deliver the final result on each channel.',
    );
  });

  it('returns correct suffix for two telegram channels (multi-line)', () => {
    const channels: DeliveryChannel[] = [
      { kind: 'telegram', identifier: '111' },
      { kind: 'telegram', identifier: '222' },
    ];
    const result = formatPromptDeliverySuffix(channels);
    expect(result).toBe(
      '\n\n## Delivery channels\n- Telegram (chat_id: 111)\n- Telegram (chat_id: 222)\n\nUse the corresponding tool(s) to deliver the final result on each channel.',
    );
  });
});
