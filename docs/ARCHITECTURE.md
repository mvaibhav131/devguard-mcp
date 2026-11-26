# DevGuard MCP — Architecture

Status: describes what Phases 1 and 3 implement: the foundation, git diff analysis, change impact analysis and test discovery. Review rules (Phase 2) and risk assessment (Phase 4) are planned in the roadmap.

## 1. Principles

- **Deterministic.** DevGuard returns facts (diffs, counts, ranges). The AI assistant interprets them. The server never calls an LLM.
- **Thin tools, fat core.** MCP tool handlers validate input, delegate and shape output. Logic lives in services that know nothing about MCP.
- **Ports over frameworks.** Core services talk to small interfaces. The MCP SDK, the filesystem and child processes are confined to a few modules.
- **Degrade, do not fail.** Large results are truncated with an explicit flag and a hint instead of failing or flooding the model context.
- **Arguments are untrusted.** A language model generates every tool argument, so each one is validated like a request from the internet.

## 2. Layers and folders

```
src/
├── index.ts                      process entry: config, logger, stdio transport, shutdown
├── server.ts                     composition root: builds services, registers tools
├── lifecycle.ts                  graceful shutdown, signal and crash handlers
├── config/config.ts              command line and environment parsing
├── tools/                        MCP adapters (Zod schemas, descriptions, error mapping)
│   ├── tool-result.ts            deadline + cancellation, logging, error to tool-result mapping
│   ├── selection-schema.ts       input and output schema parts shared by the change-based tools
│   ├── get-project-info.tool.ts
│   ├── analyze-git-diff.tool.ts
│   ├── analyze-change-impact.tool.ts
│   └── discover-tests.tool.ts
├── core/                         domain logic, no SDK and no I/O imports
│   ├── diff/                     diff service, pure parsers, git port
│   ├── impact/                   import extractor, module resolver, tsconfig paths, import graph, impact service
│   ├── tests/                    test file rules, test discovery service
│   └── project/                  project info service
├── infrastructure/               the only places with side effects
│   ├── process/process-runner.ts spawn without shell: timeout, byte cap, abort
│   ├── git/                      git-runner (allowlist, env), git-args (validators), git-client (typed methods)
│   ├── fs/workspace-fs.ts        workspace root, path confinement, symlink checks, safe text reads
│   └── workspace-source-files.ts file listing through git + safe reads, for the import graph
└── shared/                       errors, logger (stderr), limits, budget, pagination, concurrency, version
tests/{unit,integration,protocol,stdio,fixtures}
```

Boundary rules are enforced by `tests/unit/architecture.test.ts`:

- `core/` imports no SDK, zod, `node:fs`, `node:child_process` or outer layer.
- Only `process-runner.ts` spawns processes and only `workspace-fs.ts` touches the filesystem.
- The MCP SDK is imported only by `index.ts`, `server.ts` and `tools/`; zod only by `tools/`.
- Nothing in `src/` writes to stdout.

To add a tool: write the service in `core/`, add a port method if it needs new git data, add `tools/<name>.tool.ts`, register it in `server.ts`, add its name to `tool-names.ts`.

## 3. Server lifecycle

Transport is stdio: VS Code starts the server as a child process and speaks JSON-RPC 2.0 over stdin and stdout. Logs go to stderr.

| Step | Message | Notes |
|---|---|---|
| 1 | process start | config, workspace root and logger are validated; failure exits with code 1 |
| 2 | `initialize`, `notifications/initialized` | capability negotiation, tools only |
| 3 | `tools/list` | names, descriptions, JSON Schemas generated from Zod |
| 4 | `tools/call` | SDK validates arguments; the tool wrapper adds a deadline and logging |
| 5 | `notifications/cancelled` | aborts the request signal, kills git children, response is discarded |
| 6 | stdin closes | SDK closes the transport, the process exits on its own |

Shutdown. The reliable path is the client closing stdin. `SIGINT` and `SIGTERM` are best effort because Windows may kill the process without a signal. On a signal, an uncaught exception or an unhandled rejection the server closes the transport, waits at most 3 seconds, then exits (0 for signals, 1 for crashes). The server is stateless and holds no locks or temp files, so being killed is safe.

Cancellation. Each call combines the client's cancel signal with a 30 second deadline. The signal reaches the process runner, which kills the git process. A git process also has its own 15 second limit.

## 4. Tools

Every tool is read-only and annotated `readOnlyHint: true`. Results carry `structuredContent` (validated against the tool's `outputSchema` by the SDK) and the same JSON as compact text. Errors are tool results with `isError: true` and text `CODE: message. Hint: ...`.

Error codes: `CONFIG_INVALID`, `INVALID_INPUT`, `INVALID_REF`, `PATH_OUTSIDE_WORKSPACE`, `NOT_A_GIT_REPO`, `GIT_TIMEOUT`, `TIMEOUT`, `GIT_FAILED`, `LIMIT_EXCEEDED`, `INTERNAL`. Unexpected errors are logged in detail and shown to the model only as `INTERNAL` with a reference id.

### get_project_info

Input: none. Output: `server`, `runtime`, `workspace { name, isGitRepo, isRepoRoot, branch, headShortSha, detached }`, `git { available, version, error? }`, `languageScope`, `effectiveLimits`, `tools`. Only the folder name of the workspace is returned, never the full path.

### analyze_git_diff

| Input | Type | Default | Notes |
|---|---|---|---|
| `mode` | `workingTree` / `staged` / `range` | `workingTree` | `workingTree` is `git diff HEAD`; `range` is `base...head` (merge base, like a pull request) |
| `base`, `head` | string | `head` = `HEAD` | only for `range`; resolved to commit ids |
| `includeUntracked` | boolean | `true` | untracked files have `null` line counts |
| `paths` | string[] (max 20) | all | repository-relative, confined to the workspace |
| `limit`, `offset` | int | 50, 0 | `limit` 1 to 200 |

Output: `selection`, `summary` (over all changed files), `hunkCoverage` (`complete`, `partial`, `unavailable`), `files[]` (path, oldPath, status, language, additions, deletions, isBinary, hunks) and `truncation`. Files are ordered by amount of change, then path, so paging is stable. No file contents or patch text are returned.

### analyze_change_impact

Follows imports backwards from the changed files: who imports them, and who imports those.

| Input | Type | Default | Notes |
|---|---|---|---|
| `mode`, `base`, `head`, `includeUntracked`, `paths` | as in `analyze_git_diff` | `workingTree` | where the changed files come from |
| `files` | string[] (max 100) | none | explicit repository-relative files instead of git; cannot be combined with `mode`, `base`, `head` or `paths` |
| `depth` | int 1 to 3 | 2 | import levels to follow |
| `includeTests` | boolean | `true` | include test files in the result |
| `limit`, `offset` | int | 50, 0 | paging over impacted files |

Output: `precision: "heuristic"` (always), `selection`, `changed` counts, `summary` (impacted, direct, transitive, tests), `hotspots` (changed files with the most direct importers), `impacted[]` (path, `direct` or `transitive`, depth, `via` import chain, isTest, ordered by depth then path), `unresolved` (imports of the changed files that could not be resolved), `graph` statistics, `limitations[]` and `truncation`.

Changed files themselves are never listed as impacted. Importers of deleted files and of the old path of renamed files are found, because those paths stay known for the walk.

### discover_tests

Same selection inputs as `analyze_change_impact` (without `includeTests`). Output: `precision: "heuristic"`, `frameworks[]` with evidence (package.json dependencies and `test` script, root configuration files, imports in test files), `changed` counts, `summary`, `mapping[]` (each changed source file with its tests and the evidence `imports-directly`, `imports-transitively` or `name-match`), `untested` (changed source files with no mapped test), `affectedTests`, `suggestedCommands[]` (never executed), `limitations[]` and `truncation`.

"No mapped test" means no import or naming link was found. It is not proof that code is untested, and DevGuard neither runs tests nor measures coverage.

### How imports are found, and what that cannot see

The import graph is rebuilt on every call from the files git lists (so `.gitignore` is respected), skipping `node_modules`, `dist`, `build`, `coverage` and similar folders. A comment, string, template and regex aware scanner finds static `import`, `export ... from`, `import("literal")` and `require("literal")`. Specifiers resolve through relative paths (including `.js` to `.ts` mapping and `index` files), `tsconfig.json` or `jsconfig.json` `paths` and `baseUrl` (relative `extends` followed), and everything else counts as an external package.

| Not covered | Effect |
|---|---|
| computed `import(x)` and `require(x)` | missed edges; counted and reported |
| package.json `imports` (`#alias`), `exports`, workspace packages, project references, nested tsconfig files | reported as unresolved or treated as external |
| barrel files (`export * from`) | a change looks like it affects every importer of the barrel (over-approximation) |
| dependency injection, events, registries, configuration, network contracts | invisible coupling |
| non-source changes (package.json, tsconfig, assets) | not propagated |
| files over 512 KiB, binary files, links, more than 5000 source files | skipped or cut off; reported in `graph` and `limitations` |

A regular-expression and tokenizer based scanner can still be fooled by unusual syntax. Every result says so in `limitations`.

## 5. Bounded output

| Limit | Default | Behaviour when exceeded |
|---|---|---|
| Response payload | 16 KiB | files are cut, `truncation.reason = BYTE_BUDGET`, `nextOffset` and `hint` guide the next call |
| Page size | 50 (max 200) | `FILE_LIMIT` with `nextOffset` |
| Files scanned | 5000, git output 4 MiB | `SCAN_LIMIT`, counts are lower bounds |
| Patch output | 2 MiB | `hunkCoverage` becomes `partial` |
| Hunks per file | 20 | `hunksTruncated` |
| Source files read for the import graph | 5000 files, 512 KiB each, 16 reads at a time | extra files are skipped; `graph.limited` and `limitations` say so, `truncation.reason = SCAN_LIMIT` |
| Git process / tool call | 15 s / 30 s | `GIT_TIMEOUT` / `TIMEOUT` |

At least one item is always returned so that paging makes progress. Timeouts are errors, not partial results.

## 6. Security decisions

| Area | Decision |
|---|---|
| Workspace root | configured with `--workspace-root` or `DEVGUARD_WORKSPACE_ROOT`; canonical path; filesystem root, home directory and its parents are refused; the current directory is a fallback only if it is a git repository root |
| Git execution | `spawn` without shell; allowlisted subcommands (`rev-parse`, `symbolic-ref`, `diff`, `ls-files`, `--version`); typed client methods only |
| Git hardening | `--no-ext-diff`, `--no-textconv`, `-c core.fsmonitor=false`, `--literal-pathspecs`, `--no-pager`, `--no-optional-locks`, sanitized environment without inherited `GIT_*` variables or secrets |
| Refs | strict character grammar (starts alphanumeric, no `..`), then resolved with `rev-parse --verify --end-of-options`; later commands use only full commit ids |
| Paths | repository-relative POSIX form; rejects `..`, absolute, drive, UNC and device paths, control characters, Windows reserved names and alternate data streams; the resolved real path must stay inside the root, so symlinks and junctions cannot escape |
| File reads | only through `readWorkspaceText`: confined path, links and non-files skipped, size cap, binary files skipped; nothing is written anywhere |
| Output | bounded (section 5); errors never expose stack traces; the full workspace path is never returned |
| Logging | JSON lines on stderr, never stdout; the logger never throws |
| Prompt injection | file names and refs are data. They are returned inside JSON fields and never interpreted by the server. The model must treat them as untrusted |
| Supply chain | two runtime dependencies (`@modelcontextprotocol/server`, `zod`), exact versions, committed lockfile |

## 7. Testing

| Layer | Folder | What it proves |
|---|---|---|
| Unit | `tests/unit` | parsers, validators, budget, config, logger, lifecycle, architecture boundaries |
| Security | `tests/unit/path-security`, `git-args`, `tests/integration/git-hardening` | traversal, Windows paths, junction escape, flag injection, repository-defined commands |
| Integration | `tests/integration` | real git in temporary repositories created by `tests/fixtures/fixture-repo.ts` |
| Protocol | `tests/protocol` | a real MCP client against the server in memory: schemas, results, errors, budget |
| Stdio | `tests/stdio` (`npm run test:stdio`) | the compiled server as a child process, clean stdout |

CI runs on Windows and Linux.

## 8. Decisions

- **SDK v2** (`@modelcontextprotocol/server` 2.4.0). v1 is in maintenance. SDK usage is confined to a few modules so churn stays local.
- **ESM and NodeNext**, because the SDK is ESM only. **TypeScript 7**, **Node 22.12 or newer**.
- **Git CLI wrapper** instead of a native library: timeouts, byte caps and an allowlist come for free.
- **One payload, two renderings.** `content` is the compact JSON of `structuredContent`, so clients that only show text still get the data.
- **No `repoPath` input.** The workspace root is fixed by configuration.
- **Metadata-only diff.** Hunk ranges, no patch text.
- **Own import scanner instead of the TypeScript compiler API.** No third runtime dependency, and it works on code that does not compile. The price is the heuristic limits listed above.
- **Graph rebuilt per call.** Stateless and always current. Cost is bounded by the limits; a cache keyed by file timestamps is a Phase 5 option.
- **Tools only.** Resources and prompts are deferred.

## 9. Known limitations and risks

- It is not verified how each VS Code build presents `content` versus `structuredContent` to the model; the response budget assumes the worst case of both being sent.
- VS Code's MCP configuration format is in transition (`.vscode/mcp.json` with `servers` versus `.mcp.json` with `mcpServers`).
- A repository can define clean filters that git runs when comparing the working tree. Repository commands for diffs are disabled, but run DevGuard only on repositories you trust.
- Concurrent tool calls are not rate limited.
- Untracked files have no line counts, and the TypeScript and JavaScript scope is by file extension only.
- Impact and test results are heuristic (see section 4). They are a starting point for review and every result carries `precision: heuristic` and its limitations. Impact and test tools need a git repository, because files are listed through git.
- Test files are recognised by name only (`*.test.*`, `*.spec.*`, `__tests__/`), and a linked test may not exercise the change.
- Planned risk scores (Phase 4) will use fixed documented weights and return every factor with its evidence, so the score is explainable.

## 10. Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | foundation, `get_project_info`, `analyze_git_diff` | done |
| 2 | `review_changes`: deterministic rule engine with evidence | planned |
| 3 | `analyze_change_impact` and `discover_tests` | done |
| 4 | `assess_risk`: fixed weights, factor breakdown, evidence | planned |
| 5 | hardening, progress notifications, optional resources and prompts, npm packaging | planned |
