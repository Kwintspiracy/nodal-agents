import figma from '@figma/code-connect';
import PageTopBar from './PageTopBar';

// The Figma component's slot toggles (Has tabs / Has search / Has CTA) mirror
// the code's optional ReactNode slots — composed per page, no variant prop.
figma.connect(PageTopBar, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=206-14', {
  example: () => <PageTopBar tabs={undefined} search={undefined} cta={undefined} />,
});
