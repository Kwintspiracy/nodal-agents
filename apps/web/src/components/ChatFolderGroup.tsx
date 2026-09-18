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
//
// Depuis le 18/09/2026, chaque dossier se DÉPLIE (Quentin) : son chevron
// montre ses cinq derniers fils, puis un « See all » vers sa liste. Ce ne sont
// pas d'autres lignes que celles de la liste : `listFolderThreadsAction`
// appelle les MÊMES lectures que la page du dossier, et rend les mêmes titres
// dans le même ordre.
//
// ⚠️ LA LECTURE EST PARESSEUSE, ET ELLE COUVRE TOUS LES DOSSIERS. Un dossier
// est replié par défaut : charger ses fils à chaque rendu de la barre ferait
// payer à toutes les pages du tableau de bord un menu que personne n'a ouvert.
// Elle part donc au PREMIER dépliage, une seule fois, et rapporte les fils de
// tous les dossiers d'un coup — jamais une requête par dossier, qui
// redeviendrait un N+1 au premier canal ajouté.

import { useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  ChatCircleText,
  DiscordLogo,
  PaperPlaneTilt,
  PlugsConnected,
  SlackLogo,
  TelegramLogo,
  WhatsappLogo,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import InboxFolder from './ui/InboxFolder';
import SidebarCaret from './ui/SidebarCaret';
import SidebarRow, { SIDEBAR_ROW } from './ui/SidebarRow';
import { useApprovals } from './ApprovalsProvider';
import { useChatFolders } from './ChatFoldersProvider';
import {
  chatFolders,
  threadCallsFor,
  DASHBOARD_FOLDER,
  MCP_FOLDER,
  type FolderThread,
} from '@/lib/chat-folders.ts';
import {
  listFolderThreadsAction,
  type FolderThreadsSnapshot,
} from '@/lib/folder-threads-actions.ts';

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
  // Une bulle AVEC DES LIGNES, et pas la bulle nue que portait « Channels »
  // juste au-dessus (Quentin, 19/09/2026) : le parent et son premier enfant
  // avaient la même icône. « Channels » a pris un bac ; celui-ci garde la
  // bulle, parce que c'est bien ici qu'on parle.
  [DASHBOARD_FOLDER]: ChatCircleText,
  // Une prise branchée, et pas une bulle : ce dossier n'est pas un endroit où
  // l'on parle, c'est ce qui arrive quand une machine se branche au produit.
  [MCP_FOLDER]: PlugsConnected,
};

/**
 * Ce que dit le sous-menu quand il n'a pas de fil à montrer.
 *
 * Une phrase, pas un lien : elle prend la FORME d'une ligne — mêmes marges,
 * même hauteur, même retrait que les fils qu'elle remplace — sans en prendre
 * le survol, parce qu'il n'y a rien à cliquer.
 */
const THREAD_NOTE = `${SIDEBAR_ROW} pr-2.5 pl-7 text-body-13 text-ink-4`;

/**
 * Le point d'un fil, dans la COLONNE de l'icône de son dossier — même largeur,
 * même retrait, si bien que les points d'un sous-menu et les icônes des
 * dossiers tombent sur une seule verticale.
 *
 * Deux couleurs, et deux seulement : `attention` quand le fil a quelque chose
 * pour la personne, `ink-4` sinon. Il ne clignote pas — ce n'est pas un
 * `LiveDot`, qui dit « ça bouge en ce moment » ; celui-ci dit « il y a de quoi
 * revenir ». Ce que ce rouge veut dire exactement, et ce qu'il ne veut PAS
 * dire, vit avec la règle : `threadCallsFor`, lib/chat-folders.ts.
 */
function ThreadDot({ thread }: { thread: FolderThread }) {
  const appelle = threadCallsFor(thread);
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span
        data-testid="thread-dot"
        data-calls={appelle ? 'yes' : 'no'}
        className={`h-1.5 w-1.5 rounded-full ${appelle ? 'bg-attention' : 'bg-ink-4'}`}
      />
    </span>
  );
}

export default function ChatFolderGroup() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { pending } = useApprovals();
  const { channels, running, externalRuns } = useChatFolders();

  // Quels dossiers sont dépliés. Repliés par défaut : le menu montre les
  // ENDROITS, pas leur contenu, et cinq fils par dossier rendraient la barre
  // plus longue que l'écran dès le deuxième canal branché.
  const [deplies, setDeplies] = useState<Readonly<Record<string, boolean>>>({});
  const [threads, setThreads] = useState<FolderThreadsSnapshot | null>(null);
  /** Ce que la lecture a répondu quand elle a échoué. Jamais un silence. */
  const [erreur, setErreur] = useState<string | null>(null);
  /** Une lecture est-elle déjà partie ? Une ref, pour ne pas la relancer. */
  const lancee = useRef(false);

  const basculer = (key: string): void => {
    setDeplies((etat) => ({ ...etat, [key]: etat[key] !== true }));
    if (lancee.current) return;
    lancee.current = true;
    void listFolderThreadsAction().then((r) => {
      if (r.ok) {
        setThreads(r.data);
        return;
      }
      // Un échec se DIT sous le dossier ouvert, et se retente au prochain
      // dépliage : un sous-menu vide se lirait comme « aucun fil ici ».
      setErreur(r.message);
      lancee.current = false;
    });
  };

  const folders = chatFolders({
    channels,
    waiting: pending,
    running,
    externalRuns,
    pathname,
    folderParam: searchParams.get('folder'),
  });

  return (
    <div className="flex flex-col gap-0.5" data-testid="chat-folders">
      {folders.map((f) => {
        const Icon = FOLDER_ICON[f.key] ?? PaperPlaneTilt;
        const ouvert = deplies[f.key] === true;
        // `null` = la lecture n'a pas encore répondu. Un dossier sans fil, lui,
        // rend un tableau vide : les deux ne se disent pas de la même façon.
        const fils = threads === null ? null : (threads[f.key] ?? []);
        return (
          <div key={f.key}>
            {/* Toute la ligne PLIE le dossier, libellé et chevron (Quentin,
                19/09/2026) : elle ne navigue plus. Le chevron est dans la
                ligne, frère de son bouton, si bien que le survol appartient à
                la ligne entière — il vivait à côté, dans un conteneur sans
                fond, et la ligne s'éclairait à moitié. */}
            <InboxFolder
              folderKey={f.key}
              label={f.label}
              icon={<Icon size={14} className="h-3.5 w-3.5" />}
              waiting={f.waiting}
              running={f.running}
              active={f.active}
              expanded={ouvert}
              onToggle={() => basculer(f.key)}
              caret={
                <SidebarCaret
                  open={ouvert}
                  onToggle={() => basculer(f.key)}
                  label={f.label}
                  testId={`folder-caret-${f.key}`}
                />
              }
            />
            {ouvert && (
              <div className="flex flex-col gap-0.5 pt-0.5" data-testid={`folder-threads-${f.key}`}>
                {erreur !== null ? (
                  <p className={THREAD_NOTE}>{erreur}</p>
                ) : fils === null ? (
                  <p className={THREAD_NOTE}>Loading</p>
                ) : fils.length === 0 ? (
                  <p className={THREAD_NOTE}>Nothing here yet</p>
                ) : (
                  fils.map((t) => (
                    <SidebarRow
                      key={t.key}
                      href={t.href}
                      title={t.title}
                      depth="thread"
                      testId={`folder-thread-${f.key}`}
                    >
                      <ThreadDot thread={t} />
                      <span className="flex-1 truncate leading-5">{t.title}</span>
                    </SidebarRow>
                  ))
                )}
                {/* « See all » mène à la liste ENTIÈRE du dossier — depuis le
                    19/09/2026, c'est la SEULE chose du sous-menu qui y mène,
                    le nom du dossier ne servant plus qu'à plier. Il est là
                    parce que cinq fils ne sont pas tous les fils, et que rien
                    d'autre ne le dirait. */}
                <SidebarRow
                  href={f.href}
                  title="See all"
                  depth="thread"
                  testId={`folder-see-all-${f.key}`}
                >
                  {/* Une place vide de la largeur d'un point : le libellé
                      s'aligne alors sur les titres des fils au-dessus. */}
                  <span className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 truncate leading-5 font-medium!">See all</span>
                  {/* La flèche dit où l'on va, et elle ferme la ligne comme la
                      flèche d'un lien externe ferme la sienne. */}
                  <ArrowRight
                    size={14}
                    weight="bold"
                    data-testid="see-all-arrow"
                    className="h-3.5 w-3.5 shrink-0 text-ink-4"
                  />
                </SidebarRow>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
