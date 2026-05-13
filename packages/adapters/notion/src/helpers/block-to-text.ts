// @nodal-agents/adapter-notion — convert Notion block objects to readable text

import type { BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';

type RichTextItem = { plain_text: string };

function richTextToString(items: RichTextItem[]): string {
  return items.map((i) => i.plain_text).join('');
}

/**
 * Convert a single Notion BlockObjectResponse to a human-readable string.
 * Returns null for block types that carry no text (unsupported/structural blocks).
 */
export function blockToText(block: BlockObjectResponse): string | null {
  const type = block.type;

  switch (type) {
    case 'paragraph': {
      return richTextToString(block.paragraph.rich_text);
    }
    case 'heading_1': {
      return `# ${richTextToString(block.heading_1.rich_text)}`;
    }
    case 'heading_2': {
      return `## ${richTextToString(block.heading_2.rich_text)}`;
    }
    case 'heading_3': {
      return `### ${richTextToString(block.heading_3.rich_text)}`;
    }
    case 'bulleted_list_item': {
      return `- ${richTextToString(block.bulleted_list_item.rich_text)}`;
    }
    case 'numbered_list_item': {
      return `1. ${richTextToString(block.numbered_list_item.rich_text)}`;
    }
    case 'to_do': {
      const checked = block.to_do.checked;
      return `[${checked ? 'x' : ' '}] ${richTextToString(block.to_do.rich_text)}`;
    }
    case 'code': {
      const lang = block.code.language;
      const text = richTextToString(block.code.rich_text);
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case 'quote': {
      return `> ${richTextToString(block.quote.rich_text)}`;
    }
    case 'callout': {
      const text = richTextToString(block.callout.rich_text);
      const icon = block.callout.icon;
      const emoji = icon?.type === 'emoji' ? icon.emoji : '';
      return emoji ? `${emoji} ${text}` : text;
    }
    case 'divider': {
      return '---';
    }
    case 'toggle': {
      return richTextToString(block.toggle.rich_text);
    }
    case 'table_of_contents': {
      return '[table of contents]';
    }
    case 'child_page': {
      return `[child page: ${block.child_page.title}]`;
    }
    case 'child_database': {
      return `[child database: ${block.child_database.title}]`;
    }
    case 'image': {
      const src = block.image.type === 'external' ? block.image.external.url : block.image.file.url;
      return `[image: ${src}]`;
    }
    case 'video': {
      const src = block.video.type === 'external' ? block.video.external.url : block.video.file.url;
      return `[video: ${src}]`;
    }
    case 'file': {
      const src = block.file.type === 'external' ? block.file.external.url : block.file.file.url;
      return `[file: ${src}]`;
    }
    case 'pdf': {
      const src = block.pdf.type === 'external' ? block.pdf.external.url : block.pdf.file.url;
      return `[pdf: ${src}]`;
    }
    case 'bookmark': {
      return `[bookmark: ${block.bookmark.url}]`;
    }
    case 'embed': {
      return `[embed: ${block.embed.url}]`;
    }
    default: {
      return null;
    }
  }
}

/**
 * Convert an array of Notion blocks to a single text string.
 * Blocks with no text representation are skipped.
 * Truncates at maxLength if provided.
 */
export function blocksToText(blocks: BlockObjectResponse[], maxLength = 15000): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const text = blockToText(block);
    if (text !== null) {
      lines.push(text);
    }
  }
  const result = lines.join('\n\n');
  if (result.length > maxLength) {
    return result.slice(0, maxLength) + '\n\n[...content truncated...]';
  }
  return result;
}
