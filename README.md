# DevGuard MCP

An extensible [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI coding assistants **deterministic** engineering facts about a Git repository. The assistant (for example GitHub Copilot in VS Code) interprets the facts; DevGuard never calls an LLM.

Status: Phase 1 (foundation). Planned next: code review rules, change impact analysis, test discovery, risk assessment. TypeScript and JavaScript only for v1.

## Tools

| Tool | What it does |
|---|---|
| `get_project_info` | Connectivity check: server version, runtime, git version, branch, HEAD, active limits |
| `analyze_git_diff` | Changed files with status, additions/deletions, language and changed line ranges for `workingTree`, `staged` or `range` changes. Paged and size-limited |

Both tools are read-only. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for contracts, limits and security decisions.

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

## Troubleshooting

| Symptom | Check |
|---|---|
| Server does not start | Run the command by hand; errors appear as JSON on stderr. `CONFIG_INVALID` means a bad `--workspace-root` |
| `NOT_A_GIT_REPO` | The workspace root must be the top-level folder of the repository |
| `GIT_FAILED` with "owned by another user" | Review the repository, then add it to git `safe.directory` yourself |
| Partial results | `truncation.truncated` is true: follow `truncation.hint` or narrow with `paths` |

