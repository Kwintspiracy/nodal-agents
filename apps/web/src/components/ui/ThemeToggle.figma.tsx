import figma from '@figma/code-connect';
import ThemeToggle from './ThemeToggle';

figma.connect(ThemeToggle, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=150-11', {
  example: () => <ThemeToggle />,
});
