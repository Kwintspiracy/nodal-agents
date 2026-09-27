/**
 * Un run MCP dit QUI l'a demandé, comme une automatisation dit son nom.
 *
 * Le serveur MCP enregistre l'étiquette que l'appelant se donne (`caller`) pour
 * la rendre lisible dans les Runs ; la carte Settings le promettait, et la page
 * n'affichait que « MCP » (revue Codex de la PR #521).
 */
import { describe, it, expect } from 'vitest';
import { originOfRun } from '../activity-runs.ts';

describe('originOfRun — un run MCP @cap:suivre-execution/ecran', () => {
  it('nomme l’appelant quand il s’en est donné un', () => {
    expect(
      originOfRun({
        channel: 'mcp',
        triggerContext: { type: 'mcp', caller: 'claude-code', triggeredAt: '2026-09-27T00:00:00Z' },
        conversationId: null,
      }),
    ).toEqual({ label: 'MCP', detail: 'claude-code' });
  });

  it('sans étiquette, dit « MCP » et rien d’inventé', () => {
    expect(
      originOfRun({
        channel: 'mcp',
        triggerContext: { type: 'mcp', triggeredAt: '2026-09-27T00:00:00Z' },
        conversationId: null,
      }),
    ).toEqual({ label: 'MCP', detail: null });
  });

  it('les autres canaux ne changent pas', () => {
    expect(
      originOfRun({ channel: 'telegram', triggerContext: null, conversationId: null }),
    ).toEqual({ label: 'Telegram', detail: null });
  });
});
