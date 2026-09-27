import figma from '@figma/code-connect';
import Table, {
  THead,
  Th,
  Tr,
  Td,
  TableSegmentRow,
  CellTitle,
  CellAgent,
  CellMono,
  CellMuted,
  CellActions,
} from './Table';
import RowActionButton from './RowActionButton';

// Composant assemblé (cadre + THead + rows) — node 230:427.
//
// Les cellules y sont écrites avec le vocabulaire de #522 (CellTitle,
// CellAgent, CellMono, CellMuted, CellActions) : c'est la composition que la
// planche doit montrer. Ces cellules n'ont pas encore de composant Figma à
// elles ; tant qu'elles n'en ont pas, elles vivent dans cet exemple, et aucun
// `figma.connect` ne pointe vers un nœud inventé.
figma.connect(Table, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=230-427', {
  example: () => (
    <Table>
      <THead>
        <Th>Skill</Th>
        <Th>Assigned to</Th>
        <Th align="right">Runs</Th>
        <Th align="right">Actions</Th>
      </THead>
      <tbody>
        <Tr>
          <Td>
            <CellTitle description="Cite the source of every claim.">Citation discipline</CellTitle>
          </Td>
          <Td>
            <CellAgent name="Agent name" meta="agent-slug" />
          </Td>
          <Td align="right">
            <CellMono>12</CellMono>
          </Td>
          <Td align="right">
            <CellActions>
              <RowActionButton square icon={null} title="Edit" />
            </CellActions>
          </Td>
        </Tr>
        <Tr>
          <Td>
            <CellTitle meta="note-taking">Meeting notes</CellTitle>
          </Td>
          <Td>
            <CellMuted>Unassigned</CellMuted>
          </Td>
          <Td align="right">
            <CellMono>0</CellMono>
          </Td>
          <Td align="right">
            <CellActions>
              <RowActionButton square icon={null} title="Edit" />
            </CellActions>
          </Td>
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
