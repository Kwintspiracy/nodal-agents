'use client';

// ModelEffortChip — la pastille « modèle · effort » du composeur (#138).
//
// Elle règle le MÊME champ que l'écran de l'agent (`agents.model` /
// `agents.reasoning_effort`), pas un réglage « de cette conversation » : le
// changement vaut pour tous les canaux, et la pastille le dit dans son
// infobulle plutôt que de laisser le croire.
//
// Pas de `<select>` natif (inv. #10 et la règle « le DS remplace les widgets
// natifs ») : un petit panneau posé au-dessus de la pastille, fermé au clic
// dehors et à Échap. Aucun primitif Popover n'existe dans `components/ui`
// (vérifié : Modal et Drawer seulement), donc il est écrit ici, court, plutôt
// qu'inventé comme primitif au passage d'une pastille.
//
// Choisir applique TOUT DE SUITE. Tant que l'action tourne, la pastille le dit
// et garde l'ancienne valeur ; elle ne prend la nouvelle qu'au succès, et un
// échec se lit dans un toast (inv. #4 — jamais un écran qui montre un réglage
// que la base n'a pas).

import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setAgentModelAndEffortAction } from '@/lib/actions.ts';
import { REASONING_LABELS, type ModelChoice } from '@/lib/model-choices.ts';

/** La valeur nulle en base = « Auto » : le runner décide. */
const AUTO_LABEL = 'Auto';

/** Ce que la pastille dit d'elle-même — la portée du réglage, en une phrase. */
export const CHIP_TITLE = "Sets the agent's model for every channel";

function effortLabel(effort: string | null): string {
  if (effort === null) return AUTO_LABEL;
  return REASONING_LABELS[effort] ?? effort;
}

export default function ModelEffortChip({
  agentId,
  model,
  reasoningEffort,
  modelOptions,
  effortsByModel,
}: {
  agentId: string;
  model: string;
  /** null = Auto. */
  reasoningEffort: string | null;
  /** Le catalogue curé du fournisseur de la clé de l'agent (pas de liste en direct). */
  modelOptions: ModelChoice[];
  /**
   * Les paliers que CHAQUE modèle proposé offre, calculés côté serveur avec la
   * règle du catalogue. Par modèle et non pour le seul modèle courant : changer
   * de modèle doit pouvoir laisser tomber un effort que le nouveau n'offre pas,
   * exactement comme l'écran d'édition — et la pastille ne peut pas le savoir
   * sans le fournisseur.
   */
  effortsByModel: Record<string, string[]>;
}) {
  // L'état AFFICHÉ : il ne bouge qu'après un écrit réussi.
  const [current, setCurrent] = useState<{ model: string; effort: string | null }>({
    model,
    effort: reasoningEffort,
  });
  const [open, setOpen] = useState(false);
  const [isSaving, startSaving] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);

  // Le réglage peut changer ailleurs (l'écran de l'agent) : la page relue
  // repasse les props, et la pastille suit plutôt que de figer sa copie.
  useEffect(() => {
    setCurrent({ model, effort: reasoningEffort });
  }, [model, reasoningEffort]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent): void {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function apply(next: { model: string; effort: string | null }): void {
    if (next.model === current.model && next.effort === current.effort) {
      setOpen(false);
      return;
    }
    setOpen(false);
    startSaving(async () => {
      const r = await setAgentModelAndEffortAction({
        agentId,
        model: next.model,
        reasoningEffort: next.effort,
      });
      if (!r.ok) {
        // L'ancienne valeur RESTE affichée : elle est celle de la base.
        toast.error(r.message);
        return;
      }
      setCurrent(next);
    });
  }

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        data-testid="model-effort-chip"
        title={CHIP_TITLE}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={isSaving}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-rule-2 px-2 py-1 text-mono-12 hover:bg-hover disabled:opacity-60"
      >
        <span className="text-feed-model">{current.model}</span>
        <span className="text-ink-4">·</span>
        <span className="text-feed-metric">
          {isSaving ? 'Saving…' : effortLabel(current.effort)}
        </span>
        <span aria-hidden="true" className="text-ink-4">
          ⌄
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Model and reasoning effort"
          data-testid="model-effort-popover"
          className="absolute bottom-full left-0 z-20 mb-1.5 max-h-[320px] w-[280px] overflow-y-auto rounded-xl border border-rule-2 bg-paper p-2 shadow"
        >
          <p className="px-2 pt-1 pb-1.5 text-mono-12 text-ink-4">Model</p>
          <div role="radiogroup" aria-label="Model">
            {modelOptions.map((option) => (
              <OptionRow
                key={option.modelId}
                label={option.label}
                hint={option.label === option.modelId ? null : option.modelId}
                selected={option.modelId === current.model}
                onSelect={() =>
                  apply({
                    model: option.modelId,
                    // Un effort que le nouveau modèle n'offre pas repasse à
                    // Auto — même geste que l'écran d'édition. Sans lui
                    // l'action refuserait le couple, et le clic ne ferait rien
                    // de lisible.
                    effort:
                      current.effort !== null &&
                      (effortsByModel[option.modelId] ?? []).includes(current.effort)
                        ? current.effort
                        : null,
                  })
                }
              />
            ))}
          </div>

          <p className="mt-2 px-2 pt-1 pb-1.5 text-mono-12 text-ink-4">Reasoning effort</p>
          <div role="radiogroup" aria-label="Reasoning effort">
            <OptionRow
              label={AUTO_LABEL}
              hint={null}
              selected={current.effort === null}
              onSelect={() => apply({ model: current.model, effort: null })}
            />
            {(effortsByModel[current.model] ?? []).map((value) => (
              <OptionRow
                key={value}
                label={REASONING_LABELS[value] ?? value}
                hint={null}
                selected={current.effort === value}
                onSelect={() => apply({ model: current.model, effort: value })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionRow({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string;
  hint: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${selected ? 'bg-ink' : 'bg-transparent'}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-13 text-ink">{label}</span>
        {hint !== null && <span className="block truncate text-mono-12 text-ink-4">{hint}</span>}
      </span>
    </button>
  );
}
