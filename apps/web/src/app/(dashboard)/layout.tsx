import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthError, NoEntityError } from '@nodal-agents/auth';
import Sidebar from '@/components/Sidebar';
import UserMenu from '@/components/UserMenu.tsx';
import ThemedToaster from '@/components/ui/ThemedToaster';
import { ApprovalsProvider, type PendingApproval } from '@/components/ApprovalsProvider';
import { SkillUpdatesProvider, type SkillUpdateNotice } from '@/components/SkillUpdatesProvider';
import { ChatFoldersProvider } from '@/components/ChatFoldersProvider';
import { getChatFoldersAction, type ChatFoldersSnapshot } from '@/lib/conversation-actions.ts';
import { requireUserWithEntity } from '@/lib/server.ts';
import { accountEmail, initialOf } from '@/lib/account.ts';
import {
  listWorkspacesAction,
  listApprovalsAction,
  listSkillUpdatesAction,
  getEntityStatsAction,
  type WorkspaceRow,
} from '@/lib/actions.ts';

// Gate every dashboard route. The proxy only checks cookie *presence*,
// so a stale/invalidated cookie (DB reset, expired session) reaches the
// dashboard, every action throws AuthError, and the user sees "Failed
// to load X" instead of being sent back to /login. Validate here.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  try {
    const h = await headers();
    const req = new Request('http://localhost/', { headers: h });
    await requireUserWithEntity(req);
  } catch (err) {
    if (err instanceof AuthError) redirect('/login');
    if (err instanceof NoEntityError) redirect('/onboarding');
    throw err;
  }

  // First-run gate: a workspace with NO agents hasn't been set up yet — send it
  // to the dedicated full-screen onboarding flow instead of dumping the user on
  // an empty dashboard. We key off agent count (not LLM provider): in local
  // trust the runner auto-seeds an env-derived LLM key on boot, so "has a
  // provider" is almost always true and useless as a fresh-install signal.
  // "Has at least one agent" is the real "is this set up?" line. Once they
  // create their first agent, onboarding stops triggering.
  // Only gate to onboarding on a SUCCESSFUL "zero agents" read. Do NOT redirect
  // when the stats query fails: defaulting a failed read to 0 would bounce a
  // real workspace into onboarding, and — because the onboarding page redirects
  // back to '/' once it sees agentCount > 0 — an intermittent DB failure (e.g.
  // pool exhaustion right after the onboarding click-through) flip-flops the two
  // reads and produces a '/' <-> '/onboarding' redirect loop (blank screen).
  const freshStats = await getEntityStatsAction();
  if (freshStats.ok && freshStats.data.agentCount === 0) redirect('/onboarding');

  // Fetch workspaces server-side so the Sidebar receives them as a prop.
  // Failure is non-fatal — the sidebar falls back to an empty list.
  let workspaces: WorkspaceRow[] = [];
  const wsResult = await listWorkspacesAction();
  if (wsResult.ok) workspaces = wsResult.data;

  // Seed the approvals context with the current pending list for instant
  // first-paint. Non-fatal — the provider will poll and fill in on next tick.
  let initialPending: PendingApproval[] = [];
  const approvalsResult = await listApprovalsAction({ status: 'pending' });
  if (approvalsResult.ok) {
    initialPending = approvalsResult.data.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      toolName: r.toolName,
      agentName: r.agentName,
      toolInput: r.toolInput,
      requestedAt: r.requestedAt,
      jobChannel: r.jobChannel,
      conversationChannel: r.conversationChannel,
    }));
  }

  // Les dossiers du menu Chat (#135) — quels canaux parlent, où un run tourne.
  // Semé ici pour que le menu soit juste au premier rendu ; le provider
  // rafraîchit ensuite. Une lecture en échec laisse le menu à ses deux
  // destinations permanentes, sans faux dossier de canal.
  let initialFolders: ChatFoldersSnapshot = {
    channels: [],
    running: {},
    runningConversationIds: [],
    externalRuns: 0,
    deliverablesToCheck: [],
    deliverableCheckJobIds: [],
    deliverableCheckConversationIds: [],
    runsInProgress: 0,
    workConversationsInProgress: 0,
  };
  const foldersResult = await getChatFoldersAction();
  if (foldersResult.ok) initialFolders = foldersResult.data;

  // QUI est connecté, lu UNE fois : le bloc de compte écrit le courriel en
  // entier, le rond du rail n'en garde que l'initiale (#230). `null` en
  // confiance locale ou sous jeton d'API — il n'y a alors personne à nommer.
  const email = await accountEmail();

  // Seed the skill-updates context the same way — instant first-paint,
  // provider polls and fills in on next tick.
  let initialUpdates: SkillUpdateNotice[] = [];
  const updatesResult = await listSkillUpdatesAction();
  if (updatesResult.ok) initialUpdates = updatesResult.data;

  return (
    <ApprovalsProvider initial={initialPending}>
      <ChatFoldersProvider initial={initialFolders}>
        <SkillUpdatesProvider initial={initialUpdates}>
          {/*
          `h-screen` + `overflow-hidden` : la FENÊTRE ne défile jamais, seule
          la zone de contenu défile (`main > div`). C'est ce que fait toute
          application où la saisie reste en bas — Claude Code, une messagerie.
          Avec `min-h-screen`, le document défilait ; un fil court laissait la
          saisie et la barre d'état au MILIEU de l'écran, là où le contenu
          s'arrêtait (Quentin, 07/09 : « le champ de texte est en plein
          milieu, il descend au fur et à mesure que j'écris »).
        */}
          {/* `fixed inset-0`, et plus `h-[100dvh]` (20/09, Quentin sur iPad) :
            la coquille prend les QUATRE bords de la fenêtre visible, sans
            passer par une hauteur en unités de fenêtre. `100vh` compte la
            barre d'adresse de Safari comme absente (revue Codex, passe 65), et
            `100dvh`, qui devait suivre la hauteur visible, laissait encore sur
            l'iPad une bande de la hauteur de la barre d'état sous le bord :
            la saisie et la barre passaient dessous. Une boîte fixée aux bords
            est la seule mesure que Safari donne juste dans tous les cas. */}
          {/* #242 — le greffier du fil de navigation de #232 est parti avec les
              retours eux-mêmes : plus personne ne lui demande d'où l'on vient.
              On se déplace par la barre latérale, qui reste visible. */}
          <div className="fixed inset-0 flex overflow-hidden bg-canvas text-ink">
            <Sidebar
              workspaces={workspaces}
              userMenu={<UserMenu email={email} />}
              initiale={initialOf(email)}
            />

            {/*
            Main pane sits next to the sidebar on desktop and accounts for the
            mobile top bar (h-16) when narrower. Its gutter reads the SAME
            `--sidebar-w` (app/globals.css) the rail is cut from — two literals
            drifted apart the day one of them changed. There is no
            dashboard-wide top bar: every page's first child is a <PageHeader/>
            that carries the title AND the global controls. Canonical max-width
            is on the inner wrapper.
          */}
            <main className="flex min-w-0 flex-1 flex-col pt-16 lg:ml-[var(--sidebar-w)] lg:pt-0">
              {/*
              `overflow-x-clip`, PAS `overflow-x-hidden` : `hidden` sur un axe
              force l'autre axe à `auto`, ce qui fait de ce bloc le conteneur
              de défilement de référence pour tout `position: sticky` en
              dessous — alors que c'est le document qui défile. Le composer du
              fil (`sticky bottom-7`) et la barre d'état (`sticky bottom-0`)
              ne se collaient donc JAMAIS au bas de l'écran : l'utilisateur
              devait descendre en bas de page pour écrire (Quentin, 07/09).
              `clip` coupe le débordement horizontal sans créer de conteneur.
            */}
              {/*
              La zone qui DÉFILE. `overflow-x-clip` et non `-hidden` : masquer
              un axe force l'autre à `auto`, ce qui ferait de ce bloc un
              conteneur de défilement pour tout `position: sticky` en dessous —
              ici c'en est un exprès, et le collant s'y réfère, ce qui est
              justement voulu.
            */}
              {/*
              `flex flex-col` en plus (20/09) : un écran `fill` (un fil, un run)
              prenait sa hauteur par `h-full`, un POURCENTAGE de ce bloc. Sur
              Safari, le pourcentage ne se résout pas à l'intérieur d'un
              élément flex dimensionné par `flex-1` : la page prenait la hauteur
              de son contenu, la saisie et la barre d'état descendaient sous le
              bord de l'écran, et il fallait défiler (Quentin, sur iPad). En
              colonne flex, l'écran prend le reste par `flex-1`, sans pourcentage,
              et Safari le calcule comme les autres.
            */}
              <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto">
                {children}
              </div>
            </main>

            <ThemedToaster />
          </div>
        </SkillUpdatesProvider>
      </ChatFoldersProvider>
    </ApprovalsProvider>
  );
}
