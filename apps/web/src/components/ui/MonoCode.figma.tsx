import figma from '@figma/code-connect';
import MonoCode from './MonoCode';

figma.connect(MonoCode, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=51-9', {
  example: () => <MonoCode>npm i nodal-agents</MonoCode>,
});
