// shell-checklist-copy.ts — how the owner reads each kind of shell action (#464).
//
// One place for the words, read by the agent's Autonomy tab (the checklist)
// and by the approval card (why a command was held). Two copies would drift,
// and the card would name the kind of action differently from the setting
// that decided it.

import type { ShellCategory } from '@nodal-agents/shared';

export const SHELL_CATEGORY_COPY: Record<ShellCategory, { label: string; summary: string }> = {
  inline_code: {
    label: 'Run code written into a command',
    summary: 'python -c, node -e, a script piped into bash…',
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
