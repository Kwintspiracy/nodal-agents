'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Warning } from '@phosphor-icons/react';
import { installCommunitySkillAction, type CommunitySkillInstallResult } from '@/lib/actions.ts';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * InstallCommunitySkillModal — modal for installing a community skill
 * (open Agent Skills / SKILL.md format) from GitHub, a direct URL, or a
 * skills.sh path.
 *
 * Accepts: "owner/repo", a GitHub URL, or a "skills-sh/owner/repo/skill" path.
 * Calls installCommunitySkillAction and renders a script-warning block when
 * the installed skill bundles executable scripts (which run only for an agent
 * with the command-execution capability, once authorized and per-run approved).
 */
export default function InstallCommunitySkillModal({ open, onClose }: Props) {
  const router = useRouter();
  const [source, setSource] = useState('');
  const [isPending, startTransition] = useTransition();
  const [successSkill, setSuccessSkill] = useState<CommunitySkillInstallResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleClose() {
    // Reset state when the modal is closed so re-opening starts fresh.
    setSource('');
    setSuccessSkill(null);
    setErrorMessage(null);
    onClose();
  }

  function handleInstall() {
    if (!source.trim()) return;
    setSuccessSkill(null);
    setErrorMessage(null);

    startTransition(async () => {
      const result = await installCommunitySkillAction(source.trim());
      if (!result.ok) {
        setErrorMessage(result.message);
        toast.error(result.message);
        return;
      }
      setSuccessSkill(result.data);
      toast.success(
        result.data.reinstalled
          ? `Skill "${result.data.name}" reinstalled`
          : `Skill "${result.data.name}" installed`,
      );
      router.refresh();
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Install community skill"
      dismissable={false}
      footer={
        <ModalFooter>
          <PrimaryButton variant="neutral" onClick={handleClose}>
            {successSkill ? 'Close' : 'Cancel'}
          </PrimaryButton>
          {!successSkill && (
            <PrimaryButton
              variant="coral"
              onClick={handleInstall}
              disabled={isPending || !source.trim()}
            >
              {isPending ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Installing…
                </>
              ) : (
                'Install'
              )}
            </PrimaryButton>
          )}
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        {/* Static trust warning — always shown */}
        <div className="flex gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-3">
          <Warning size={16} weight="fill" className="mt-[1px] shrink-0 text-amber-400" />
          <p className="text-[13px] leading-[1.5] text-amber-300">
            Only install skills from sources you trust - a skill&apos;s instructions run with your
            agent&apos;s tools.
          </p>
        </div>

        {/* Source input */}
        <div className="space-y-1.5">
          <label htmlFor="skill-source" className="block text-[13px] font-medium text-ink-2">
            Source
          </label>
          <TextInput
            id="skill-source"
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isPending) handleInstall();
            }}
            placeholder="owner/repo, GitHub URL, or skills.sh path"
            disabled={isPending}
          />
        </div>

        {/* Error state */}
        {errorMessage && !successSkill && (
          <div className="rounded-lg border border-err/30 bg-err/10 px-3.5 py-3">
            <p className="text-[13px] leading-[1.5] text-err">{errorMessage}</p>
          </div>
        )}

        {/* Success state — show script warning if applicable */}
        {successSkill && (
          <div className="space-y-3">
            <div className="rounded-lg border border-ok/30 bg-ok/10 px-3.5 py-3">
              <p className="text-[13px] font-medium leading-[1.5] text-ok">
                {successSkill.reinstalled ? 'Reinstalled' : 'Installed'}:{' '}
                <span className="font-semibold">{successSkill.name}</span>
              </p>
              {successSkill.description && (
                <p className="mt-1 text-[13px] leading-[1.4] text-ok/70">
                  {successSkill.description}
                </p>
              )}
            </div>

            {/* Script warning — only rendered when the skill bundles scripts */}
            {successSkill.installedScripts.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-3">
                <div className="flex gap-2.5">
                  <Warning size={15} weight="fill" className="mt-[1px] shrink-0 text-amber-400" />
                  <div className="space-y-1.5">
                    <p className="text-[13px] font-medium leading-[1.4] text-amber-300">
                      This skill bundles executable scripts.
                    </p>
                    <p className="text-[13px] leading-[1.4] text-amber-300/80">
                      They run only for an agent that has the{' '}
                      <span className="font-mono">command-execution</span> capability and only after
                      you authorize them, and every run is gated by your approval. Otherwise just
                      the skill&apos;s instructions are used.
                    </p>
                    <ul className="mt-2 space-y-0.5">
                      {successSkill.installedScripts.map((s) => (
                        <li
                          key={s.path}
                          className="flex items-center gap-2 font-mono text-[12px] text-amber-300/70"
                        >
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] uppercase">
                            {s.language}
                          </span>
                          <span className="truncate">{s.path}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
