export const GET_PROJECT_INFO = 'get_project_info';
export const ANALYZE_GIT_DIFF = 'analyze_git_diff';

/** Sorted; tests/protocol compares it with what tools/list actually returns. */
export const TOOL_NAMES: readonly string[] = [ANALYZE_GIT_DIFF, GET_PROJECT_INFO];
