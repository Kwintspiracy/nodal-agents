import figma from '@figma/code-connect';
import MetricCard from './MetricCard';

figma.connect(MetricCard, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=50-3', {
  props: {
    label: figma.string('Label'),
    value: figma.string('Value'),
  },
  example: ({ label, value }) => <MetricCard label={label} value={value} />,
});
