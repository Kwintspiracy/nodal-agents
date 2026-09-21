import Link from 'next/link';
import { listApprovalsAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import ApprovalRequestCard from './ApprovalRequestCard.tsx';
import ApprovalsLive from './ApprovalsLive.tsx';

export const dynamic = 'force-dynamic';

const TABS = ['pending', 'approved', 'rejected', 'expired', 'all'] as const;
type Tab = (typeof TABS)[number];

interface PageProps {
  /**
   * `?status=` choisit l'onglet ; `?show=<id>` ouvre UNE demande, quelle que
   * soit sa décision — c'est ce que la section RECENTS de la barre latérale
   * ouvre (Quentin, 20/09) : la carte entière, dans la vue principale, avec
   * ce qui a été décidé.
   */
  searchParams: Promise<{ status?: string; show?: string }>;
}

export default async function ApprovalsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const rawStatus = sp.status;
  const show = typeof sp.show === 'string' && sp.show !== '' ? sp.show : null;
  const status: Tab =
    show !== null
      ? 'all'
      : rawStatus === 'approved' ||
          rawStatus === 'rejected' ||
          rawStatus === 'expired' ||
          rawStatus === 'all'
        ? rawStatus
        : 'pending';

  const lecture = await listApprovalsAction({ status });
  // Une demande ouverte depuis la barre : la liste se réduit à elle, et la page
  // le dit dans son sous-titre plutôt que de la noyer parmi cent autres.
  const result = !lecture.ok
    ? lecture
    : show === null
      ? lecture
      : { ok: true as const, data: lecture.data.filter((a) => a.id === show) };
  if (!result.ok) {
    return (
      <PageShell title="Approvals">
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {result.message}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Approvals"
      subtitle={
        show !== null ? (
          <>
            One request, as it was decided.{' '}
            <Link href="/approvals" className="text-ink-2 hover:text-ink">
              Back to the list
            </Link>
          </>
        ) : (
          <>
            {result.data.length} {status === 'all' ? '' : status} approval
            {result.data.length === 1 ? '' : 's'}
          </>
        )
      }
      // Les onglets ne servent qu'à la LISTE : une demande ouverte seule n'en a
      // pas besoin au-dessus d'elle (Quentin, 20/09).
      toolbar={
        show !== null ? undefined : (
          <div className="flex gap-1.5 text-xs">
            {TABS.map((s) => (
              <Link
                key={s}
                href={s === 'pending' ? '/approvals' : `/approvals?status=${s}`}
                className={`rounded-md px-3 py-1.5 font-medium capitalize transition-colors ${
                  status === s
                    ? 'bg-ink text-canvas'
                    : 'border border-rule-2 text-ink-3 hover:border-rule hover:text-ink'
                }`}
              >
                {s}
              </Link>
            ))}
          </div>
        )
      }
    >
      {/* La page suit le provider de la barre : une demande qui arrive pendant
          qu'on la regarde apparaît, et le rail ne peut plus compter une attente
          que la page dit absente.

          `servi` n'est donné que sur la LISTE DES ATTENTES, parce qu'elle seule
          rend exactement l'ensemble que le provider compte. Il ferme la fenêtre
          entre le rendu serveur et le montage. */}
      <ApprovalsLive
        {...(status === 'pending' && show === null ? { servi: result.data.map((a) => a.id) } : {})}
      />
      {result.data.length === 0 ? (
        <EmptyState
          title={
            show !== null
              ? 'This request was not found. It may have been deleted with its job.'
              : status === 'pending'
                ? 'No pending approvals. Tools that require approval show up here.'
                : `No ${status} approvals.`
          }
        />
      ) : (
        /* UNE carte, ici et dans un process de code. Deux rendus de la même
           décision divergent : l'onglet Code en montrait un plus court, en
           français, sans la moindre mention des règles qui décidaient (#346). */
        <div className="space-y-3">
          {result.data.map((a) => (
            /* `?show=` ouvre la carte dépliée même tranchée : on a cliqué pour
               la lire. La carte ne devine rien de l'URL, la page le lui dit. */
            <ApprovalRequestCard key={a.id} approval={a} defaultOpen={show !== null} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
