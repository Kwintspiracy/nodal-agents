// orchestrator-mode.test.ts — detectOrchestratorMode unit tests
// Pure logic, no DB needed. Uses synthesized fixture data (no real agent slugs).

import { describe, it, expect } from 'vitest';
import { detectOrchestratorMode } from '../orchestrator-mode.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeAgent = (
  role: 'agent' | 'orchestrator' | 'system',
  orchestratorMode: 'router' | 'planner' | null = null,
) => ({ role, orchestratorMode });

const makeChild = (role: 'agent' | 'orchestrator' | 'system') => ({ role });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('detectOrchestratorMode', () => {
  describe('non-orchestrator agents', () => {
    it('returns worker for role=agent regardless of children', () => {
      const agent = makeAgent('agent');
      expect(detectOrchestratorMode(agent, [])).toBe('worker');
      expect(detectOrchestratorMode(agent, [makeChild('agent')])).toBe('worker');
      expect(detectOrchestratorMode(agent, [makeChild('orchestrator')])).toBe('worker');
    });

    it('returns worker for role=system', () => {
      const agent = makeAgent('system');
      expect(detectOrchestratorMode(agent, [])).toBe('worker');
    });
  });

  describe('orchestrator with no children', () => {
    it('returns worker (misconfigured orchestrator with no children)', () => {
      const agent = makeAgent('orchestrator');
      expect(detectOrchestratorMode(agent, [])).toBe('worker');
    });
  });

  describe('orchestrator with sub-orchestrators → router', () => {
    it('detects router when at least one child is an orchestrator', () => {
      const agent = makeAgent('orchestrator');
      const children = [makeChild('orchestrator'), makeChild('agent'), makeChild('agent')];
      expect(detectOrchestratorMode(agent, children)).toBe('router');
    });

    it('detects router with a single sub-orchestrator', () => {
      const agent = makeAgent('orchestrator');
      const children = [makeChild('orchestrator')];
      expect(detectOrchestratorMode(agent, children)).toBe('router');
    });
  });

  describe('orchestrator with workers only → planner', () => {
    it('detects planner when all children are workers', () => {
      const agent = makeAgent('orchestrator');
      const children = [makeChild('agent'), makeChild('agent'), makeChild('agent')];
      expect(detectOrchestratorMode(agent, children)).toBe('planner');
    });

    it('detects planner with a single worker child', () => {
      const agent = makeAgent('orchestrator');
      expect(detectOrchestratorMode(agent, [makeChild('agent')])).toBe('planner');
    });
  });

  describe('explicit orchestratorMode field takes precedence', () => {
    it('honours explicit router mode even with no sub-orchestrators in children list', () => {
      const agent = makeAgent('orchestrator', 'router');
      const children = [makeChild('agent'), makeChild('agent')];
      // Would be 'planner' by auto-detection, but explicit 'router' wins
      expect(detectOrchestratorMode(agent, children)).toBe('router');
    });

    it('honours explicit planner mode even if children include sub-orchestrators', () => {
      const agent = makeAgent('orchestrator', 'planner');
      const children = [makeChild('orchestrator'), makeChild('agent')];
      // Would be 'router' by auto-detection, but explicit 'planner' wins
      expect(detectOrchestratorMode(agent, children)).toBe('planner');
    });
  });
});
