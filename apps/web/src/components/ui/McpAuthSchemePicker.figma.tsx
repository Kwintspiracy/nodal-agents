import figma from '@figma/code-connect';
import McpAuthSchemePicker from './McpAuthSchemePicker';

figma.connect(
  McpAuthSchemePicker,
  'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=59-10',
  {
    example: () => <McpAuthSchemePicker name="scheme" value="header" onChange={() => {}} />,
  },
);
