'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createSkillAction } from '@/lib/actions.ts';

export default function SkillForm() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    startTransition(async () => {
      const r = await createSkillAction({
        slug: fd.get('slug'),
        name: fd.get('name'),
        content: fd.get('content'),
        description: fd.get('description') || undefined,
      });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Skill created');
        form.reset();
        setOpen(false);
      }
    });
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

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3"
    >
      <h3 className="text-sm font-semibold text-white">New skill</h3>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="skill-slug">
            Slug
          </label>
          <input
            id="skill-slug"
            name="slug"
            required
            pattern="[a-z0-9-]+"
            placeholder="my-skill"
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
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
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none resize-y"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
        >
          {isPending ? 'Creating…' : 'Create skill'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-400 rounded-md hover:border-neutral-600"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
