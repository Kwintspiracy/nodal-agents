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

interface CreateProps {
  mode?: 'create';
  initial?: undefined;
}

interface EditProps {
  mode: 'edit';
  initial: SkillRow;
}

type Props = CreateProps | EditProps;

export default function SkillForm(props: Props) {
  const isEdit = props.mode === 'edit';
  const router = useRouter();
  const [open, setOpen] = useState(isEdit);
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
        router.push('/skills');
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
        setOpen(false);
      });
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-4 py-2 text-sm font-medium bg-ink text-canvas rounded-lg hover:brightness-[0.92]"
      >
        + New skill
      </button>
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
          <button
            type="button"
            onClick={() => setConfirmResetOpen(true)}
            disabled={isPending}
            title="Restore the catalog default content for this skill"
            className="text-xs px-2.5 py-1 rounded border border-warn/30 text-warn hover:bg-warn-bg transition-colors disabled:opacity-50"
          >
            Reset to default
          </button>
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
        <div>
          <label className="block text-xs text-ink-3 mb-1" htmlFor="skill-slug">
            Slug {isEdit && <span className="text-ink-4">(stable — not editable)</span>}
          </label>
          <input
            id="skill-slug"
            name="slug"
            required={!isEdit}
            readOnly={isEdit}
            disabled={isEdit}
            pattern={isEdit ? undefined : '[a-z0-9\\-]+'}
            placeholder="my-skill"
            defaultValue={initial?.slug}
            title={isEdit ? 'Slug is a stable identifier and cannot be changed' : undefined}
            className={
              isEdit
                ? 'w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink-3 cursor-not-allowed font-mono'
                : 'w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono'
            }
          />
        </div>
        <div>
          <label className="block text-xs text-ink-3 mb-1" htmlFor="skill-name">
            Name
          </label>
          <input
            id="skill-name"
            name="name"
            required
            placeholder="My Skill"
            defaultValue={initial?.name}
            className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-ink-3 mb-1" htmlFor="skill-description">
          Description <span className="text-ink-4">(optional)</span>
        </label>
        <input
          id="skill-description"
          name="description"
          maxLength={500}
          placeholder="What does this skill teach the agent?"
          defaultValue={initial?.description ?? ''}
          className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
        />
      </div>

      <div>
        <label className="block text-xs text-ink-3 mb-1" htmlFor="skill-content">
          Instructions
        </label>
        <textarea
          id="skill-content"
          name="content"
          required
          rows={6}
          placeholder="Step-by-step instructions or context the agent gets when this skill is enabled."
          defaultValue={initial?.content}
          className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none resize-y"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-md hover:brightness-[0.92] disabled:opacity-50"
        >
          {isPending
            ? isEdit
              ? 'Saving…'
              : 'Creating…'
            : isEdit
              ? 'Save changes'
              : 'Create skill'}
        </button>
        <button
          type="button"
          onClick={() => (isEdit ? router.push('/skills') : setOpen(false))}
          className="px-4 py-2 text-sm font-medium border border-rule text-ink-3 rounded-md hover:border-rule"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
