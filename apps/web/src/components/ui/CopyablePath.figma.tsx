import figma from '@figma/code-connect';
import CopyablePath from './CopyablePath';

figma.connect(CopyablePath, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=101-2', {
  example: () => <CopyablePath display="~/.nodalai" value="/home/user/.nodalai" />,
});
