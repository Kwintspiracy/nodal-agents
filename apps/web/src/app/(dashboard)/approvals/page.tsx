import Link from 'next/link';
import { Clock } from '@phosphor-icons/react/dist/ssr';
import { listApprovalsAction } from '@/lib/actions.ts';
import ApprovalCard from '@/components/ui/ApprovalCard';
import StatusPill from '@/components/ui/StatusPill';
import type { StatusVariant } from '@/components/ui/StatusPill';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import ApprovalActions from './ApprovalActions.tsx';
import QuestionActions from './QuestionActions.tsx';
import { readQuestionToolInput } from '@nodal-agents/shared';

export const dynamic = 'force-dynamic';

const STATUS_TO_VARIANT: Record<string, StatusVariant> = {
  pending: 'run',
  approved: 'done',
  rejected: 'warn',
  expired: 'idle',
};

const TABS = ['pending', 'approved', 'rejected', 'expired', 'all'] as const;
type Tab = (typeof TABS)[number];

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function ApprovalsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const rawStatus = sp.status;
  const status: Tab =
    rawStatus === 'approved' ||
    rawStatus === 'rejected' ||
    rawStatus === 'expired' ||
    rawStatus === 'all'
      ? rawStatus
      : 'pending';

  const result = await listApprovalsAction({ status });
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
        <>
          {result.data.length} {status === 'all' ? '' : status} approval
          {result.data.length === 1 ? '' : 's'}
        </>
      }
      toolbar={
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
      }
    >
      {result.data.length === 0 ? (
        <EmptyState
          title={
            status === 'pending'
              ? 'No pending approvals. Tools that require approval show up here.'
              : `No ${status} approvals.`
          }
        />
      ) : (
        <div className="space-y-3">
          {result.data.map((a) => {
            // P10a — une QUESTION ne se lit pas comme une approbation : ce que
            // l'agent demande n'est pas « puis-je faire ceci » mais « laquelle ».
            // La ligne le dit (`kind`), on ne le devine pas depuis son outil.
            const question = a.kind === 'question' ? readQuestionToolInput(a.toolInput) : null;
            return (
              <ApprovalCard
                key={a.id}
                icon={<Clock size={18} />}
                title={
                  question ? (
                    <span className="text-medium-14 text-ink">{question.question}</span>
                  ) : (
                    <span className="text-medium-14 text-ink">{a.explanation.what}</span>
                  )
                }
                agent={`${a.agentName ?? 'no agent'} · ${a.status}`}
                body={
                  <div className="space-y-1">
                    {question ? (
                      // P10a — la question de l'agent, sa voix seule. Pas de ligne
                      // d'impact ni de provenance : une question ne fait rien, et
                      // ce qu'il faut pour choisir est le contexte qu'il a écrit.
                      <div className="space-y-1.5 rounded-md border border-rule-2 bg-canvas px-3 py-2">
                        <p className="text-body-13 text-ink-2 italic">« {question.question} »</p>
                        {question.context && (
                          <p className="text-body-12 text-ink-2">{question.context}</p>
                        )}
                        <ul className="space-y-0.5 pt-0.5">
                          {question.options.map((o) => (
                            <li key={o} className="text-body-12 text-ink-2">
                              · {o}
                            </li>
                          ))}
                        </ul>
                        {a.status === 'approved' && a.answer !== null && (
                          <p className="text-body-13 text-ink">Answered: {a.answer}</p>
                        )}
                        {a.status === 'rejected' && (
                          <p className="text-body-13 text-ink">Declined</p>
                        )}
                        <p className="text-micro-10 text-ink-3">{a.toolName}</p>
                      </div>
                    ) : (
                      (() => {
                        // The agent's own words stay first and verbatim (invariant #2
                        // applies — its voice), clearly quoted so they read as a claim
                        // rather than a platform verdict. An ABSENT purpose is stated:
                        // "the agent did not say why" is information.
                        const x = a.explanation;
                        return (
                          <div className="space-y-1.5 rounded-md border border-rule-2 bg-canvas px-3 py-2">
                            <p className="text-body-13 text-ink-2 italic">
                              {x.purpose
                                ? `« ${x.purpose} »`
                                : "L'agent n'a pas expliqué pourquoi."}
                            </p>

                            <p className="text-body-12 text-warn">
                              ⚠️ {x.effectLabel}
                              {x.target && <span className="text-ink-2"> → {x.target}</span>}
                            </p>

                            {/* Provenance: WHOSE tool this is. For a third-party
                            server this is the load-bearing fact — the product
                            did not write this tool and says so. */}
                            {x.provenance.kind === 'mcp' && (
                              <div className="space-y-1 rounded border border-rule bg-paper px-2.5 py-1.5">
                                <p className="text-body-12 text-ink-2">
                                  Serveur MCP{' '}
                                  <span className="text-ink">
                                    {x.provenance.name ?? x.provenance.slug}
                                  </span>
                                  {x.provenance.endpoint && (
                                    <span className="text-ink-3"> · {x.provenance.endpoint}</span>
                                  )}
                                </p>
                                {x.provenance.supplied && (
                                  <>
                                    <p className="text-micro-10 text-ink-3">
                                      Description fournie par ce serveur — texte tiers, non vérifié
                                    </p>
                                    <p className="text-body-12 text-ink-2">
                                      {x.provenance.supplied}
                                    </p>
                                  </>
                                )}
                              </div>
                            )}

                            {/* Deterministic impact, only for tools the product
                            ships. Null for third-party tools, where it has no
                            basis to claim anything. */}
                            {x.impact && <p className="text-body-12 text-ink-2">{x.impact}</p>}

                            {x.args.length > 0 && (
                              <dl className="space-y-0.5 pt-0.5">
                                {x.args.map((arg) => (
                                  <div key={arg.key} className="flex gap-2 text-mono-12">
                                    <dt className="shrink-0 text-ink-3">{arg.key}</dt>
                                    <dd className="min-w-0 break-all text-ink-2">
                                      {arg.value}
                                      {/* PRIVILEGE-003 : la longueur réelle, sinon
                                      « tronqué » ne dit pas si 20 caractères
                                      manquent ou 20 000. */}
                                      {arg.truncated && (
                                        <span className="text-ink-3">
                                          {' '}
                                          ({arg.fullLength} caractères, 300 affichés)
                                        </span>
                                      )}
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            )}

                            <p className="text-micro-10 text-ink-3">{a.toolName}</p>
                          </div>
                        );
                      })()
                    )}
                    <div>
                      {a.agentName ? (
                        <>
                          by{' '}
                          <Link href="/agents" className="text-ink-2 hover:text-ink">
                            {a.agentName}
                          </Link>
                        </>
                      ) : (
                        <span className="text-ink-4">no agent</span>
                      )}
                      {a.requestedAt && (
                        <span className="text-ink-3">
                          {' '}
                          · requested {new Date(a.requestedAt).toLocaleString()}
                        </span>
                      )}
                      {a.status === 'pending' && a.expiresAt && (
                        <span className="text-ink-3">
                          {' '}
                          · expires {new Date(a.expiresAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {a.jobTask && <p className="italic text-ink-3">&ldquo;{a.jobTask}&rdquo;</p>}
                    <details className="mt-1 rounded-md border border-rule bg-canvas">
                      <summary className="cursor-pointer px-3 py-2 text-body-12 text-ink-3 hover:text-ink-2">
                        Tool input
                      </summary>
                      <pre className="whitespace-pre-wrap break-words px-3 pb-3 text-mono-12 text-ink-2">
                        {JSON.stringify(a.toolInput, null, 2)}
                      </pre>
                    </details>
                    {a.status !== 'pending' && a.notes && (
                      <p className="italic text-ink-3">
                        Note: {a.notes}
                        {a.resolvedBy ? ` (by ${a.resolvedBy})` : ''}
                      </p>
                    )}
                  </div>
                }
                meta={
                  <div className="flex flex-col items-end gap-2">
                    <StatusPill variant={STATUS_TO_VARIANT[a.status] ?? 'idle'} label={a.status} />
                    <Link
                      href={`/jobs/${a.jobId}`}
                      className="rounded-md border border-rule-2 px-2.5 py-1 text-medium-12 text-ink-3 transition-colors hover:border-rule hover:text-ink"
                    >
                      View job
                    </Link>
                  </div>
                }
                // Five graduated-consent buttons do not fit a shrink-0 column —
                // they squeezed the body into an unreadable strip.
                actionsPlacement="below"
                actions={
                  a.status !== 'pending' ? undefined : question ? (
                    // Une question n'a JAMAIS de « toujours » : répondre la même
                    // chose à toute question future n'est pas une permission
                    // qu'on accorde, c'est une réponse qu'on n'a pas lue.
                    <QuestionActions approvalId={a.id} options={question.options} />
                  ) : (
                    <ApprovalActions
                      approvalId={a.id}
                      toolName={a.toolName}
                      agentId={a.agentId}
                      mcpRulePattern={a.mcpRulePattern}
                      mcpServerName={a.explanation.provenance.name ?? null}
                    />
                  )
                }
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
