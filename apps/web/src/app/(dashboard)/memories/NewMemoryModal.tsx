'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextArea from '@/components/ui/TextArea';
import Select from '@/components/ui/Select';
import FieldLabel from '@/components/ui/FieldLabel';
import { createMemoryAction } from '@/lib/actions';

type Props = {
  open: boolean;
  onClose: () => void;
};

const CATEGORIES = [
  { value: 'context', label: 'Context' },
  { value: 'preference', label: 'Preference' },
  { value: 'outcome', label: 'Outcome' },
  { value: 'learned_rule', label: 'Rule' },
] as const;

type Category = (typeof CATEGORIES)[number]['value'];

const MAX_FACT_CHARS = 2000;

/**
 * Presentational, controlled 1-5 star picker for the "New Memory" form.
 * Distinct from the per-row ImportanceStars in MemoriesClient.tsx — that one
 * persists immediately per-row; this one is just local form state until
 * submit.
 */
function StarPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5" aria-label={`Importance ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          title={`Set importance to ${star}`}
          className="p-0.5 text-ink-4 transition-colors hover:text-amber-500"
        >
          <svg
            viewBox="0 0 16 16"
            className="h-[16px] w-[16px]"
            fill={star <= value ? '#f5a623' : 'none'}
            stroke={star <= value ? '#f5a623' : 'currentColor'}
            strokeWidth="1.3"
          >
            <path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
          </svg>
        </button>
      ))}
    </div>
  );
}

/**
 * NewMemoryModal — manual "New Memory" entry point on /memories. Writes a
 * source='manual' fact via createMemoryAction (same action the onboarding
 * interview uses). Duplicate facts are a no-op there (idempotent), surfaced
 * here as a plain success toast — the fact is already known either way.
 */
export default function NewMemoryModal({ open, onClose }: Props) {
  const router = useRouter();
  const [fact, setFact] = useState('');
  const [category, setCategory] = useState<Category>('context');
  const [importance, setImportance] = useState(3);
  const [isPending, startTransition] = useTransition();

  function handleClose() {
    // Reset so re-opening starts fresh.
    setFact('');
    setCategory('context');
    setImportance(3);
    onClose();
  }

  function handleSubmit() {
    if (!fact.trim() || isPending) return;
    startTransition(async () => {
      const r = await createMemoryAction({ fact: fact.trim(), category, importance });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success('Memory saved');
      router.refresh();
      handleClose();
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New Memory"
      dismissable={false}
      footer={
        <ModalFooter>
          <PrimaryButton variant="neutral" onClick={handleClose}>
            Cancel
          </PrimaryButton>
          <PrimaryButton
            variant="ink"
            onClick={handleSubmit}
            disabled={isPending || !fact.trim()}
            className="disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Saving…
              </>
            ) : (
              'Save memory'
            )}
          </PrimaryButton>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        {/* Fact */}
        <TextArea
          id="memory-fact"
          label="Fact"
          value={fact}
          onChange={(e) => setFact(e.target.value.slice(0, MAX_FACT_CHARS))}
          rows={4}
          maxLength={MAX_FACT_CHARS}
          showCount
          placeholder="e.g. Prefers concise, formal replies."
          disabled={isPending}
        />

        {/* Category */}
        <Select
          id="memory-category"
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          disabled={isPending}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>

        {/* Importance */}
        <div className="space-y-1.5">
          <FieldLabel>Importance</FieldLabel>
          <StarPicker value={importance} onChange={setImportance} />
        </div>
      </div>
    </Modal>
  );
}
