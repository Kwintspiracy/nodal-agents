import figma from '@figma/code-connect';
import ThemedToaster from './ThemedToaster';

// The Figma "Toast" component set models the VISUAL a Sonner toast renders
// with (State variants). In code the toast surface is Sonner itself, themed
// by this wrapper — mounted once in the app shell, then driven by
// `toast.success(...)` / `toast.error(...)` calls, never composed per-toast.
figma.connect(ThemedToaster, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=143-17', {
  example: () => <ThemedToaster />,
});
