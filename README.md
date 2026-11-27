# DevGuard MCP

An extensible [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI coding assistants **deterministic** engineering facts about a Git repository. The assistant (for example GitHub Copilot in VS Code) interprets the facts; DevGuard never calls an LLM.

Status: all planned phases are implemented (foundation, git diff, review rules, change impact, test discovery, risk assessment, hardening and packaging preparation). TypeScript and JavaScript only for v1.

## Tools

| Tool | What it does |
|---|---|
| `get_project_info` | Connectivity check: server version, runtime, git version, branch, HEAD, active limits |
| `analyze_git_diff` | Changed files with status, additions/deletions, language and changed line ranges for `workingTree`, `staged` or `range` changes. Paged and size-limited |
| `review_changes` | Deterministic review rules on the lines your changes add, with evidence: hard-coded secrets (masked in the output), eval, raw HTML, shell injection patterns, disabled TLS verification, `@ts-ignore`, empty catch, `any`, focused or skipped tests, changed files without a test, TODO markers and more. Line based pattern matching, so findings are leads to verify |
| `analyze_change_impact` | Which other files may be affected: follows imports backwards from the changed files, with import chains, hotspots, unresolved imports and an explicit list of limitations. Heuristic |
| `discover_tests` | Detects the test framework, maps changed files to tests (imports or file name), lists changed files without a mapped test and suggests commands to run (never runs them). Heuristic |
| `assess_risk` | Regression risk of the changes as an explainable score (0 to 100, with a band): six fixed-weight factors, each with measured values, evidence, confidence and limitations, plus recommendations. Heuristic |

All tools are read-only. Impact, test and risk results are starting points for review, not proof; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for contracts, weights, limits and what the analysis cannot see.

## Prompt

| Prompt | What it does |
|---|---|---|
| `review_my_changes` | A template you pick in the chat. It tells the assistant to run the four analysis tools in order and to write a structured review report (summary, what changed, impact, test gaps, risk with evidence, recommended actions, limitations and confidence). Optional argument `base`, for example `main`, reviews the current branch like a pull request. It calls no model and only returns instruction text |

## Requirements

- Node.js 22.12 or newer
- git on `PATH`

## Build and test

```powershell
npm install
npm run build        # compiles src/ to dist/
npm test             # unit, integration and protocol tests
npm run test:stdio   # builds, then runs the real server as a child process
```

## Try it with the MCP Inspector

```powershell
npx @modelcontextprotocol/inspector node dist/index.js --workspace-root C:\path\to\your\repo
```

Open the Tools tab, run `get_project_info`, then `analyze_git_diff`.

## Use it from VS Code (GitHub Copilot)

Create `.vscode/mcp.json` in the workspace (the format of VS Code's current local agent):

```json
{
  "servers": {
    "devguard": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js", "--workspace-root", "${workspaceFolder}"]
    }
  }
}
```

Then run **MCP: List Servers** to check that `devguard` is running, switch Copilot Chat to **Agent** mode and ask, for example: *"Use DevGuard to analyse my current git changes."* Copilot asks for approval before each tool call.

VS Code is moving to the Copilot harness, which reads a workspace-root `.mcp.json` with a top-level `mcpServers` key instead. Its documentation does not list `${workspaceFolder}` support, so omit `--workspace-root` there: VS Code normally starts the server from the workspace root, and DevGuard then uses the current directory if it is a git repository root.

If tools do not show up, run **MCP: Reset Cached Tools**.

## Configuration

| Option | Environment variable | Default |
|---|---|---|
| `--workspace-root <absolute path>` | `DEVGUARD_WORKSPACE_ROOT` | current directory, only if it is a git repository root |
| `--log-level <debug\|info\|warn\|error>` | `DEVGUARD_LOG_LEVEL` | `info` |

Command line options win over environment variables. Logs are JSON lines on **stderr**; stdout is reserved for the MCP protocol.

## Security in short

- Read-only by construction: only an allowlist of git subcommands can run, with no shell.
- All paths are confined to the workspace root (traversal, Windows drive/UNC/device paths, symlinks and junctions are rejected).
- Repository-defined commands (`diff.external`, `textconv`, `core.fsmonitor`) are disabled.
- Run DevGuard only on repositories you trust, like any tool that reads a repository.

## Packaging

The package is prepared for npm (`bin`, `files`, `prepack`, `prepublishOnly`) but stays `private` until a license is chosen and publishing is decided. To inspect what would be shipped:

```powershell
npm pack --dry-run
```

Once published, VS Code could start it with `npx -y devguard-mcp --workspace-root ${workspaceFolder}` instead of `node dist/index.js`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Server does not start | Run the command by hand; errors appear as JSON on stderr. `CONFIG_INVALID` means a bad `--workspace-root` |
| `NOT_A_GIT_REPO` | The workspace root must be the top-level folder of the repository |
| `GIT_FAILED` with "owned by another user" | Review the repository, then add it to git `safe.directory` yourself |
| Partial results | `truncation.truncated` is true: follow `truncation.hint` or narrow with `paths` |

