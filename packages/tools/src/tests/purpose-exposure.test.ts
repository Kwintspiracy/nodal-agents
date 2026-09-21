// purpose-exposure.test.ts — ce que le MODÈLE voit du champ `purpose` dans la
// liste d'outils d'un job.
//
// Le gate refuse une demande d'approbation sans phrase
// (`approval-purpose.test.ts`). Encore faut-il que le modèle ait eu un endroit
// où l'écrire : avant ce lot, aucun outil de gestion n'en déclarait, donc la
// carte ne pouvait QUE constater le silence. Ces tests lisent le schéma tel
// qu'il part vers le modèle.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { exposeStatedPurpose } from '../purpose-exposure';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import type { ApprovalRule, ToolDefinition } from '../types';

const AGENT = '11111111-1111-1111-1111-111111111111';
const ENTITY = '22222222-2222-2222-2222-222222222222';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

function tool(name: string, extra: Partial<AnyTool> = {}, shape?: z.ZodTypeAny): AnyTool {
  return {
    name,
    description: 'x',
    inputSchema: shape ?? z.object({ path: z.string() }),
    riskLevel: 'write',
    async execute() {
      return { ok: true };
    },
    ...extra,
  } as unknown as AnyTool;
}

/** Le schéma tel que le modèle le reçoit, interrogé comme il l'interrogerait. */
function purposeOf(t: AnyTool): { present: boolean; required: boolean } {
  const schema = t.inputSchema as z.ZodObject<z.ZodRawShape>;
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const field = shape['purpose'];
  if (!field) return { present: false, required: false };
  // « Requis » se lit au seul endroit qui compte : un objet sans le champ
  // est-il accepté ?
  const sansPhrase = schema.safeParse({ path: '/tmp/a' });
  return { present: true, required: !sansPhrase.success };
}

function expose(tools: AnyTool[], rules: ApprovalRule[] = []): AnyTool[] {
  return exposeStatedPurpose(tools, { approvalRules: rules, agentId: AGENT, entityId: ENTITY });
}

describe('la liste d’outils d’un job expose `purpose` @cap:approuver-une-action/moteur', () => {
  it('REQUIS pour un outil qui demande d’abord par sa posture', () => {
    const [t] = expose([tool('create_agent', { defaultApproval: 'require_approval' })]);
    expect(purposeOf(t as AnyTool)).toEqual({ present: true, required: true });
  });

  it('REQUIS pour un outil qu’une règle de CET agent fait demander d’abord', () => {
    const rule: ApprovalRule = {
      id: 'r1',
      toolName: 'file_read',
      action: 'require_approval',
      agentId: AGENT,
      entityId: ENTITY,
    };
    const [t] = expose([tool('file_read')], [rule]);
    expect(purposeOf(t as AnyTool)).toEqual({ present: true, required: true });
  });

  it('OPTIONNEL pour un outil autonome — la phrase reste à portée de main', () => {
    const [t] = expose([tool('list_models')]);
    expect(purposeOf(t as AnyTool)).toEqual({ present: true, required: false });
  });

  it('OPTIONNEL quand une règle Yolo relâche un outil normalement gaté', () => {
    const rule: ApprovalRule = {
      id: 'r2',
      toolName: 'run_command',
      action: 'auto_approve',
      agentId: AGENT,
      entityId: ENTITY,
    };
    const [t] = expose([tool('run_command', { defaultApproval: 'require_approval' })], [rule]);
    expect(purposeOf(t as AnyTool)).toEqual({ present: true, required: false });
  });

  it('le message porté par le champ requis dit quoi faire, et nomme l’outil', () => {
    const [t] = expose([tool('create_mcp', { defaultApproval: 'require_approval' })]);
    const parsed = (t as AnyTool).inputSchema.safeParse({ path: '/tmp/a' });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? '' : JSON.stringify(parsed.error.issues);
    expect(message).toContain('approval_purpose_required');
    expect(message).toContain('create_mcp');
  });

  it('ne réécrit pas le `purpose` d’un outil qui en déclare déjà un', () => {
    // Un serveur MCP peut avoir son PROPRE argument `purpose` ; l'adaptateur
    // pose lui-même le sien. Dans les deux cas, écraser le champ ici perdrait
    // sa description, et pour le serveur, une vraie valeur.
    const original = z.object({ purpose: z.string().describe("the note's subject") });
    const [t] = expose([tool('srv__file_note', { defaultApproval: 'require_approval' }, original)]);
    expect((t as AnyTool).inputSchema).toBe(original);
  });

  it('laisse intact un outil qui POSE une question', () => {
    const asks = tool('ask_user', { asksUser: true }, z.object({ question: z.string() }));
    const [t] = expose([asks]);
    expect(t).toBe(asks);
    expect(purposeOf(t as AnyTool).present).toBe(false);
  });

  it('laisse intact un outil dont l’entrée n’est pas un objet', () => {
    const scalaire = tool('weird', { defaultApproval: 'require_approval' }, z.string());
    const [t] = expose([scalaire]);
    expect(t).toBe(scalaire);
  });

  it('n’altère pas le schéma d’origine — la définition partagée reste la sienne', () => {
    const source = tool('create_skill', { defaultApproval: 'require_approval' });
    const avant = source.inputSchema;
    expose([source]);
    expect(source.inputSchema).toBe(avant);
    expect(avant.safeParse({ path: '/tmp/a' }).success).toBe(true);
  });
});

// ─── Le trou que l'exemption « pas un objet » pourrait ouvrir ────────────────
//
// `withStatedPurpose` laisse intact un outil dont l'entrée n'est pas un objet
// zod : il n'y a rien à étendre. Mais la porte, elle, refuserait quand même un
// tel outil s'il était gaté — le modèle n'aurait aucun endroit où écrire la
// phrase, et rappellerait l'outil jusqu'au plafond de tours. Constat C1 de
// Reviewer C sur la PR #359, laissé non tranché faute d'inventaire. Le voici,
// et il se re-vérifie tout seul à chaque outil ajouté.

describe('aucun outil livré ne tombe dans ce trou @cap:approuver-une-action/moteur', () => {
  it('tout outil du registre prend un OBJET en entrée', () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const outils = registry.list() as unknown as AnyTool[];
    expect(outils.length).toBeGreaterThan(20);

    const sansObjet = outils
      .filter((t) => !(t.inputSchema instanceof z.ZodObject))
      .map((t) => t.name);
    expect(sansObjet).toEqual([]);
  });

  it('et reçoit donc bien le champ, gaté ou non', () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const outils = registry.list() as unknown as AnyTool[];

    const muets = expose(outils)
      .filter((t) => t.asksUser !== true)
      .filter((t) => {
        const shape = (t.inputSchema as z.ZodObject<z.ZodRawShape>).shape as Record<
          string,
          unknown
        >;
        return !Object.prototype.hasOwnProperty.call(shape, 'purpose');
      })
      .map((t) => t.name);
    expect(muets).toEqual([]);
  });
});
