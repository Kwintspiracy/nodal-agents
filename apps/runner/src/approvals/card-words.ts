// approvals/card-words.ts — ce qu'une personne a dit sur une carte, pour la
// tête du run.
//
// Le 18/10 (jobs 039f8666 → 5700457b) : un relecteur délégué demande une
// approbation, la personne la refuse avec une note (« arrête la review,
// imprime, c'est bon ! »). La note n'est allée qu'au relecteur, en résultat
// d'outil ; l'agent qui portait la demande de la personne n'en a rien su, n'a
// reçu qu'un échec, et a délégué de nouveau.
//
// LA RÈGLE : ce que la personne écrit sur une carte d'un run — la note d'une
// approbation ou d'un refus, la réponse d'une question, le formulaire d'un
// serveur MCP — va AUSSI à la tête du run, dans sa file (`agent_jobs.inbox`),
// en plus du résultat d'outil de l'agent qui tient la carte. Toute carte, toute
// profondeur, tout canal : `resolveApprovalDecision` est le seul chemin d'une
// réponse humaine.
//
// Le texte est un CADRE fixe de la plateforme — qui a répondu, à quelle carte,
// la décision, par où — et les mots de la personne, cités tels quels, comme
// des données (invariant #2, cadre de carte autorisé le 04/10). Aucune
// consigne : ce que la tête en fait, c'est sa personnalité qui le dit.
//
// QUI a répondu (revue Reviewer A de #799, passe 1) : le cadre ne présume
// jamais que c'est le propriétaire. Il dit le RÔLE que les données donnent à
// celui qui a répondu — `entity_members.role` pour une personne du dashboard,
// le rôle de la conversation autorisée pour un canal (`responders.ts`) — et
// l'identité que le canal donne. D'où la marque neutre `[PERSON_ON_CARD]` :
// un membre n'y passe jamais pour le propriétaire.

/** La marque du cadre, comme `[REJECTED]` pour un refus. */
export const PERSON_ON_CARD_MARK = '[PERSON_ON_CARD]';

/** La décision prise sur une carte — celle que `resolveApprovalDecision` écrit. */
export type ApprovalDecision = 'approve' | 'reject';

export type CardKind = 'approval' | 'question' | 'elicitation';

/** Le mot de la décision, par sorte de carte : ce que la carte elle-même affiche. */
const DECISION_WORD: Readonly<Record<CardKind, Readonly<Record<ApprovalDecision, string>>>> = {
  approval: { approve: 'approved', reject: 'rejected' },
  question: { approve: 'answered', reject: 'declined' },
  elicitation: { approve: 'sent', reject: 'declined' },
};

/** Celui qui a répondu, tel que les données le donnent (`responders.ts`). */
export interface Responder {
  /** Le rôle stocké (`owner`, `admin`, `member`…), ou `unlisted` quand aucune ligne n'en donne. */
  role: string;
  /** Son identité pour le modèle, écrite par `personForModel` : `user:<id>`, `telegram:<ligne>`… */
  identity: string;
}

export interface CardWordsInput {
  kind: CardKind;
  decision: ApprovalDecision;
  /** Le canal de la réponse, tel que `approval_requests.resolved_by` le garde. */
  resolvedBy: string;
  responder: Responder;
  /** Le job qui tient la carte, et le slug de son agent (null : la ligne n'en nomme aucun). */
  holderJobId: string;
  holderAgentSlug: string | null;
  toolName: string;
  /** Ce que la personne a donné, tel que la ligne le garde. */
  notes: string | null;
  answer: string | null;
  response: Record<string, unknown> | null;
}

/** La carte porte-t-elle un mot de la personne ? Les mêmes champs que `personWordsOnCard` cite. */
export function cardCarriesWords(input: Pick<CardWordsInput, 'notes' | 'answer' | 'response'>) {
  return (
    (input.answer !== null && input.answer.trim() !== '') ||
    (input.response !== null && Object.keys(input.response).length > 0) ||
    (input.notes !== null && input.notes.trim() !== '')
  );
}

/**
 * Le message pour la tête du run, ou `null` quand la carte ne porte aucun mot
 * de la personne (un clic Approve ou Reject seul) : il n'y a rien à citer, et
 * la tête lit l'issue du délégué dans son résultat.
 */
export function personWordsOnCard(input: CardWordsInput): string | null {
  const blocks: string[] = [];
  if (input.answer !== null && input.answer.trim() !== '') {
    blocks.push(`answer:\n${input.answer}`);
  }
  if (input.response !== null && Object.keys(input.response).length > 0) {
    blocks.push(`form:\n${JSON.stringify(input.response)}`);
  }
  if (input.notes !== null && input.notes.trim() !== '') {
    blocks.push(`note:\n${input.notes}`);
  }
  if (blocks.length === 0) return null;
  const header = [
    PERSON_ON_CARD_MARK,
    `by: ${input.responder.role} ${input.responder.identity}`,
    ...(input.holderAgentSlug === null ? [] : [`agent: ${input.holderAgentSlug}`]),
    `job: ${input.holderJobId}`,
    `tool: ${input.toolName}`,
    `card: ${input.kind}`,
    `decision: ${DECISION_WORD[input.kind][input.decision]}`,
    `via: ${input.resolvedBy}`,
  ].join(' · ');
  return [header, ...blocks].join('\n');
}
