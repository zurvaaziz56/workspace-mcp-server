# workspace-mcp-server (v2 — multi-root)

Read-only MCP (Model Context Protocol) server that exposes your workspaces — projects, daily logs, files, and **cross-workspace full-text search** — to any MCP client (Claude Desktop, Claude Code, or anything else that speaks MCP over stdio).

Everything is **read-only**: no tool can create, edit, or delete workspace files, so it's safe to connect from any client.

## Registered workspaces

Configured in `workspaces.json` (copy [workspaces.example.json](workspaces.example.json) to start):

| Name | Folder |
|---|---|
| `homebase` | `~/workspace` (main operations folder) |
| `linkedin` | `~/linkedin-content` (a second content workspace) |

**To add a new workspace:** add a line to `workspaces.json` (`"name": "/absolute/path"`). No rebuild needed — the server reads it at startup.

## Tools

| Tool | What it does |
|---|---|
| `workspace_list_workspaces` | List registered roots with file counts and structure info |
| `workspace_list_projects` | List projects under each workspace's `02 Projects/` folder |
| `workspace_get_project` | One project's overview content + file listing (fuzzy name match, e.g. `cybersecurity-firm`) |
| `workspace_list_files` | Browse files in one or all workspaces, extension filter, paginated |
| `workspace_read_file` | Read any text file; auto-locates across workspaces, `workspace:path` prefixes supported |
| `workspace_search` | Full-text search across **all workspaces in one query**, scopeable by workspace/folder |
| `workspace_recent_activity` | Recently modified files across all roots, newest first |
| `workspace_get_daily_log` | Session logs from any workspace with a `01 Daily Logs/` folder |

Every tool takes a `workspace` parameter: a registered name or `all` (the default). Results are labeled `workspace:path` (e.g. `homebase:CLAUDE.md`), and `workspace_read_file` accepts that same prefix form, so results round-trip directly into reads. If a bare path exists in more than one workspace, the server returns a disambiguation error instead of guessing.

Not covered: binary files (`.pdf`, `.docx`, `.skill`) are listed but can't be read or searched; hidden directories (including `.claude/`), `node_modules`, and this server's own folder are excluded from results.

## Setup

Build once (already done if `dist/` exists):

```bash
cd workspace-mcp-server
npm install && npm run build
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "workspace": {
      "command": "node",
      "args": ["/absolute/path/to/workspace-mcp-server/dist/index.js"]
    }
  }
}
```

### Claude Code

Register it per project with `.mcp.json`, or globally:

```bash
claude mcp add workspace -- node "/absolute/path/to/workspace-mcp-server/dist/index.js"
```

### Root configuration precedence

1. `WORKSPACE_ROOTS` env var — `name=/abs/path;name2=/abs/path2`
2. `workspaces.json` next to `package.json` (the normal mechanism)
3. `WORKSPACE_ROOT` env var (legacy single root)
4. Built-in default (`~/workspace`)

Missing roots are skipped with a warning on stderr rather than failing startup.

## Security notes

- Path inputs are resolved and confined to their workspace root — traversal (`../`) and absolute paths outside are rejected with a clear error, per root.
- No network access, no write operations, no shell execution. All tool annotations declare `readOnlyHint: true`.
- Logging goes to stderr only (stdio transport keeps stdout clean for JSON-RPC).

## Development

```bash
npm run dev      # watch mode via tsx
npm run build    # compile to dist/
npx @modelcontextprotocol/inspector node dist/index.js   # interactive testing
```

Source layout: `src/index.ts` (server + tool registrations), `src/workspace.ts` (multi-root filesystem helpers). Evaluation questions for testing agent effectiveness live in `evaluation.xml`. They are written against the companion `ai-content-operations` portfolio repo: register that repo as a workspace to run them.

Built with Claude Code.
