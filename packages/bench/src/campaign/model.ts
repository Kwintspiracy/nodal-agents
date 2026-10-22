// campaign/model.ts — le metteur de modèle de la matrice (#769), décidé.
//
// La couture `ModelApplier` (workflows/matrix.ts) attendait une décision du
// propriétaire : la voici (page « Nodal du banc », 17/10). Un modèle est
// appliqué dans l'instance JETABLE d'une campagne, à toute l'équipe testée à
// la fois (« le même pour toute l'équipe »), jamais aux agents du
// propriétaire. Le juge garde le sien : il n'est pas testé.
//
// Il écrit par `setAgentModelRepo`, le chemin de l'écran du modèle d'un
// agent, avec la clé de l'espace pour ce fournisseur (une seule, posée par
// l'applicateur) ; `restore()` rend à chacun ce qu'il avait. Un fournisseur
// dont l'espace n'a pas de clé, un modèle sans outils pour la racine, un
// modèle de la famille du juge : refus, avant d'écrire quoi que ce soit.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { MatrixModel, ModelApplier } from '../workflows/matrix';
import { modelKey } from '../workflows/matrix';
import type { AppliedCampaign } from './apply';
import { modelFamily, type CampaignConfig } from './config';

export function campaignModelApplier(
  db: AnyDrizzleDb,
  config: CampaignConfig,
  applied: AppliedCampaign,
): ModelApplier {
  return {
    name: 'campaign',
    async apply(target: MatrixModel) {
      if (modelFamily(target) === modelFamily(config.models.judge)) {
        throw new Error(
          `campaign_model_judge_family: ${modelKey(target)} is of the judge's family ` +
            `(${modelKey(config.models.judge)}); the judge is never of the tested model's family`,
        );
      }
      const d = await import('@nodal-agents/db');
      const entityId = applied.tested.entityId;
      const keys = await db
        .select({ id: d.entityLlmKeys.id })
        .from(d.entityLlmKeys)
        .where(
          d.and(
            d.eq(d.entityLlmKeys.entityId, entityId),
            d.eq(d.entityLlmKeys.provider, target.provider),
            d.eq(d.entityLlmKeys.isActive, true),
          ),
        );
      if (keys.length !== 1) {
        throw new Error(
          `campaign_model_key: the tested workspace has ${keys.length} active ${target.provider} key(s); ` +
            `${modelKey(target)} needs exactly one (add the provider to the bench key file and to the configuration)`,
        );
      }
      const llmKeyId = keys[0]!.id;
      const tested = config.agents.filter((a) => a.workspace === 'tested');
      for (const a of tested) {
        if (a.role !== 'orchestrator') continue;
        const why = await d.orchestratorModelToolsError(db, entityId, llmKeyId, target.model);
        if (why) throw new Error(`campaign_model_tools: ${a.slug}: ${why}`);
      }
      const before = await db
        .select({
          id: d.agents.id,
          model: d.agents.model,
          llmKeyId: d.agents.llmKeyId,
          reasoningEffort: d.agents.reasoningEffort,
        })
        .from(d.agents)
        .where(d.eq(d.agents.entityId, entityId));
      for (const a of tested) {
        const r = await d.setAgentModelRepo(db, entityId, {
          agentId: applied.agents[a.slug]!.id,
          model: target.model,
          reasoningEffort: null,
          llmKeyId,
        });
        if ('error' in r)
          throw new Error(`campaign_model_agent: ${a.slug} is not in the tested workspace`);
      }
      return {
        async restore() {
          for (const b of before) {
            // L'applicateur donne un modèle à chaque agent : un agent sans
            // modèle ici ne vient pas de lui, rien ne lui est inventé.
            if (b.model === null)
              throw new Error(`campaign_model_restore: agent ${b.id} had no model`);
            await d.setAgentModelRepo(db, entityId, {
              agentId: b.id,
              model: b.model,
              reasoningEffort: b.reasoningEffort,
              llmKeyId: b.llmKeyId,
            });
          }
        },
      };
    },
  };
}
