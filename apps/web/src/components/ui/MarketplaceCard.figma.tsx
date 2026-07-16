import figma from '@figma/code-connect';
import MarketplaceCard from './MarketplaceCard';

figma.connect(MarketplaceCard, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=54-3', {
  example: () => (
    <MarketplaceCard
      glyph={<span />}
      name="Blender MCP"
      description="Execute Blender operations."
    />
  ),
});
