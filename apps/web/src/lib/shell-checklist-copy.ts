// shell-checklist-copy.ts — how the owner reads each kind of shell action (#464).
//
// One place for the words, read by the agent's Autonomy tab (the checklist)
// and by the approval card (why a command was held). Two copies would drift,
// and the card would name the kind of action differently from the setting
// that decided it.

import type { ShellCategory, ShellUnreadSource } from '@nodal-agents/shared';

export const SHELL_CATEGORY_COPY: Record<ShellCategory, { label: string; summary: string }> = {
  inline_code: {
    label: 'Run code written into a command',
    summary: 'python -c, node -e, a script piped into bash, or one it cannot read…',
  },
  delete_files: {
    label: 'Delete files or discard changes',
    summary: 'rm, del, Remove-Item, git reset --hard, git clean…',
  },
  install_software: {
    label: 'Install software or packages',
    summary: 'npm, pip, winget, choco, brew install…',
  },
  // Le périmètre de « Allowed » est dit sur la ligne (#614, revue de la PR
  // #618, passe 3) : un téléchargement hors des dossiers de l'agent demande,
  // et ceux vers le magasin d'un programme de modèles ou d'images restent
  // permis (décision du 28/09 : « ComfyArtist doit juste télécharger les
  // modèles manquants »). Passe 4 : la lecture de la cible est un filet, pas
  // une frontière, et l'écran le dit (#628, un bac à sable de l'OS).
  download: {
    label: 'Download files from the internet',
    summary:
      'wget, curl -o, git clone, hf download, comfy model download, ollama pull… ' +
      'Allowed: into its folders and the model and image stores (comfy, ollama, docker, hf). ' +
      'A target it reads elsewhere (curl -o, wget -O…) asks. Not watertight: what programs write on their own (cp, config files) is not bounded, that takes a sandbox.',
  },
  // #667 : un agent a imprimé par le shell (`Start-Process -Verb Print`) au
  // lieu de l'outil d'impression qui demande à la personne. Ce qui atteint
  // l'écran, une imprimante ou quelqu'un a sa ligne.
  open_or_send: {
    label: 'Open programs, print or send',
    summary: 'start, open, xdg-open, Start-Process, lp, Out-Printer, sendmail…',
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

/** Why a script a command runs could not be read (#635), said next to the file on the card. */
export const UNREAD_COPY: Record<ShellUnreadSource['why'], string> = {
  outside_workspaces: 'outside its workspaces, not read',
  not_found: 'not there yet when the command was read',
  too_large: 'too large to read',
  decided_at_run_time: 'a file decided when the command runs',
  not_a_file: 'not a file',
  unreadable: 'could not be read',
  not_text: 'not text, could not be read',
  over_budget: 'past what is read for one command',
};
