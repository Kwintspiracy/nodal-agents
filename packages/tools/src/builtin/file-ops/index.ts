// file-ops/index.ts — barrel for the 5 workspace-scoped filesystem tools

export { fileReadTool } from './file-read';
export { fileWriteTool } from './file-write';
export { fileEditTool } from './file-edit';
export { fileListTool } from './file-list';
export { fileSearchTool } from './file-search';

export {
  WorkspaceError,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  MAX_SEARCH_FILE_BYTES,
  resolveAndCheckPath,
  assertWorkspacesConfigured,
  getWorkspaceRootForDisplay,
} from './workspace';
