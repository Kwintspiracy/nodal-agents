import figma from '@figma/code-connect';
import SearchBox from './SearchBox';

figma.connect(SearchBox, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=34-3', {
  example: () => <SearchBox placeholder="Search agents, skills, runs…" />,
});
