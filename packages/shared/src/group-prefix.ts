// group-prefix.ts — le préfixe qu'un canal de GROUPE met devant un message.
//
// Dans un salon partagé (groupe Telegram, canal Slack, salon Discord, groupe
// WhatsApp), plusieurs personnes écrivent au même agent. Les handlers
// préfixent donc la tâche par `[Message from Untel]: ` pour que le modèle
// sache QUI parle — c'est une information de contexte, et elle a sa place dans
// la tâche auditée.
//
// Elle n'a AUCUNE place dans le nom du fil. Le titre d'une conversation répond
// à « de quoi ça parle », pas à « qui a écrit le premier message » : préfixé,
// il rend une liste où toutes les lignes commencent par les mêmes crochets et
// où le sujet est coupé par le plafond de 60 caractères (revue Codex, passe
// 29, doute 1).
//
// Ce module est LA règle unique — le runner nomme les nouvelles conversations
// et le web dérive un titre de repli pour celles qui n'en ont pas ; deux
// expressions régulières auraient divergé.

/**
 * Le préfixe de groupe, tel que les quatre handlers l'écrivent. Le nom peut
 * contenir n'importe quoi sauf un crochet fermant (Telegram y glisse aussi le
 * pseudo : `[Message from Paul (@paul)]: `).
 */
const GROUP_PREFIX = /^\[Message from [^\]]*\]:\s*/;

/**
 * Le texte SANS son préfixe de groupe. Rend la chaîne inchangée quand il n'y
 * en a pas — et n'est JAMAIS appliqué à la tâche remise à l'agent, qui doit
 * garder l'identité de celui qui parle.
 */
export function stripGroupPrefix(text: string): string {
  return text.replace(GROUP_PREFIX, '');
}
