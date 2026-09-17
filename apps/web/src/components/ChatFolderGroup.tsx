'use client';

// ChatFolderGroup — le groupe « Chat folders », sous le lien Chat (#135).
//
// Un composant à part, et pas quelques lignes de plus dans `Sidebar`, pour une
// raison précise : il lit `useSearchParams`, que Next veut voir sous une
// frontière `<Suspense>`. L'isoler laisse la barre latérale entière rendre
// sans attendre, et le groupe apparaît à l'intérieur de sa propre frontière.
//
// Tout ce qui décide — quels dossiers existent, leur compte, leur état actif —
// vit dans `lib/chat-folders.ts`, pur et testé. Ici, il ne reste que le rendu.

import { usePathname, useSearchParams } from 'next/navigation';
import {
  ChatCircle,
  DiscordLogo,
  PaperPlaneTilt,
  SlackLogo,
  TelegramLogo,
  WhatsappLogo,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import InboxFolder from './ui/InboxFolder';
import { useApprovals } from './ApprovalsProvider';
import { useChatFolders } from './ChatFoldersProvider';
import { chatFolders, DASHBOARD_FOLDER } from '@/lib/chat-folders.ts';

/**
 * L'icône d'un dossier. Les logos de marque quand le paquet d'icônes en a un —
 * c'est ce qu'on reconnaît du coin de l'œil — et l'avion en papier pour un
 * canal qu'il ne connaît pas : un dossier sans icône se lit comme une ligne
 * cassée.
 */
const FOLDER_ICON: Readonly<Record<string, PhosphorIcon>> = {
  telegram: TelegramLogo,
  slack: SlackLogo,
  discord: DiscordLogo,
  whatsapp: WhatsappLogo,
  [DASHBOARD_FOLDER]: ChatCircle,
};

export default function ChatFolderGroup() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { pending } = useApprovals();
  const { channels, running } = useChatFolders();

  const folders = chatFolders({
    channels,
    waiting: pending,
    running,
    pathname,
    folderParam: searchParams.get('folder'),
  });

  return (
    <div className="flex flex-col gap-0.5" data-testid="chat-folders">
      {folders.map((f) => {
        const Icon = FOLDER_ICON[f.key] ?? PaperPlaneTilt;
        return (
          <InboxFolder
            key={f.key}
            folderKey={f.key}
            label={f.label}
            href={f.href}
            icon={<Icon size={14} className="h-3.5 w-3.5" />}
            waiting={f.waiting}
            running={f.running}
            active={f.active}
          />
        );
      })}
    </div>
  );
}
