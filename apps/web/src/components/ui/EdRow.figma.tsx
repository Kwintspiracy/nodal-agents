import figma from '@figma/code-connect';
import EdRow from './EdRow';

figma.connect(EdRow, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=148-3', {
  example: () => (
    <EdRow name="Blender MCP Execution" description="Execute Blender operations." meta="85 runs" />
  ),
});
