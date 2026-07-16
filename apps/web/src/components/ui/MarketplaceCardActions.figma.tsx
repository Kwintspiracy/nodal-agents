import figma from '@figma/code-connect';
import MarketplaceCardActions from './MarketplaceCardActions';

// The Figma component (ApprovalCard page) is a single example instance with
// no exposed properties — the code component's real API (status, ctaVariant,
// onCta/ctaHref, secondary, icon) is documented in its own docstring.
figma.connect(
  MarketplaceCardActions,
  'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=58-16',
  {
    example: () => <MarketplaceCardActions ctaLabel="Install" ctaVariant="blue" onCta={() => {}} />,
  },
);
