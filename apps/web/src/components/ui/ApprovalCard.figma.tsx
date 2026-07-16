import figma from '@figma/code-connect';
import ApprovalCard from './ApprovalCard';

figma.connect(ApprovalCard, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=58-3', {
  example: () => (
    <ApprovalCard
      title="Approve action?"
      agent="AT"
      body={<span>Details</span>}
      actions={<span />}
    />
  ),
});
