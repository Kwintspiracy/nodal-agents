// tool-cards.ts — la CHARGE UTILE de chaque carte (plan « De la maquette au
// produit », P1, seconde moitié).
//
// Une carte n'est pas qu'une étiquette. La revue (passes 12 et 13) l'a montré
// sur `table` : `query_memory` rend un tableau nu, `xlsx_read` rend
// `{ sheets: [{ rows }] }` — deux formes pour la même étiquette, et l'écran
// aurait dû dispatcher par NOM d'outil pour savoir où lire les lignes, ce que
// le contrat interdit. Donc chaque carte a UNE forme, écrite ici, et chaque
// outil qui déclare la carte fournit un `present()` qui traduit SA sortie
// dans CETTE forme (modèle DeepSeek Harness : le `meta` de présentation est
// attaché au résultat par l'outil, persisté avec lui, et rejoué tel quel).
//
// La charge utile est PERSISTÉE sur la ligne `tool_calls` au moment de
// l'exécution (`tool_calls.presented`). D'où les plafonds : elle doit rester
// légère — la sortie complète est déjà dans `tool_output`, la carte n'en garde
// que ce qu'il faut pour se dessiner.

import { z } from 'zod';
import { TOOL_CARDS } from './enums';
import type { ToolCard } from './enums';

/** Plafonds de la charge utile — la carte se dessine, elle n'archive pas. */
export const CARD_TEXT_MAX = 4000;
export const CARD_EXCERPT_MAX = 2000;
export const CARD_LABEL_MAX = 400;
export const CARD_ITEMS_MAX = 50;
export const CARD_ROWS_MAX = 50;
export const CARD_CELL_MAX = 200;

const text = (max: number) => z.string().max(max);

/** Une réponse, un accusé (« fait »), ou la RAISON d'un échec — la carte de repli d'un résultat raté. */
export const TextCardSchema = z.object({
  card: z.literal('text'),
  text: text(CARD_TEXT_MAX),
});

/** Le contenu d'un document lu : un extrait, et de quoi dire ce qu'on n'a pas montré. */
export const ReadCardSchema = z.object({
  card: z.literal('read'),
  /** Chemin ou nom de la chose lue ; null quand la sortie ne le porte pas. */
  path: z.string().nullable(),
  excerpt: text(CARD_EXCERPT_MAX),
  /** Longueur du contenu lu, en caractères — l'extrait en montre une partie. */
  chars: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** Nombre de lignes, paragraphes ou diapositives, selon la nature du document. */
  sections: z.number().int().nonnegative().optional(),
});

/** Des correspondances. */
export const SearchCardSchema = z.object({
  card: z.literal('search'),
  query: text(CARD_LABEL_MAX),
  hits: z
    .array(
      z.object({
        title: text(CARD_LABEL_MAX),
        /** URL, chemin, cellule, identifiant — ce qui permet d'y retourner. */
        ref: text(CARD_LABEL_MAX).optional(),
        snippet: text(CARD_LABEL_MAX).optional(),
      }),
    )
    .max(CARD_ITEMS_MAX),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

/** Des fichiers écrits, modifiés ou listés. */
export const FilesCardSchema = z.object({
  card: z.literal('files'),
  files: z
    .array(
      z.object({
        path: text(CARD_LABEL_MAX),
        action: z.enum(['created', 'modified', 'written', 'listed']),
        bytes: z.number().int().nonnegative().optional(),
        /** Ce que l'outil dit de ce fichier (« 3 lignes ajoutées · feuille Data »). */
        detail: text(CARD_LABEL_MAX).optional(),
      }),
    )
    .max(CARD_ITEMS_MAX),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

/** Des lignes à colonnes stables — une ou plusieurs tables (un classeur a des feuilles). */
export const TableCardSchema = z.object({
  card: z.literal('table'),
  tables: z
    .array(
      z.object({
        name: text(CARD_LABEL_MAX).optional(),
        columns: z.array(text(CARD_CELL_MAX)),
        rows: z
          .array(z.array(z.union([text(CARD_CELL_MAX), z.number(), z.null()])))
          .max(CARD_ROWS_MAX),
        /** Nombre de lignes réel — `rows` en montre au plus CARD_ROWS_MAX. */
        total: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
    )
    .min(1),
});

/** Une commande, sa sortie, son code de sortie. */
export const TerminalCardSchema = z.object({
  card: z.literal('terminal'),
  command: text(CARD_EXCERPT_MAX),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stdoutTail: text(CARD_EXCERPT_MAX),
  stderrTail: text(CARD_EXCERPT_MAX),
  cwd: text(CARD_LABEL_MAX).optional(),
});

/** Quelque chose est parti vers un canal. */
export const SentCardSchema = z.object({
  card: z.literal('sent'),
  channel: text(CARD_LABEL_MAX),
  kind: z.enum(['message', 'file', 'image', 'video', 'audio', 'voice', 'dashboard']),
  /** Le destinataire tel que l'outil le connaît (chat, salon), s'il le sait. */
  target: text(CARD_LABEL_MAX).optional(),
  filename: text(CARD_LABEL_MAX).optional(),
  bytes: z.number().int().nonnegative().optional(),
});

/** Un verdict de vérification et ses constats. */
export const ChecksCardSchema = z.object({
  card: z.literal('checks'),
  verdict: z.enum(['pass', 'fail']),
  summary: text(CARD_TEXT_MAX),
  items: z
    .array(
      z.object({
        label: text(CARD_LABEL_MAX),
        ok: z.boolean(),
        ref: text(CARD_LABEL_MAX).optional(),
        severity: text(CARD_LABEL_MAX).optional(),
      }),
    )
    .max(CARD_ITEMS_MAX),
  total: z.number().int().nonnegative(),
});

/** Un travail confié à un autre agent — Nodal ou CLI de code — et sa réponse. */
export const DelegationCardSchema = z.object({
  card: z.literal('delegation'),
  /** Qui a travaillé : un agent, un fournisseur de CLI. */
  to: text(CARD_LABEL_MAX),
  task: text(CARD_EXCERPT_MAX),
  ok: z.boolean(),
  resultText: text(CARD_TEXT_MAX).nullable(),
  error: text(CARD_LABEL_MAX).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nullable(),
  sessionId: text(CARD_LABEL_MAX).nullable().optional(),
});

/** Une question posée à l'utilisateur (P7 — aucun outil ne la déclare encore). */
export const QuestionCardSchema = z.object({
  card: z.literal('question'),
  prompt: text(CARD_TEXT_MAX),
  options: z.array(text(CARD_LABEL_MAX)).optional(),
});

/**
 * Rien de mieux à montrer que l'entrée et la sortie brutes — déjà sur la ligne
 * (`tool_input`, `tool_output`), donc la charge utile ne les répète pas.
 */
export const GenericCardSchema = z.object({
  card: z.literal('generic'),
});

export const ToolCardPayloadSchema = z.discriminatedUnion('card', [
  TextCardSchema,
  ReadCardSchema,
  SearchCardSchema,
  FilesCardSchema,
  TableCardSchema,
  TerminalCardSchema,
  SentCardSchema,
  ChecksCardSchema,
  DelegationCardSchema,
  QuestionCardSchema,
  GenericCardSchema,
]);

export type ToolCardPayload = z.infer<typeof ToolCardPayloadSchema>;
export type CardPayloadFor<C extends ToolCard> = Extract<ToolCardPayload, { card: C }>;

/**
 * Les cartes dont la charge utile a une STRUCTURE — un outil qui déclare l'une
 * d'elles doit fournir `present()`. `text` se déduit de n'importe quelle
 * sortie, `generic` n'a rien à porter, `question` ne naît pas d'un outil.
 */
export const CARDS_NEEDING_PRESENTER: readonly ToolCard[] = TOOL_CARDS.filter(
  (c) => c !== 'text' && c !== 'generic' && c !== 'question',
);
