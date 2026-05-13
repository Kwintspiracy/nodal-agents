// @nodal-agents/adapter-google-docs — batchUpdate request body builders
// Google Docs batchUpdate uses an array of Request objects, each with exactly
// one key corresponding to the operation type.

import type { docs_v1 } from 'googleapis';

/**
 * Build an insertText request at a specific document index.
 * Index 1 = beginning of document body (index 0 is reserved for the body start sentinel).
 */
export function buildInsertTextRequest(text: string, index: number): docs_v1.Schema$Request {
  return {
    insertText: {
      location: { index },
      text,
    },
  };
}

/**
 * Build an insertText request that appends to the end of the document body
 * using endOfSegmentLocation with an empty segmentId (meaning the main body).
 */
export function buildAppendTextRequest(text: string): docs_v1.Schema$Request {
  return {
    insertText: {
      endOfSegmentLocation: { segmentId: '' },
      text,
    },
  };
}

/**
 * Build a replaceAllText request (find & replace across the whole document).
 */
export function buildReplaceAllTextRequest(
  find: string,
  replace: string,
  matchCase: boolean,
): docs_v1.Schema$Request {
  return {
    replaceAllText: {
      containsText: {
        text: find,
        matchCase,
      },
      replaceText: replace,
    },
  };
}

/**
 * Build a deleteContentRange request.
 * Both startIndex and endIndex are document-body character offsets.
 */
export function buildDeleteContentRangeRequest(
  startIndex: number,
  endIndex: number,
): docs_v1.Schema$Request {
  return {
    deleteContentRange: {
      range: { startIndex, endIndex },
    },
  };
}

/**
 * Build an insertParagraph request via insertText — inserts a newline followed by
 * optional text at the given index. The Docs API doesn't have a dedicated
 * "insertParagraph" operation; a paragraph is created by inserting a newline character.
 */
export function buildInsertParagraphRequest(index: number, text: string): docs_v1.Schema$Request {
  return {
    insertText: {
      location: { index },
      text: text.endsWith('\n') ? text : text + '\n',
    },
  };
}

/**
 * Build a updateParagraphStyle request to apply a named paragraph style
 * (e.g. HEADING_1, HEADING_2, NORMAL_TEXT) to a range.
 */
export function buildApplyNamedStyleRequest(
  startIndex: number,
  endIndex: number,
  namedStyleType: string,
): docs_v1.Schema$Request {
  return {
    updateParagraphStyle: {
      range: { startIndex, endIndex },
      paragraphStyle: {
        namedStyleType,
      },
      fields: 'namedStyleType',
    },
  };
}

/**
 * Build an insertPageBreak request via insertText.
 * A page break in Google Docs is represented as a special control character \f (form feed).
 */
export function buildInsertPageBreakRequest(index: number): docs_v1.Schema$Request {
  return {
    insertPageBreak: {
      location: { index },
    },
  };
}

/**
 * Build an insertTable request.
 */
export function buildInsertTableRequest(
  index: number,
  rows: number,
  columns: number,
): docs_v1.Schema$Request {
  return {
    insertTable: {
      location: { index },
      rows,
      columns,
    },
  };
}

/**
 * Build an insertInlineImage request from a URI.
 */
export function buildInsertImageRequest(
  index: number,
  imageUri: string,
  widthMagnitude?: number,
  heightMagnitude?: number,
): docs_v1.Schema$Request {
  const size =
    widthMagnitude !== undefined || heightMagnitude !== undefined
      ? {
          width:
            widthMagnitude !== undefined
              ? { magnitude: widthMagnitude, unit: 'PT' as const }
              : undefined,
          height:
            heightMagnitude !== undefined
              ? { magnitude: heightMagnitude, unit: 'PT' as const }
              : undefined,
        }
      : undefined;

  return {
    insertInlineImage: {
      location: { index },
      uri: imageUri,
      ...(size !== undefined && { objectSize: size }),
    },
  };
}

/**
 * Build an updateTextStyle request to apply formatting to a range.
 */
export function buildUpdateTextStyleRequest(
  startIndex: number,
  endIndex: number,
  textStyle: docs_v1.Schema$TextStyle,
  fields: string,
): docs_v1.Schema$Request {
  return {
    updateTextStyle: {
      range: { startIndex, endIndex },
      textStyle,
      fields,
    },
  };
}
