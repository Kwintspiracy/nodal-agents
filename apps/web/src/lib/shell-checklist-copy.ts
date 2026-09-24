// shell-checklist-copy.ts — how the owner reads each kind of shell action (#464).
//
// One place for the words, read by the agent's Autonomy tab (the checklist)
// and by the approval card (why a command was held). Two copies would drift,
// and the card would name the kind of action differently from the setting
// that decided it.

import type { ShellCategory } from '@nodal-agents/shared';

export const SHELL_CATEGORY_COPY: Record<ShellCategory, { label: string; summary: string }> = {
  outside_folders: {
    label: 'Read or change files outside its folders',
    summary: 'A path in the command that is not in one of this agent’s folders.',
  },
  own_script: {
    label: 'Run code it wrote itself',
    summary:
      'A script it wrote, or code passed inline (python -c). Such code can do any of the actions below without naming them: set this to Never to rule that out.',
  },
  delete_files: {
    label: 'Delete files or discard changes',
    summary: 'rm, del, Remove-Item, git reset --hard, git clean…',
  },
  install_software: {
    label: 'Install software or packages',
    summary: 'npm, pip, winget, choco, brew install…',
  },
  download: {
    label: 'Download files from the internet',
    summary: 'wget, curl -o, git clone, Invoke-WebRequest…',
  },
  stop_programs: {
    label: 'Stop other programs or services',
    summary: 'kill, taskkill, Stop-Process, systemctl…',
  },
  system_settings: {
    label: 'Change system settings, permissions or disks',
    summary: 'icacls, chmod -R, format, diskpart…',
  },
};
