'use client';

// ModelEffortChip — la pastille « provider · modèle · effort » de la rangée
// d'actions du composeur (#138, composant Figma `ThreadComposer` 355:2928).
//
// UNE pastille, trois segments cliquables, et TROIS listes distinctes : chaque
// segment ouvre la sienne, ancrée sous lui. C'est la forme que Quentin a
// dessinée lui-même dans Figma, et elle est suivie au trait — pas un champ de
// formulaire, donc pas le `Select` du DS, qui est fait pour un formulaire.
//
// Le nom du fournisseur s'écrit UNE FOIS. « Open Router (openrouter) » — la
// forme des réglages — a été jugée « totalement stupide » ici : la pastille
// tient sur une ligne au-dessus d'un fil, elle n'a pas la place de dire deux
// fois la même chose.
//
// Les listes, elles, sont CELLES DES RÉGLAGES : `buildModelOptionGroups`, la
// fonction que l'écran d'édition d'un agent utilise aussi, et les modèles vus
// en direct par `listKeyModelsAction`, la même action, mise en cache par clé de
// la même façon.
//
// Ce sont les réglages de l'AGENT, pour tous les canaux — pas de cette
// conversation. La pastille le dit dans son infobulle.
//
// Chaque choix s'applique TOUT DE SUITE. Pendant l'écriture les segments sont
// inertes ; ils ne prennent la nouvelle valeur qu'au succès, et un échec se lit
// dans un toast en gardant l'ancienne (inv. #4 : l'écran ne montre jamais un
// réglage que la base n'a pas).

import { useEffect, useRef, useState, useTransition } from 'react';
import { useLayer } from '@/lib/layers.ts';
import { toast } from 'sonner';
import InlineSelect, { type InlineSelectRow } from '@/components/ui/InlineSelect';
import { listKeyModelsAction, setAgentModelAndEffortAction } from '@/lib/actions.ts';
import {
  buildModelOptionGroups,
  defaultModelForProvider,
  disabledHintFor,
  isModelInOptions,
  llmKeyShortLabel,
  reasoningOptionValues,
  REASONING_LABELS,
} from '@/lib/model-choices.ts';

/** Une clé LLM telle que la pastille en a besoin — le strict nécessaire. */
export interface ComposerLlmKey {
  id: string;
  provider: string;
  nickname: string | null;
}

/** La valeur nulle en base = « auto » : le fournisseur décide. */
const AUTO = '';

const SCOPE_HINT = "Sets the agent's setting for every channel";

const NO_EFFORT_HINT = 'This model offers no reasoning setting';

type Segment = 'provider' | 'model' | 'effort';

/** Une ligne de liste — celle du primitif du DS, qui rend la liste. */
type Row = InlineSelectRow;

export default function ModelEffortChip({
  agentId,
  llmKeyId,
  model,
  reasoningEffort,
  llmKeys,
  requireTools,
}: {
  agentId: string;
  /** La clé primaire de l'agent. `null` = aucune : rien à régler. */
  llmKeyId: string | null;
  model: string;
  /** null = auto. */
  reasoningEffort: string | null;
  /** Les clés ACTIVES de l'espace, dans l'ordre où l'écran d'édition les offre. */
  llmKeys: ComposerLlmKey[];
  /**
   * Un routeur ou un planificateur : les modèles sans outils sont grisés, avec
   * la raison — la même règle, la même phrase que l'écran d'édition.
   */
  requireTools: boolean;
}) {
  // L'état AFFICHÉ : il part des props et ne bouge ensuite qu'après un écrit
  // réussi. Le réglage peut aussi changer AILLEURS (l'écran de l'agent) ; la
  // page relue repasse alors d'autres props, et c'est la `key` posée par
  // `ThreadComposer` qui remonte ce composant sur elles. PAS un effet qui
  // recopierait les props dans l'état : un setState synchrone dans un effet
  // déclenche un rendu en cascade, et la règle `react-hooks/set-state-in-effect`
  // le refuse (lint CI, rouge sur 9cdb718b).
  const [current, setCurrent] = useState({
    llmKeyId,
    model,
    effort: reasoningEffort ?? AUTO,
  });
  const [open, setOpen] = useState<Segment | null>(null);
  const [isSaving, startSaving] = useTransition();
  // Les modèles vus en direct, par clé — même cache et même action que l'écran
  // d'édition. `undefined` = pas encore demandé ; `[]` = demandé et rien reçu,
  // le repli exact de l'écran d'édition (il ne reste que le catalogue).
  const [liveModels, setLiveModels] = useState<Record<string, string[]>>({});
  const wrap = useRef<HTMLDivElement>(null);

  // Effet 1 — la liste en direct. Il n'appelle AUCUN setState synchrone : le
  // seul `setLiveModels` est dans le `then`, après l'attente, ce que la règle
  // autorise. Il ne redemande jamais deux fois la même clé.
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

  // Échap : par la pile des calques (`@/lib/layers.ts`), comme tous les autres.
  // Calque non modal : le dernier ouvert se ferme le premier.
  useLayer(open !== null, () => setOpen(null));

  // Effet 2 — fermer au clic dehors. Il n'appelle pas non plus de setState
  // synchrone : il pose un écouteur, et c'est l'ÉVÉNEMENT qui ferme, plus tard.
  useEffect(() => {
    if (open === null) return;
    function onPointerDown(e: MouseEvent): void {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(null);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  if (llmKeys.length === 0 || current.llmKeyId === null) return null;

  const keyId = current.llmKeyId;
  const activeKey = llmKeys.find((k) => k.id === keyId) ?? null;
  const provider = activeKey?.provider ?? '';
  const modelGroups = buildModelOptionGroups(provider, liveModels[keyId] ?? []);
  const efforts = reasoningOptionValues(provider, current.model);

  function apply(next: { llmKeyId: string; model: string; effort: string }): void {
    setOpen(null);
    if (
      next.llmKeyId === current.llmKeyId &&
      next.model === current.model &&
      next.effort === current.effort
    ) {
      return;
    }
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

  /** Un effort que le nouveau couple n'offre pas retombe sur auto. */
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
    apply({ llmKeyId: nextKeyId, model: nextModel, effort: keptEffort(nextProvider, nextModel) });
  }

  // ── Les trois listes ──────────────────────────────────────────────────────
  const providerRows: Row[] = llmKeys.map((k) => ({
    kind: 'option',
    value: k.id,
    label: llmKeyShortLabel(k),
  }));

  const modelRows: Row[] = [];
  // Le modèle écrit en base n'est pas toujours dans la liste : un identifiant
  // libre posé depuis l'écran d'édition, ou un modèle vu en direct que le
  // fournisseur ne rend plus. Il figure quand même, sinon la liste montrerait
  // un modèle qui n'est pas celui qui tourne.
  if (current.model !== '' && !isModelInOptions(modelGroups, current.model)) {
    modelRows.push({ kind: 'option', value: current.model, label: current.model });
  }
  for (const group of modelGroups) {
    if (group.group !== null) modelRows.push({ kind: 'heading', label: group.group });
    for (const m of group.models) {
      // Grisé pour la raison que l'écran d'édition donnerait, jamais laissé
      // choisir pour être refusé ensuite par l'action.
      const hint = disabledHintFor(m, requireTools);
      modelRows.push(
        hint === null
          ? { kind: 'option', value: m.modelId, label: m.label }
          : { kind: 'option', value: m.modelId, label: m.label, disabled: true, hint },
      );
    }
  }

  const effortRows: Row[] = [
    { kind: 'option', value: AUTO, label: 'auto' },
    ...efforts.map<Row>((v) => ({
      kind: 'option',
      value: v,
      label: (REASONING_LABELS[v] ?? v).toLowerCase(),
    })),
  ];

  return (
    <div
      ref={wrap}
      title={SCOPE_HINT}
      // La pastille du board : 30 px de haut, un filet, pas de fond.
      className="flex h-[30px] items-center gap-1.5 rounded-md border border-rule-2 py-1.5 pr-2 pl-2.5"
    >
      <InlineSelect
        name="provider"
        label={activeKey === null ? '—' : llmKeyShortLabel(activeKey)}
        tone="text-feed-metric"
        open={open === 'provider'}
        disabled={isSaving}
        rows={providerRows}
        value={keyId}
        onToggle={() => setOpen(open === 'provider' ? null : 'provider')}
        onPick={onProvider}
        onClose={() => setOpen(null)}
      />
      <Dot />
      <InlineSelect
        name="model"
        label={current.model === '' ? '—' : current.model}
        tone="text-feed-model"
        open={open === 'model'}
        disabled={isSaving}
        rows={modelRows}
        value={current.model}
        onToggle={() => setOpen(open === 'model' ? null : 'model')}
        onPick={(next) =>
          apply({ llmKeyId: keyId, model: next, effort: keptEffort(provider, next) })
        }
        onClose={() => setOpen(null)}
      />
      <Dot />
      <InlineSelect
        name="effort"
        label={`effort ${current.effort === AUTO ? 'auto' : (REASONING_LABELS[current.effort] ?? current.effort).toLowerCase()}`}
        tone="text-feed-metric"
        open={open === 'effort'}
        // Un modèle qui ne déclare AUCUN palier n'a rien à régler : le segment
        // reste écrit — la pastille garde sa forme — mais inerte, et il dit
        // pourquoi. Offrir une liste sans effet serait un faux réglage (inv. #4).
        title={efforts.length === 0 ? NO_EFFORT_HINT : undefined}
        disabled={isSaving || efforts.length === 0}
        rows={effortRows}
        value={current.effort}
        onToggle={() => setOpen(open === 'effort' ? null : 'effort')}
        onPick={(next) => apply({ llmKeyId: keyId, model: current.model, effort: next })}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

/** Le séparateur du board : un point médian, entre chaque segment. */
function Dot() {
  return (
    <span aria-hidden="true" className="text-mono-12 text-ink-4">
      ·
    </span>
  );
}
