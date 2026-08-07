// gate.ts — a declarative harness for the approval gate.
//
// The gate is the product's most consequential branch: it decides whether a tool
// runs without a human. Its logic is a stack of interacting rules — explicit
// rules by specificity, `defaultApproval`, autonomy relaxation, the per-call
// `computeApproval` hook, and two hardline floors — and every audit finding
// around it (MCP-001, É-2, the run_command floor) came from ONE of those layers
// being reachable in some states and not others.
//
// Testing that by hand means rebuilding a ToolDefinition, a ToolContext, a rule
// array and an options object for every case. That is verbose enough that
// coverage gets abbreviated, which is exactly how `fully_autonomous` ended up
// skipping É-2's stdio check for months.
//
// So:
//
//     await expectGate(anMcpTool())
//       .withRules([])
//       .underEveryAutonomy()
//       .toRequireApproval();
//
// One line per contract, and `underEveryAutonomy()` makes "in all four modes"
// the cheap thing to write rather than the thing you skip.

import type {
  ApprovalRuleLike as ApprovalRule,
  ToolContextLike as ToolContext,
  ExecuteToolFn,
} from './types';
import { aToolContext, type BuiltTool } from './builders';

export type Autonomy = 'propose_confirm' | 'destructive_gate' | 'fully_autonomous' | undefined;

/** Every autonomy level, including the shipped default (undefined). */
export const ALL_AUTONOMIES: readonly Autonomy[] = [
  undefined,
  'propose_confirm',
  'destructive_gate',
  'fully_autonomous',
] as const;

export function autonomyLabel(a: Autonomy): string {
  return a ?? 'undefined (défaut livré)';
}

export interface GateOutcome {
  autonomy: Autonomy;
  outcome: 'success' | 'error' | 'awaiting_approval';
  /** Did the tool's own execute() actually run? The assertion that matters. */
  ran: boolean;
  /** Was a human asked? */
  asked: boolean;
  /** The gate request handed to the runner, when one was made. */
  request: { toolName: string } | null;
  error?: string;
}

class GateExpectation {
  #executeTool: ExecuteToolFn;
  #built: BuiltTool;
  #rules: ApprovalRule[] = [];
  #autonomies: Autonomy[] = [undefined];
  #input: unknown = {};
  #ctx: ToolContext;

  constructor(executeTool: ExecuteToolFn, built: BuiltTool) {
    this.#executeTool = executeTool;
    this.#built = built;
    this.#ctx = aToolContext();
  }

  withRules(rules: ApprovalRule[]): this {
    this.#rules = rules;
    return this;
  }

  withInput(input: unknown): this {
    this.#input = input;
    return this;
  }

  withContext(ctx: ToolContext): this {
    this.#ctx = ctx;
    return this;
  }

  underAutonomy(...autonomies: Autonomy[]): this {
    this.#autonomies = autonomies;
    return this;
  }

  /**
   * Run against all four levels.
   *
   * Deliberately the SHORTEST thing to write. A contract that holds in three
   * modes and not the fourth is the shape every gate bug in this repo has taken.
   */
  underEveryAutonomy(): this {
    this.#autonomies = [...ALL_AUTONOMIES];
    return this;
  }

  /** Run and return one outcome per autonomy level, without asserting. */
  async run(): Promise<GateOutcome[]> {
    const out: GateOutcome[] = [];
    for (const autonomy of this.#autonomies) {
      // A fresh tool per run: `didRun` is cumulative by design, so reusing one
      // across levels would report the first level's execution for all of them.
      const built = this.#built;
      const before = built.calls().length;
      let request: { toolName: string } | null = null;

      const result = await this.#executeTool(built.tool, this.#input, this.#ctx, {
        approvalRules: this.#rules,
        autonomy,
        onApprovalRequired: async (req) => {
          request = { toolName: req.toolName };
        },
      });

      out.push({
        autonomy,
        outcome: result.outcome,
        ran: built.calls().length > before,
        asked: request !== null,
        request,
        ...(result.outcome === 'error' ? { error: result.error } : {}),
      });
    }
    return out;
  }

  /** Every selected level must suspend for a human, and never execute. */
  async toRequireApproval(): Promise<GateOutcome[]> {
    const results = await this.run();
    for (const r of results) {
      assert(
        r.outcome === 'awaiting_approval',
        `autonomie=${autonomyLabel(r.autonomy)} : attendu awaiting_approval, obtenu ${r.outcome}`,
      );
      assert(
        !r.ran,
        `autonomie=${autonomyLabel(r.autonomy)} : l'outil s'est EXÉCUTÉ alors qu'une approbation était attendue`,
      );
      assert(
        r.asked,
        `autonomie=${autonomyLabel(r.autonomy)} : suspendu sans jamais demander à un humain`,
      );
    }
    return results;
  }

  /** Every selected level must execute without asking. */
  async toRunWithoutAsking(): Promise<GateOutcome[]> {
    const results = await this.run();
    for (const r of results) {
      assert(
        r.outcome === 'success',
        `autonomie=${autonomyLabel(r.autonomy)} : attendu success, obtenu ${r.outcome}${r.error ? ` (${r.error})` : ''}`,
      );
      assert(r.ran, `autonomie=${autonomyLabel(r.autonomy)} : succès rapporté sans exécution`);
      assert(
        !r.asked,
        `autonomie=${autonomyLabel(r.autonomy)} : une approbation a été demandée alors qu'aucune n'était attendue`,
      );
    }
    return results;
  }

  /** Every selected level must refuse outright, without executing or asking. */
  async toBeBlocked(): Promise<GateOutcome[]> {
    const results = await this.run();
    for (const r of results) {
      assert(
        r.outcome === 'error',
        `autonomie=${autonomyLabel(r.autonomy)} : attendu un refus, obtenu ${r.outcome}`,
      );
      assert(!r.ran, `autonomie=${autonomyLabel(r.autonomy)} : bloqué mais exécuté quand même`);
    }
    return results;
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`[gate] ${message}`);
}

/**
 * Bind the harness to the product's `executeTool`, once per suite.
 *
 *     const { expectGate } = createGateHarness(executeTool);
 *
 * Injection keeps this package free of product dependencies — the first version
 * imported `@nodal-agents/tools` and turbo refused the graph (`tools →
 * test-kit → tools`). Beyond the mechanical cycle, a harness that imports the
 * code under test cannot be used BY that code's own suite, which is exactly
 * where the gate contracts belong.
 */
export function createGateHarness(executeTool: ExecuteToolFn): {
  expectGate: (built: BuiltTool) => GateExpectation;
} {
  return {
    /**
     * Start an expectation about how the gate treats `built`.
     *
     * The tool comes from a builder rather than a literal so `ran` is
     * observable — asserting on the outcome alone would let a "success" that
     * never executed pass.
     */
    expectGate: (built: BuiltTool) => new GateExpectation(executeTool, built),
  };
}
