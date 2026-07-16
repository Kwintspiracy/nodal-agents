import figma from '@figma/code-connect';
import LiveCard from './LiveCard';

figma.connect(LiveCard, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=57-3', {
  example: () => <LiveCard runningAgents={3} throughput="12 / min" fill={0.6} />,
});
