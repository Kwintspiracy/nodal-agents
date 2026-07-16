import figma from '@figma/code-connect';
import BrandMark from './BrandMark';

figma.connect(BrandMark, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=57-10', {
  example: () => <BrandMark />,
});
