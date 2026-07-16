import figma from '@figma/code-connect';
import CountPill from './CountPill';

figma.connect(CountPill, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=30-9', {
  example: () => <CountPill items={['read', 'write']} noun="scope" />,
});
