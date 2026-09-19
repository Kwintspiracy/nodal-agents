import figma from '@figma/code-connect';
import WorkBar from './WorkBar';

// Le node porte encore le retour à gauche : la planche est la trace de ce qui a
// été dessiné, le code celle de ce qui est livré (#242, retraits du 19/09).
figma.connect(WorkBar, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=353-3378', {
  example: () => <WorkBar context={<span>2 agents</span>} />,
});
