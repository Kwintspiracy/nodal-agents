'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createSkillAction, updateSkillAction, type SkillRow } from '@/lib/actions.ts';

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
        className="px-4 py-2 text-sm font-medium bg-white text-black rounded-lg hover:bg-neutral-200"
      >
        + New skill
      </button>
    );
  }

  const initial = isEdit ? props.initial : undefined;

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3"
    >
      <h3 className="text-sm font-semibold text-white">{isEdit ? 'Edit skill' : 'New skill'}</h3>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="skill-slug">
            Slug {isEdit && <span className="text-neutral-700">(stable — not editable)</span>}
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
                ? 'w-full bg-neutral-800/40 border border-neutral-700/50 rounded-md px-2 py-1.5 text-sm text-neutral-500 cursor-not-allowed font-mono'
                : 'w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono'
            }
          />
        </div>
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="skill-name">
            Name
          </label>
          <input
            id="skill-name"
            name="name"
            required
            placeholder="My Skill"
            defaultValue={initial?.name}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-neutral-500 mb-1" htmlFor="skill-description">
          Description <span className="text-neutral-700">(optional)</span>
        </label>
        <input
          id="skill-description"
          name="description"
          maxLength={500}
          placeholder="What does this skill teach the agent?"
          defaultValue={initial?.description ?? ''}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
      </div>

      <div>
        <label className="block text-xs text-neutral-500 mb-1" htmlFor="skill-content">
          Instructions
        </label>
        <textarea
          id="skill-content"
          name="content"
          required
          rows={6}
          placeholder="Step-by-step instructions or context the agent gets when this skill is enabled."
          defaultValue={initial?.content}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none resize-y"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
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
          className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-400 rounded-md hover:border-neutral-600"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
