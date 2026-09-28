// planner/task-tool-names.ts — the names of the planner's two tools, in a
// module with no dependency, so the tool-name universe
// (router/tool-availability.ts) can know them without importing the tools
// themselves (which import it back).

export const CREATE_TASK_TOOL_NAME = 'create_task';
export const LIST_TASKS_TOOL_NAME = 'list_tasks';
export const TASK_TOOL_NAMES = [CREATE_TASK_TOOL_NAME, LIST_TASKS_TOOL_NAME] as const;
