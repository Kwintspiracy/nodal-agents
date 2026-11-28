// @nodal-agents/mcp-server — architecture invariant tests.
//
// What an outside MCP client reads (a run's result, its error, the input of a
// request waiting for a person) is text leaving Nodal: every answer of the
// server is built by `answer.ts`, which applies the outbound seam. A content
// block built anywhere else would be an answer beside it.

import { describe, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoViolations,
  OUTBOUND_BRAND_CAST,
  scanForAgentSlugs,
  scanForDbDriverImports,
  scanForOutboundBypass,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');
// The suites of this package sit beside its sources.
const notTests = { srcDir, skipFiles: ['.test.ts'] };

describe('architecture invariants', () => {
  it('no agent or server slug hardcoded in source (invariant #1)', () => {
    assertNoViolations('slugs d’agent', scanForAgentSlugs(notTests));
  });

  it('does not import a database driver (only packages/db may)', () => {
    assertNoViolations('driver DB', scanForDbDriverImports(notTests));
  });
});

describe('every answer of the MCP server leaves through the outbound seam @cap:parler-par-canal-externe/moteur', () => {
  it('a content block is built by answer.ts only', () => {
    assertNoViolations(
      'réponse MCP construite à côté de la couture de sortie',
      scanForOutboundBypass({ srcDir, skipFiles: ['.test.ts', 'src/answer.ts'] }, [
        { rule: 'mcp-content-beside-seam', pattern: /\btype\s*:\s*['"]text['"]/ },
        { rule: 'mcp-content-beside-seam', pattern: /\bcontent\s*:\s*\[/ },
        OUTBOUND_BRAND_CAST,
      ]),
    );
  });
});
