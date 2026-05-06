// tool-choice.test.ts — computeToolChoice invariants

import { describe, it, expect } from 'vitest';
import { computeToolChoice } from '../tool-choice';

describe('computeToolChoice', () => {
  // ── Orchestrator rules ──────────────────────────────────────────────────────

  it('returns required on orchestrator turn 1', () => {
    expect(computeToolChoice({ isOrchestrator: true, turn: 1, hasAdapterTools: false })).toBe(
      'required',
    );
  });

  it('returns auto on orchestrator turn 2', () => {
    expect(computeToolChoice({ isOrchestrator: true, turn: 2, hasAdapterTools: false })).toBe(
      'auto',
    );
  });

  it('returns auto on orchestrator turn 3+', () => {
    expect(computeToolChoice({ isOrchestrator: true, turn: 5, hasAdapterTools: false })).toBe(
      'auto',
    );
  });

  // ── Worker with adapter tools ───────────────────────────────────────────────

  it('returns required for worker with adapter tools on turn 1', () => {
    expect(computeToolChoice({ isOrchestrator: false, turn: 1, hasAdapterTools: true })).toBe(
      'required',
    );
  });

  it('returns required for worker with adapter tools on turn 2', () => {
    expect(computeToolChoice({ isOrchestrator: false, turn: 2, hasAdapterTools: true })).toBe(
      'required',
    );
  });

  it('returns required for worker with adapter tools on any turn', () => {
    for (const turn of [1, 2, 5, 10, 15]) {
      expect(computeToolChoice({ isOrchestrator: false, turn, hasAdapterTools: true })).toBe(
        'required',
      );
    }
  });

  // ── Plain worker (no adapter tools) ────────────────────────────────────────

  it('returns auto for plain worker on any turn', () => {
    for (const turn of [1, 2, 3]) {
      expect(computeToolChoice({ isOrchestrator: false, turn, hasAdapterTools: false })).toBe(
        'auto',
      );
    }
  });

  // ── Orchestrator with adapter tools (edge case) ─────────────────────────────
  // Orchestrators orchestrate; the worker flag for adapter tools applies to
  // non-orchestrators. On turn 1 → required (orchestrator rule wins).
  // On turn 2+ → auto (neither rule fires).
  it('returns required for orchestrator with adapter tools on turn 1', () => {
    expect(computeToolChoice({ isOrchestrator: true, turn: 1, hasAdapterTools: true })).toBe(
      'required',
    );
  });

  it('returns auto for orchestrator with adapter tools on turn 2', () => {
    // Orchestrators with adapter tools: after turn 1 they can produce text.
    // The worker rule (hasAdapterTools) applies only to !isOrchestrator.
    expect(computeToolChoice({ isOrchestrator: true, turn: 2, hasAdapterTools: true })).toBe(
      'auto',
    );
  });

  // ── Never returns 'none' ────────────────────────────────────────────────────
  it('never returns none in any standard configuration', () => {
    const configs = [
      { isOrchestrator: true, turn: 1, hasAdapterTools: true },
      { isOrchestrator: true, turn: 2, hasAdapterTools: false },
      { isOrchestrator: false, turn: 1, hasAdapterTools: true },
      { isOrchestrator: false, turn: 1, hasAdapterTools: false },
    ];
    for (const cfg of configs) {
      expect(computeToolChoice(cfg)).not.toBe('none');
    }
  });
});
