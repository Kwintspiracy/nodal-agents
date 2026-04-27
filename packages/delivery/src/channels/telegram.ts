// channels/telegram.ts — sendTelegramMessage via fetch (no SDK needed for outbound-only)

import { DeliveryError } from '../errors.ts';

export interface TelegramSendOpts {
  chatId: string;
  text: string;
  botToken: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disableWebPagePreview?: boolean;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

export async function sendTelegramMessage(opts: TelegramSendOpts): Promise<{ messageId: number }> {
  const { chatId, text, botToken, parseMode, disableWebPagePreview } = opts;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (parseMode !== undefined) {
    body['parse_mode'] = parseMode;
  }
  if (disableWebPagePreview !== undefined) {
    body['disable_web_page_preview'] = disableWebPagePreview;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: network error: ${String(err)}`,
    );
  }

  const json = (await response.json()) as TelegramApiResponse;

  if (!response.ok || !json.ok) {
    const desc = json.description ?? '';
    if (response.status === 401) {
      throw new DeliveryError('telegram_unauthorized', `telegram_unauthorized: ${desc}`);
    }
    if (response.status === 429) {
      throw new DeliveryError('telegram_rate_limited', `telegram_rate_limited: ${desc}`);
    }
    if (response.status === 400 && desc.toLowerCase().includes('chat not found')) {
      throw new DeliveryError('telegram_chat_not_found', `telegram_chat_not_found: ${desc}`);
    }
    throw new DeliveryError('telegram_request_failed', `telegram_request_failed: ${desc}`);
  }

  const messageId = json.result?.message_id ?? 0;
  return { messageId };
}
