import figma from '@figma/code-connect';
import Table, { THead, Th, Tr, Td, TableSegmentRow } from './Table';

// Composant assemblé (cadre + THead + rows) — node 230:427
figma.connect(Table, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=230-427', {
  example: () => (
    <Table>
      <THead>
        <Th>Skill</Th>
        <Th>Assigned to</Th>
        <Th align="right">Actions</Th>
      </THead>
      <tbody>
        <Tr>
          <Td>Citation discipline</Td>
          <Td>Unassigned</Td>
          <Td align="right">Edit</Td>
        </Tr>
      </tbody>
    </Table>
  ),
});

// Cellule d'en-tête — set 230:9 (axe Align)
figma.connect(Th, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=230-9', {
  props: {
    align: figma.enum('Align', { Left: 'left', Right: 'right' }),
  },
  example: ({ align }) => <Th align={align}>Skill</Th>,
});

// Rangée d'en-tête de segment (pattern provenance de /skills) — node 230:14
figma.connect(
  TableSegmentRow,
  'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=230-14',
  {
    example: () => <TableSegmentRow label="Community" count={4} dot="bg-skill-vivid" colSpan={4} />,
  },
);
