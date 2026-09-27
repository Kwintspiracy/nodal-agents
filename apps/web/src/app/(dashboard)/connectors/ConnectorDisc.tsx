// ConnectorDisc — le disque de marque d'un connecteur installé, en tête de sa
// ligne de table (#522).
//
// Les tables API Connectors et MCP Connectors le dessinaient chacune à la main,
// avec le même ordre de repli : l'icône de marque sur fond blanc, sinon l'emoji
// (MCP), sinon le monogramme sur la couleur de la marque. Un seul dessin pour
// les deux, posé en `lead` d'une <CellTitle>.

import Disc from '@/components/ui/Disc';
import { connIcon, connEmoji } from './connector-brand.ts';

export default function ConnectorDisc({
  slug,
  glyph,
  color,
}: {
  slug: string;
  /** Le monogramme, quand il n'y a ni icône ni emoji. */
  glyph: string;
  /** La couleur de fond du monogramme ; `undefined` = le bleu connecteur. */
  color: string | undefined;
}) {
  const iconSrc = connIcon(slug);
  const emoji = connEmoji(slug);
  return (
    <Disc
      variant="conn"
      size="sm"
      shape="square"
      background={iconSrc !== null || emoji !== null ? '#ffffff' : color}
    >
      {iconSrc !== null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={iconSrc} alt="" className="h-4 w-4 object-contain" />
      ) : emoji !== null ? (
        <span className="text-body-15 leading-none!">{emoji}</span>
      ) : (
        <span className="font-mono text-micro-10 tracking-[0.04em]">{glyph}</span>
      )}
    </Disc>
  );
}
