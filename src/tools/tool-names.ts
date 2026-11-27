export const ANALYZE_CHANGE_IMPACT = 'analyze_change_impact';
export const ANALYZE_GIT_DIFF = 'analyze_git_diff';
export const ASSESS_RISK = 'assess_risk';
export const DISCOVER_TESTS = 'discover_tests';
export const GET_PROJECT_INFO = 'get_project_info';
export const REVIEW_CHANGES = 'review_changes';

/** Sorted; tests/protocol compares it with what tools/list actually returns. */
export const TOOL_NAMES: readonly string[] = [ANALYZE_CHANGE_IMPACT, ANALYZE_GIT_DIFF, ASSESS_RISK, DISCOVER_TESTS, GET_PROJECT_INFO, REVIEW_CHANGES];
