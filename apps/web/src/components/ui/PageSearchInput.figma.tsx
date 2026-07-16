import figma from '@figma/code-connect';
import PageSearchInput from './PageSearchInput';

figma.connect(PageSearchInput, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=34-9', {
  example: () => <PageSearchInput value="" onChange={() => {}} placeholder="Filter…" />,
});
