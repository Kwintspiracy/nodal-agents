// types.ts — les formes minimales dont le kit a besoin, définies ICI.
//
// Le kit ne dépend d'AUCUN package produit, et c'est délibéré. Une première
// version importait `@nodal-agents/tools` pour ses types et son `executeTool` :
// turbo a refusé le graphe (`tools → test-kit → tools`), et il avait raison
// au-delà du cycle mécanique — un harnais de test qui dépend du code testé ne
// peut pas servir à tester ce code sans se rendre lui-même indisponible.
//
// Ces types sont donc STRUCTURELS : ils décrivent la forme attendue, pas la
// définition canonique. Si le produit change la sienne, le typecheck des
// appelants casse à l'endroit du branchement — ce qui est le bon endroit.

export type RiskLevel = 'read' | 'write' | 'destructive';
export type ApprovalAction = 'auto_approve' | 'require_approval' | 'block';

export interface ApprovalRuleLike {
  id: string;
  toolName: string;
  action: ApprovalAction;
  agentId: string | null;
  entityId: string | null;
}

export interface ToolContextLike {
  db: unknown;
  entityId: string;
  agentId: string;
  jobId: string;
}

export interface ToolDefinitionLike {
  name: string;
  description: string;
  inputSchema: unknown;
  riskLevel: RiskLevel;
  defaultApproval?: ApprovalAction;
  execute: (input: unknown, ctx: ToolContextLike) => Promise<unknown>;
  computeApproval?: (input: unknown, ctx: ToolContextLike) => Promise<ApprovalAction | undefined>;
}

export type ToolOutcome =
  | { outcome: 'success'; output: unknown }
  | { outcome: 'error'; error: string }
  | { outcome: 'awaiting_approval'; approvalRequestId: string };

/**
 * The product's `executeTool`, injected by the caller.
 *
 * Injection rather than import is what keeps this package dependency-free — and
 * it makes the harness reusable against any future gate implementation.
 */
export type ExecuteToolFn = (
  tool: ToolDefinitionLike,
  input: unknown,
  ctx: ToolContextLike,
  opts: {
    approvalRules: ApprovalRuleLike[];
    autonomy?: 'propose_confirm' | 'destructive_gate' | 'fully_autonomous' | undefined;
    onApprovalRequired: (req: { toolName: string }) => Promise<void>;
  },
) => Promise<ToolOutcome>;
