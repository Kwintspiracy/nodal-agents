import figma from '@figma/code-connect';
import { CheckOk } from './CheckOk';

figma.connect(CheckOk, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=31-39', {
  example: () => <CheckOk>Done</CheckOk>,
});
