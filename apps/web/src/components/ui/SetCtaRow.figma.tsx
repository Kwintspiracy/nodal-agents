import figma from '@figma/code-connect';
import { SetCtaRow } from './SetCtaRow';

figma.connect(SetCtaRow, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=149-30', {
  example: () => <SetCtaRow onCancel={() => {}} />,
});
