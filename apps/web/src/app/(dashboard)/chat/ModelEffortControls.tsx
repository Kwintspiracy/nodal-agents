'use client';

// ModelEffortControls — provider, modèle et effort, dans la rangée d'actions
// du composeur (#138).
//
// TROIS listes distinctes, dans cet ordre, et pas une pastille : c'est le
// verdict de Quentin sur la première version. « La liste des modèles est
// foireuse et ne correspond pas à ce qu'on a dans les settings » — d'où la
// règle qui gouverne ce fichier : la liste vient de `buildModelOptionGroups`,
// LA fonction que l'écran d'édition d'un agent utilise aussi, et les modèles
// vus en direct chez le fournisseur sont lus par la MÊME action
// (`listKeyModelsAction`), mis en cache par clé de la même façon. Deux listes
// construites séparément finissent toujours par différer ; il n'y en a plus
// qu'une.
//
// Ce sont les réglages de l'AGENT, pour tous les canaux — pas de cette
// conversation. Chaque liste le dit dans son infobulle.
//
// Chaque changement s'applique TOUT DE SUITE. Tant que l'action tourne les
// listes sont inertes ; elles ne prennent la nouvelle valeur qu'au succès, et
// un échec se lit dans un toast en gardant l'ancienne (inv. #4 : l'écran ne
// montre jamais un réglage que la base n'a pas).

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import Select from '@/components/ui/Select';
import { listKeyModelsAction, setAgentModelAndEffortAction } from '@/lib/actions.ts';
import {
  buildModelOptionGroups,
  defaultModelForProvider,
  isModelInOptions,
  llmKeyLabel,
  reasoningOptionValues,
  REASONING_LABELS,
} from '@/lib/model-choices.ts';

/** Une clé LLM telle que le composeur en a besoin — le strict nécessaire. */
export interface ComposerLlmKey {
  id: string;
  provider: string;
  nickname: string | null;
}

/** La valeur nulle en base = « Auto » : le fournisseur décide. */
const AUTO = '';

const SCOPE_HINT = "Sets the agent's setting for every channel";

export default function ModelEffortControls({
  agentId,
  llmKeyId,
  model,
  reasoningEffort,
  llmKeys,
}: {
  agentId: string;
  /** La clé primaire de l'agent. `null` = aucune : rien à régler. */
  llmKeyId: string | null;
  model: string;
  /** null = Auto. */
  reasoningEffort: string | null;
  /** Les clés ACTIVES de l'espace, dans l'ordre où l'écran d'édition les offre. */
  llmKeys: ComposerLlmKey[];
}) {
  // L'état AFFICHÉ : il ne bouge qu'après un écrit réussi.
  const [current, setCurrent] = useState({
    llmKeyId,
    model,
    effort: reasoningEffort ?? AUTO,
  });
  const [isSaving, startSaving] = useTransition();
  // Les modèles vus en direct, par clé — même cache et même action que l'écran
  // d'édition. `undefined` = pas encore demandé ; `[]` = demandé et rien reçu,
  // le repli exact de l'écran d'édition (il ne reste que le catalogue).
  const [liveModels, setLiveModels] = useState<Record<string, string[]>>({});

  // Le réglage peut changer ailleurs (l'écran de l'agent) : la page relue
  // repasse les props, et les listes suivent plutôt que de figer leur copie.
  useEffect(() => {
    setCurrent({ llmKeyId, model, effort: reasoningEffort ?? AUTO });
  }, [llmKeyId, model, reasoningEffort]);

  useEffect(() => {
    const id = current.llmKeyId;
    if (id === null || liveModels[id] !== undefined) return;
    let alive = true;
    listKeyModelsAction(id).then((res) => {
      if (alive) setLiveModels((prev) => ({ ...prev, [id]: res.ok ? res.data : [] }));
    });
    return () => {
      alive = false;
    };
  }, [current.llmKeyId, liveModels]);

  if (llmKeys.length === 0 || current.llmKeyId === null) return null;

  const keyId = current.llmKeyId;
  const provider = llmKeys.find((k) => k.id === keyId)?.provider ?? '';
  const modelGroups = buildModelOptionGroups(provider, liveModels[keyId] ?? []);
  const efforts = reasoningOptionValues(provider, current.model);

  function apply(next: { llmKeyId: string; model: string; effort: string }): void {
    startSaving(async () => {
      const r = await setAgentModelAndEffortAction({
        agentId,
        llmKeyId: next.llmKeyId,
        model: next.model,
        reasoningEffort: next.effort === AUTO ? null : next.effort,
      });
      if (!r.ok) {
        // L'ancienne valeur RESTE affichée : c'est celle de la base.
        toast.error(r.message);
        return;
      }
      setCurrent(next);
    });
  }

  /** Un effort que le nouveau couple n'offre pas retombe sur Auto. */
  function keptEffort(nextProvider: string, nextModel: string): string {
    if (current.effort === AUTO) return AUTO;
    return reasoningOptionValues(nextProvider, nextModel).includes(current.effort)
      ? current.effort
      : AUTO;
  }

  function onProvider(nextKeyId: string): void {
    const nextProvider = llmKeys.find((k) => k.id === nextKeyId)?.provider ?? '';
    // Changer de fournisseur repose le modèle sur celui par défaut du nouveau,
    // exactement comme l'écran d'édition : un identifiant de modèle n'a de sens
    // que chez son fournisseur, et en garder un périmé ne casserait qu'au
    // premier message.
    const nextModel = defaultModelForProvider(nextProvider);
    apply({
      llmKeyId: nextKeyId,
      model: nextModel,
      effort: keptEffort(nextProvider, nextModel),
    });
  }

  function onModel(nextModel: string): void {
    apply({
      llmKeyId: keyId,
      model: nextModel,
      effort: keptEffort(provider, nextModel),
    });
  }

  function onEffort(nextEffort: string): void {
    apply({ llmKeyId: keyId, model: current.model, effort: nextEffort });
  }

  return (
    <div className="mr-auto flex min-w-0 items-center gap-1.5">
      <Select
        aria-label="Provider"
        title={SCOPE_HINT}
        data-testid="composer-provider"
        value={keyId}
        disabled={isSaving}
        onChange={(e) => onProvider(e.target.value)}
        containerClassName="min-w-0"
        className="!max-w-[170px] !truncate !text-body-13"
      >
        {llmKeys.map((k) => (
          <option key={k.id} value={k.id}>
            {llmKeyLabel(k)}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Model"
        title={SCOPE_HINT}
        data-testid="composer-model"
        value={current.model}
        disabled={isSaving}
        onChange={(e) => onModel(e.target.value)}
        containerClassName="min-w-0"
        className="!max-w-[220px] !truncate !text-body-13"
      >
        {/* Le modèle écrit en base n'est pas toujours dans la liste : un
            identifiant libre posé depuis l'écran d'édition, ou un modèle vu en
            direct que le fournisseur ne rend plus. Il s'affiche quand même,
            sinon la liste montrerait un modèle qui n'est pas celui qui tourne. */}
        {!isModelInOptions(modelGroups, current.model) && current.model !== '' && (
          <option value={current.model}>{current.model}</option>
        )}
        {modelGroups.map(({ group, models }) =>
          group ? (
            <optgroup key={group} label={group}>
              {models.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ) : (
            models.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.label}
              </option>
            ))
          ),
        )}
      </Select>

      <Select
        aria-label="Reasoning effort"
        // Un modèle sans palier ne se règle pas : la liste reste là, pour que
        // la rangée garde sa forme, mais inerte et sans choix inventé.
        title={efforts.length === 0 ? 'This model offers no reasoning setting' : SCOPE_HINT}
        data-testid="composer-effort"
        value={efforts.includes(current.effort) ? current.effort : AUTO}
        disabled={isSaving || efforts.length === 0}
        onChange={(e) => onEffort(e.target.value)}
        containerClassName="min-w-0"
        className="!max-w-[130px] !truncate !text-body-13"
      >
        <option value={AUTO}>Auto</option>
        {efforts.map((v) => (
          <option key={v} value={v}>
            {REASONING_LABELS[v] ?? v}
          </option>
        ))}
      </Select>
    </div>
  );
}
