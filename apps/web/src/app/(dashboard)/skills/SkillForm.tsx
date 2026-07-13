'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  createSkillAction,
  updateSkillAction,
  resetSkillToDefaultAction,
  type SkillRow,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';
import RowActionButton from '@/components/ui/RowActionButton';
import TextInput from '@/components/ui/TextInput';
import TextArea from '@/components/ui/TextArea';
import { ModalFooter } from '@/components/ui/Modal';

interface CreateProps {
  mode?: 'create';
  initial?: undefined;
  /** When true the form renders open without the "+ New skill" toggle.
   *  Used by the dedicated /skills/new page and by modal hosts (the modal
   *  itself is the toggle, so the internal one would be redundant). */
  defaultOpen?: boolean;
  /** Closes the wrapping edit/create Modal (UX-B6: list-row skill editing is
   *  a Modal, never an inline accordion or page navigation). When omitted,
   *  this component is page-hosted (/skills/new, /skills/[id]/edit) and
   *  falls back to its original router.push('/skills') navigation. */
  onClose?: () => void;
}

interface EditProps {
  mode: 'edit';
  initial: SkillRow;
  defaultOpen?: undefined;
  /** See CreateProps.onClose. */
  onClose?: () => void;
}

type Props = CreateProps | EditProps;

export default function SkillForm(props: Props) {
  const isEdit = props.mode === 'edit';
  const router = useRouter();
  const [open, setOpen] = useState(isEdit || props.defaultOpen === true);
  const [isPending, startTransition] = useTransition();
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  // Reset-to-default is meaningful only when the user has edited a system
  // skill that still has a catalog default to restore to.
  const canReset =
    isEdit && props.initial.contentOverridden === true && props.initial.defaultContent !== null;

  function handleResetSkill() {
    if (!isEdit) return;
    const skillId = props.initial.id;
    setConfirmResetOpen(false);
    startTransition(async () => {
      const r = await resetSkillToDefaultAction(skillId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success('Skill reset to default');
      router.refresh();
    });
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    if (isEdit && props.mode === 'edit') {
      const payload = {
        id: props.initial.id,
        name: fd.get('name'),
        content: fd.get('content'),
        description: (fd.get('description') as string | null) || undefined,
      };
      startTransition(async () => {
        const r = await updateSkillAction(payload);
        if (!r.ok) {
          toast.error(r.message);
          return;
        }
        toast.success('Skill updated');
        if (props.onClose) {
          props.onClose();
          router.refresh();
        } else {
          router.push('/skills');
        }
      });
    } else {
      startTransition(async () => {
        const r = await createSkillAction({
          slug: fd.get('slug'),
          name: fd.get('name'),
          content: fd.get('content'),
          description: (fd.get('description') as string | null) || undefined,
        });
        if (!r.ok) {
          toast.error(r.message);
          return;
        }
        toast.success('Skill created');
        form.reset();
        if (props.onClose) {
          props.onClose();
          router.refresh();
        } else {
          router.push('/skills');
        }
      });
    }
  }

  if (!open) {
    return (
      <PrimaryButton variant="ink" onClick={() => setOpen(true)}>
        + New skill
      </PrimaryButton>
    );
  }

  const initial = isEdit ? props.initial : undefined;

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-paper border border-rule-2 rounded-xl p-5 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{isEdit ? 'Edit skill' : 'New skill'}</h3>
        {canReset && (
          <RowActionButton
            onClick={() => setConfirmResetOpen(true)}
            disabled={isPending}
            title="Restore the catalog default content for this skill"
            className="!border-warn/30 !text-warn hover:!bg-warn-bg hover:!text-warn"
          >
            Reset to default
          </RowActionButton>
        )}
      </div>
      <ConfirmDialog
        open={confirmResetOpen}
        title="Reset skill to default?"
        message="Your customised instructions will be replaced with the catalog default shipped with NodalAI. This cannot be undone."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        destructive={true}
        onConfirm={handleResetSkill}
        onCancel={() => setConfirmResetOpen(false)}
      />

      <div className="grid grid-cols-2 gap-3">
        <TextInput
          id="skill-slug"
          label={<>Slug {isEdit && <span className="text-ink-4">(stable — not editable)</span>}</>}
          name="slug"
          required={!isEdit}
          readOnly={isEdit}
          disabled={isEdit}
          pattern={isEdit ? undefined : '[a-z0-9\\-]+'}
          placeholder="my-skill"
          defaultValue={initial?.slug}
          title={isEdit ? 'Slug is a stable identifier and cannot be changed' : undefined}
          className={isEdit ? 'cursor-not-allowed font-mono text-ink-3' : 'font-mono'}
        />
        <TextInput
          id="skill-name"
          label="Name"
          name="name"
          required
          placeholder="My Skill"
          defaultValue={initial?.name}
        />
      </div>

      <TextInput
        id="skill-description"
        label={
          <>
            Description <span className="text-ink-4">(optional)</span>
          </>
        }
        name="description"
        maxLength={500}
        placeholder="What does this skill teach the agent?"
        defaultValue={initial?.description ?? ''}
      />

      <TextArea
        id="skill-content"
        label="Instructions"
        name="content"
        required
        rows={18}
        placeholder="Step-by-step instructions or context the agent gets when this skill is enabled."
        defaultValue={initial?.content}
        className="min-h-[440px] leading-relaxed"
      />

      <ModalFooter className="-mx-5 -mb-5 mt-1 rounded-b-xl">
        <PrimaryButton
          variant="neutral"
          onClick={() => (props.onClose ? props.onClose() : router.push('/skills'))}
        >
          Cancel
        </PrimaryButton>
        <PrimaryButton variant="ink" type="submit" disabled={isPending}>
          {isPending
            ? isEdit
              ? 'Saving…'
              : 'Creating…'
            : isEdit
              ? 'Save changes'
              : 'Create skill'}
        </PrimaryButton>
      </ModalFooter>
    </form>
  );
}
