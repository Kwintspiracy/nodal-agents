// setup-hidden-windows.ts — the setup file every test worker loads
// (vitest.base.ts): no process a test starts opens a window on Windows.
// The mechanism and its reason are in hidden-windows.ts.
import { hideTestWindows } from './hidden-windows';

hideTestWindows();
