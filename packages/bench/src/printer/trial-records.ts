// printer/trial-records.ts — ce que l'imprimante du banc a reçu PENDANT un essai (#794).
//
// Le juge d'un scénario d'impression ne lit pas les arguments d'un appel ni la
// sortie d'un outil : il lit l'enregistrement du serveur du banc, qui a reçu
// les octets. Cette lecture est la même pour tous les scénarios d'impression.
//
// Une demande compte si elle est née pendant l'essai (`receivedAtMs >= début`)
// et si elle tient encore : une demande REMPLACÉE par une plus récente a été
// retirée (le skill d'impression le demande), rien n'en sortirait.
//
// L'observation est SÉRIALISABLE (`--capture` l'écrit telle quelle) : les octets
// n'y sont pas, leur empreinte si, et le texte d'un contenu composé.

import type { BenchPrinterState } from './identity';
import { readRecords, type PrintRecord, type ReadRecord } from './record';

/** Une demande en attente, telle que le juge la lit. */
export interface PrintedRequest {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly pages: PrintRecord['pages'];
  readonly pagesBasis: PrintRecord['pagesBasis'];
  readonly images: PrintRecord['images'];
  readonly source: PrintRecord['source'];
  /** Le texte reçu quand c'est un contenu composé ; null pour un fichier imprimé tel quel. */
  readonly text: string | null;
}

export type TrialRecords =
  | { readonly attached: false; readonly why: string }
  | {
      readonly attached: true;
      /** Les demandes de l'essai qui attendent, de la plus ancienne à la plus récente. */
      readonly live: readonly PrintedRequest[];
      /** Ce qui n'a pas pu être cru dans le dossier (voir `readRecords`). */
      readonly problems: readonly string[];
    };

function printed({ record, bytes }: ReadRecord): PrintedRequest {
  return {
    id: record.id,
    sha256: record.bytes.sha256,
    size: record.bytes.size,
    pages: record.pages,
    pagesBasis: record.pagesBasis,
    images: record.images,
    source: record.source,
    text: record.source.kind === 'content' ? bytes.toString('utf8') : null,
  };
}

export function readTrialRecords(printer: BenchPrinterState, startedMs: number): TrialRecords {
  if (printer.kind === 'absent')
    return {
      attached: false,
      why: 'the bench printer is not attached to this workspace: there is no record to judge',
    };
  if (printer.kind === 'broken') return { attached: false, why: printer.reason };
  const read = readRecords(printer.recordsDir);
  return {
    attached: true,
    live: read.requests
      .filter((r) => r.record.receivedAtMs >= startedMs && r.record.status === 'pending')
      .map(printed),
    problems: read.problems,
  };
}
