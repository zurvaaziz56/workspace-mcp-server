#!/usr/bin/env node
/**
 * workspace-mcp-server (v2 — multi-root)
 *
 * Read-only MCP server over one or more local workspaces (e.g. an
 * operations folder and a content folder). Exposes projects, daily logs, file
 * listing/reading, cross-workspace full-text search, and recent activity
 * to any MCP client.
 *
 * Transport: stdio. Roots configurable via workspaces.json or WORKSPACE_ROOTS.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  WORKSPACES,
  PROJECTS_DIR,
  DAILY_LOGS_DIR,
  type Workspace,
  type FileEntry,
  workspaceNames,
  resolveWorkspaces,
  resolveWithinRoot,
  parseWorkspacePath,
  walkFiles,
  listSubdirectories,
  searchWorkspaces,
  readTextFileLines,
  isTextFile,
  displayPath,
  formatSize,
  enforceCharacterLimit,
} from "./workspace.js";

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable, 'json' for machine-readable");

const workspaceField = z
  .string()
  .max(100)
  .default("all")
  .describe("Workspace to target: a registered name (e.g. 'homebase', 'linkedin') or 'all' for every workspace (default: 'all')");

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const server = new McpServer({
  name: "workspace-mcp-server",
  version: "2.0.0",
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

function paginate<T>(items: T[], limit: number, offset: number) {
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + page.length < items.length;
  return {
    total: items.length,
    count: page.length,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + page.length } : {}),
    page,
  };
}

/** Find the overview file for a project folder, if one exists. */
function findOverviewFile(files: FileEntry[]): string | undefined {
  return files.find((f) => /overview/i.test(path.basename(f.path)))?.path;
}

function latestModified(files: FileEntry[]): string | undefined {
  return files.length
    ? files.reduce((a, b) => (a.modified > b.modified ? a : b)).modified
    : undefined;
}

interface ProjectSummary {
  workspace: string;
  name: string;
  path: string;
  overview_file?: string;
  file_count: number;
  last_modified?: string;
}

/** Collect project summaries from every workspace that has a projects dir. */
function getProjectSummaries(workspaces: Workspace[]): ProjectSummary[] {
  const out: ProjectSummary[] = [];
  for (const ws of workspaces) {
    for (const name of listSubdirectories(ws, PROJECTS_DIR)) {
      const relPath = `${PROJECTS_DIR}/${name}`;
      const files = walkFiles(ws, relPath);
      out.push({
        workspace: ws.name,
        name,
        path: relPath,
        overview_file: findOverviewFile(files),
        file_count: files.length,
        last_modified: latestModified(files),
      });
    }
  }
  return out;
}

/** Case-insensitive project lookup with substring fallback. */
function matchProject(
  query: string,
  workspaces: Workspace[]
): { match?: ProjectSummary; all: ProjectSummary[] } {
  const all = getProjectSummaries(workspaces);
  const q = query.toLowerCase();
  const match =
    all.find((p) => p.name.toLowerCase() === q) ??
    all.find((p) => p.name.toLowerCase().includes(q));
  return { match, all };
}

function getWorkspaceByName(name: string): Workspace {
  const ws = WORKSPACES.find((w) => w.name === name);
  if (!ws) throw new Error(`Workspace '${name}' is not registered.`);
  return ws;
}

/**
 * Locate a file for reading. Resolution order:
 *   1. Explicit `workspace` parameter
 *   2. "workspace:path" prefix in the path itself
 *   3. Unique match across all workspaces (errors if ambiguous or absent)
 */
function locateFile(
  pathParam: string,
  workspaceParam: string
): { ws: Workspace; relPath: string; abs: string } {
  const parsed = parseWorkspacePath(pathParam);
  let candidates: Workspace[];
  if (workspaceParam && workspaceParam !== "all") {
    candidates = resolveWorkspaces(workspaceParam);
  } else if (parsed.workspace) {
    candidates = [parsed.workspace];
  } else {
    candidates = WORKSPACES;
  }

  const hits = candidates
    .map((ws) => ({ ws, relPath: parsed.relPath, abs: resolveWithinRoot(ws, parsed.relPath) }))
    .filter((h) => fs.existsSync(h.abs));

  if (!hits.length) {
    throw new Error(
      `File '${parsed.relPath}' not found in ${candidates.length === 1 ? `workspace '${candidates[0].name}'` : `any workspace (${workspaceNames().join(", ")})`}. Use workspace_list_files or workspace_search to locate files.`
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `File '${parsed.relPath}' exists in multiple workspaces: ${hits.map((h) => h.ws.name).join(", ")}. Specify one with the 'workspace' parameter or a '${hits[0].ws.name}:' path prefix.`
    );
  }
  return hits[0];
}

// ---------------------------------------------------------------------------
// Tool: workspace_list_workspaces
// ---------------------------------------------------------------------------

server.registerTool(
  "workspace_list_workspaces",
  {
    title: "List Registered Workspaces",
    description: `List every workspace root this server exposes, with its name, filesystem path, file count, and whether it has structured '02 Projects' / '01 Daily Logs' folders.

Call this first when unsure which workspaces exist or which one holds the content you need. Workspace names are used as the 'workspace' parameter on every other tool, and appear as 'name:path' prefixes in results.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  { "total": number, "workspaces": [{ "name": string, "root": string, "file_count": number, "has_projects_dir": boolean, "has_daily_logs": boolean }] }`,
    inputSchema: { response_format: responseFormatField },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ response_format }) => {
    try {
      const rows = WORKSPACES.map((ws) => ({
        name: ws.name,
        root: ws.root,
        file_count: walkFiles(ws).length,
        has_projects_dir: listSubdirectories(ws, PROJECTS_DIR).length > 0,
        has_daily_logs: walkFiles(ws, DAILY_LOGS_DIR, { recursive: false }).length > 0,
      }));
      if (response_format === ResponseFormat.JSON) {
        return textResult(JSON.stringify({ total: rows.length, workspaces: rows }, null, 2));
      }
      const lines = [`# Workspaces (${rows.length})`, ""];
      for (const r of rows) {
        lines.push(`## ${r.name}`);
        lines.push(`- **Root**: ${r.root}`);
        lines.push(`- **Files**: ${r.file_count}`);
        lines.push(`- **Has projects folder**: ${r.has_projects_dir ? "yes" : "no"}`);
        lines.push(`- **Has daily logs**: ${r.has_daily_logs ? "yes" : "no"}`);
        lines.push("");
      }
      return textResult(lines.join("\n"));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: workspace_list_projects
// ---------------------------------------------------------------------------

server.registerTool(
  "workspace_list_projects",
  {
    title: "List Workspace Projects",
    description: `List project folders found in each workspace's '02 Projects' directory.

Returns each project's workspace, name, relative path, overview file (if present), file count, and last-modified timestamp. Workspaces without a projects folder simply contribute no rows. Use workspace_get_project for details on one project.

Args:
  - workspace (string): Workspace name or 'all' (default: 'all')
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  { "total": number, "projects": [{ "workspace": string, "name": string, "path": string, "overview_file": string?, "file_count": number, "last_modified": string? }] }`,
    inputSchema: { workspace: workspaceField, response_format: responseFormatField },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ workspace, response_format }) => {
    try {
      const wss = resolveWorkspaces(workspace);
      const projects = getProjectSummaries(wss);
      if (!projects.length) {
        return textResult(
          `No project folders found under '${PROJECTS_DIR}' in workspace(s): ${wss.map((w) => w.name).join(", ")}. Some workspaces are unstructured — use workspace_list_files to browse them directly.`
        );
      }
      if (response_format === ResponseFormat.JSON) {
        return textResult(JSON.stringify({ total: projects.length, projects }, null, 2));
      }
      const lines = [`# Projects (${projects.length})`, ""];
      for (const p of projects) {
        lines.push(`## ${p.name} (workspace: ${p.workspace})`);
        lines.push(`- **Path**: ${p.workspace}:${p.path}`);
        if (p.overview_file) lines.push(`- **Overview**: ${p.workspace}:${p.overview_file}`);
        lines.push(`- **Files**: ${p.file_count}`);
        if (p.last_modified) lines.push(`- **Last modified**: ${p.last_modified}`);
        lines.push("");
      }
      return textResult(lines.join("\n"));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: workspace_get_project
// ---------------------------------------------------------------------------

server.registerTool(
  "workspace_get_project",
  {
    title: "Get Project Details",
    description: `Get one project's overview document content plus a listing of every file in its folder.

Matches the project by exact name first, then by case-insensitive substring (e.g. 'editorial' matches 'Editorial Agent Build'), searching across all workspaces unless one is specified. If no project matches, the response lists all available projects.

Args:
  - project (string): Project name or substring, e.g. 'Editorial Agent Build' or 'editorial'
  - workspace (string): Workspace name or 'all' (default: 'all')
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: The overview file's full text (if the project has one) and the project's file listing with sizes and modified dates. Use workspace_read_file to read any other file listed.`,
    inputSchema: {
      project: z
        .string()
        .min(1, "Project name is required")
        .max(200)
        .describe("Project name or case-insensitive substring, e.g. 'cybersecurity-firm'"),
      workspace: workspaceField,
      response_format: responseFormatField,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ project, workspace, response_format }) => {
    try {
      const wss = resolveWorkspaces(workspace);
      const { match, all } = matchProject(project, wss);
      if (!match) {
        return textResult(
          `No project matching '${project}'. Available projects: ${all.map((p) => `${p.name} (${p.workspace})`).join(", ") || "(none)"}`
        );
      }
      const ws = getWorkspaceByName(match.workspace);
      const files = walkFiles(ws, match.path);
      let overviewContent: string | undefined;
      if (match.overview_file) {
        try {
          overviewContent = fs.readFileSync(path.join(ws.root, match.overview_file), "utf-8");
        } catch {
          overviewContent = undefined;
        }
      }

      if (response_format === ResponseFormat.JSON) {
        const out = {
          workspace: match.workspace,
          name: match.name,
          path: match.path,
          overview_file: match.overview_file,
          overview_content: overviewContent,
          files,
        };
        return textResult(
          enforceCharacterLimit(
            JSON.stringify(out, null, 2),
            "Use workspace_read_file with offset/limit to read large files directly."
          )
        );
      }

      const lines = [
        `# ${match.name}`,
        "",
        `**Workspace**: ${match.workspace}`,
        `**Path**: ${match.workspace}:${match.path}`,
        "",
      ];
      if (overviewContent) {
        lines.push(`## Overview (${match.overview_file})`, "", overviewContent.trim(), "");
      } else {
        lines.push("_No overview file found for this project._", "");
      }
      lines.push(`## Files (${files.length})`, "");
      for (const f of files) {
        lines.push(`- ${f.path} (${formatSize(f.size)}, modified ${f.modified.slice(0, 10)})`);
      }
      return textResult(
        enforceCharacterLimit(
          lines.join("\n"),
          "Use workspace_read_file with offset/limit to read specific files."
        )
      );
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: workspace_list_files
// ---------------------------------------------------------------------------

server.registerTool(
  "workspace_list_files",
  {
    title: "List Workspace Files",
    description: `List files under a directory in one or all workspaces (recursively by default), with pagination.

Args:
  - workspace (string): Workspace name or 'all' (default: 'all')
  - path (string): Directory relative to each workspace root, e.g. '02 Projects'. Default '' = workspace root. Workspaces lacking the directory contribute no rows.
  - recursive (boolean): Include files in subdirectories (default: true)
  - extension (string): Optional filter by file extension, e.g. '.md'
  - limit (number): Max files to return, 1-200 (default: 50)
  - offset (number): Files to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  { "total": number, "count": number, "offset": number, "has_more": boolean, "next_offset": number?, "files": [{ "workspace": string, "path": string, "size": number, "modified": string, "isText": boolean }] }

Note: hidden directories (dot-prefixed), node_modules, and build output are excluded.`,
    inputSchema: {
      workspace: workspaceField,
      path: z.string().max(500).default("").describe("Directory relative to each workspace root (default: root)"),
      recursive: z.boolean().default(true).describe("Recurse into subdirectories"),
      extension: z.string().max(20).optional().describe("Filter by extension, e.g. '.md'"),
      limit: z.number().int().min(1).max(200).default(50).describe("Max files to return"),
      offset: z.number().int().min(0).default(0).describe("Files to skip for pagination"),
      response_format: responseFormatField,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ workspace, path: relPath, recursive, extension, limit, offset, response_format }) => {
    try {
      const wss = resolveWorkspaces(workspace);
      let files: FileEntry[] = [];
      for (const ws of wss) {
        files.push(...walkFiles(ws, relPath, { recursive }));
      }
      if (extension) {
        const ext = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
        files = files.filter((f) => f.path.toLowerCase().endsWith(ext));
      }
      if (!files.length) {
        return textResult(
          `No files found at '${relPath || "(root)"}' in workspace(s): ${wss.map((w) => w.name).join(", ")}${extension ? ` with extension '${extension}'` : ""}. Check the path with workspace_list_workspaces or workspace_list_projects.`
        );
      }
      const { page, ...meta } = paginate(files, limit, offset);

      if (response_format === ResponseFormat.JSON) {
        return textResult(JSON.stringify({ ...meta, files: page }, null, 2));
      }
      const lines = [
        `# Files in '${relPath || "(workspace root)"}' (${wss.map((w) => w.name).join(", ")})`,
        "",
        `Showing ${meta.count} of ${meta.total}${meta.has_more ? ` (next_offset: ${meta.next_offset})` : ""}`,
        "",
      ];
      for (const f of page) {
        lines.push(`- ${displayPath(f)} (${formatSize(f.size)}, modified ${f.modified.slice(0, 10)})`);
      }
      return textResult(lines.join("\n"));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: workspace_read_file
// ---------------------------------------------------------------------------

server.registerTool(
  "workspace_read_file",
  {
    title: "Read Workspace File",
    description: `Read a text file from a workspace by its relative path.

The file is located automatically: give an explicit 'workspace', use a 'workspace:path' prefix (as shown in search/list results, e.g. 'homebase:CLAUDE.md'), or provide just the relative path — if exactly one workspace contains it, that copy is read. Supports line-based pagination for long files. Binary formats (.pdf, .docx, .skill, images) cannot be read.

Args:
  - path (string): File path relative to a workspace root, optionally prefixed 'workspace:', e.g. 'homebase:CLAUDE.md'
  - workspace (string): Workspace name or 'all' to auto-locate (default: 'all')
  - offset (number): Line number to start from, 0-based (default: 0)
  - limit (number): Max lines to return, 1-2000 (default: 500)

Returns: The file content slice, prefixed with a header stating which lines are shown of the total. If truncated, request further slices via offset.`,
    inputSchema: {
      path: z.string().min(1, "File path is required").max(500).describe("Workspace-relative file path, optionally 'workspace:' prefixed"),
      workspace: workspaceField,
      offset: z.number().int().min(0).default(0).describe("Line to start from (0-based)"),
      limit: z.number().int().min(1).max(2000).default(500).describe("Max lines to return"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ path: pathParam, workspace, offset, limit }) => {
    try {
      const { ws, relPath, abs } = locateFile(pathParam, workspace);
      if (fs.statSync(abs).isDirectory()) {
        return errorResult(`'${relPath}' is a directory. Use workspace_list_files to list it.`);
      }
      if (!isTextFile(abs)) {
        return errorResult(
          `'${relPath}' is not a readable text format. This tool reads .md, .txt, .json and similar text files only.`
        );
      }
      const { content, totalLines, startLine, endLine } = readTextFileLines(abs, offset, limit);
      const header = `# ${ws.name}:${relPath} (lines ${startLine}-${endLine} of ${totalLines})\n\n`;
      return textResult(
        enforceCharacterLimit(header + content, `Request the next slice with offset=${endLine}.`)
      );
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: workspace_search
// ---------------------------------------------------------------------------

server.registerTool(
  "workspace_search",
  {
    title: "Search Workspaces",
    description: `Full-text search across text files in one or all workspaces (case-insensitive substring match).

This is the cross-workspace recall tool: with workspace='all' (default) a single query sweeps every registered root. Binary files (.pdf, .docx, .skill) are skipped; matches are capped at 5 per file.

Args:
  - query (string): Text to search for (plain substring, not regex), 2-200 characters
  - workspace (string): Workspace name or 'all' (default: 'all')
  - path (string): Optional directory (relative to each workspace root) to limit scope, e.g. '01 Daily Logs'. Default: entire workspace.
  - limit (number): Max matches to return, 1-100 (default: 20)
  - offset (number): Matches to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  { "total": number, "count": number, "offset": number, "has_more": boolean, "next_offset": number?, "matches": [{ "workspace": string, "file": string, "line": number, "text": string }] }

Examples:
  - "Where did I write about SOC 2?" -> query='SOC 2' (searches everywhere)
  - "Pricing notes in one project" -> query='pricing', workspace='homebase', path='02 Projects/Example Project'`,
    inputSchema: {
      query: z
        .string()
        .min(2, "Query must be at least 2 characters")
        .max(200)
        .describe("Case-insensitive substring to search for"),
      workspace: workspaceField,
      path: z.string().max(500).default("").describe("Optional directory scope within each workspace (default: whole workspace)"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max matches to return"),
      offset: z.number().int().min(0).default(0).describe("Matches to skip for pagination"),
      response_format: responseFormatField,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ query, workspace, path: relPath, limit, offset, response_format }) => {
    try {
      const wss = resolveWorkspaces(workspace);
      const matches = searchWorkspaces(query, wss, relPath);
      if (!matches.length) {
        return textResult(
          `No matches for '${query}' in workspace(s): ${wss.map((w) => w.name).join(", ")}${relPath ? ` under '${relPath}'` : ""}. Try a shorter or different term, or widen the scope.`
        );
      }
      const { page, ...meta } = paginate(matches, limit, offset);

      if (response_format === ResponseFormat.JSON) {
        return textResult(
          enforceCharacterLimit(
            JSON.stringify({ ...meta, matches: page }, null, 2),
            "Narrow the search with 'workspace' or 'path', or paginate with 'offset'."
          )
        );
      }
      const lines = [
        `# Search results: '${query}' (${wss.map((w) => w.name).join(", ")})`,
        "",
        `${meta.total} matches (showing ${meta.count}${meta.has_more ? `, next_offset: ${meta.next_offset}` : ""})`,
        "",
      ];
      let currentFile = "";
      for (const m of page) {
        const fileKey = `${m.workspace}:${m.file}`;
        if (fileKey !== currentFile) {
          currentFile = fileKey;
          lines.push(`## ${fileKey}`);
        }
        lines.push(`- L${m.line}: ${m.text}`);
      }
      return textResult(
        enforceCharacterLimit(
          lines.join("\n"),
          "Narrow the search with 'workspace' or 'path', or paginate with 'offset'."
        )
      );
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: workspace_recent_activity
// ---------------------------------------------------------------------------

server.registerTool(
  "workspace_recent_activity",
  {
    title: "Recent Workspace Activity",
    description: `List the most recently modified files across one or all workspaces, newest first.

Useful for "what have we been working on lately?" — spans every registered root by default, so cross-workspace activity shows up in one view. Pair with workspace_get_daily_log for session narratives.

Args:
  - workspace (string): Workspace name or 'all' (default: 'all')
  - limit (number): Max files to return, 1-100 (default: 15)
  - days (number): Only include files modified within this many days, 1-365 (default: 30)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  { "total": number, "count": number, "days": number, "files": [{ "workspace": string, "path": string, "size": number, "modified": string }] }`,
    inputSchema: {
      workspace: workspaceField,
      limit: z.number().int().min(1).max(100).default(15).describe("Max files to return"),
      days: z.number().int().min(1).max(365).default(30).describe("Look-back window in days"),
      response_format: responseFormatField,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ workspace, limit, days, response_format }) => {
    try {
      const wss = resolveWorkspaces(workspace);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const files = wss
        .flatMap((ws) => walkFiles(ws))
        .filter((f) => new Date(f.modified).getTime() >= cutoff)
        .sort((a, b) => b.modified.localeCompare(a.modified));
      const page = files.slice(0, limit);

      if (!page.length) {
        return textResult(
          `No files modified in the last ${days} days in workspace(s): ${wss.map((w) => w.name).join(", ")}.`
        );
      }
      if (response_format === ResponseFormat.JSON) {
        return textResult(
          JSON.stringify(
            {
              total: files.length,
              count: page.length,
              days,
              files: page.map(({ workspace: w, path: p, size, modified }) => ({
                workspace: w,
                path: p,
                size,
                modified,
              })),
            },
            null,
            2
          )
        );
      }
      const lines = [
        `# Recent activity (last ${days} days, ${wss.map((w) => w.name).join(", ")})`,
        "",
        `${files.length} files modified; showing newest ${page.length}`,
        "",
      ];
      for (const f of page) {
        lines.push(`- ${f.modified.slice(0, 10)} — ${displayPath(f)} (${formatSize(f.size)})`);
      }
      return textResult(lines.join("\n"));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: workspace_get_daily_log
// ---------------------------------------------------------------------------

server.registerTool(
  "workspace_get_daily_log",
  {
    title: "Get Daily Log",
    description: `Read a session log from the '01 Daily Logs' folder of any workspace that has one.

Args:
  - date (string): 'latest' for the most recent log across the selected workspaces, a date like '2026-07-05' to match a specific log, or 'list' to list all available logs (default: 'latest')
  - workspace (string): Workspace name or 'all' (default: 'all')

Returns: The full text of the matched log. If no log matches the date, the response lists all available log files. Logs record what was worked on each session — the workspace's memory between sessions.`,
    inputSchema: {
      date: z
        .string()
        .max(40)
        .default("latest")
        .describe("'latest', 'list', or a date string like '2026-07-05'"),
      workspace: workspaceField,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ date, workspace }) => {
    try {
      const wss = resolveWorkspaces(workspace);
      const logs = wss
        .flatMap((ws) => walkFiles(ws, DAILY_LOGS_DIR, { recursive: false }))
        .filter((f) => f.isText);
      if (!logs.length) {
        return textResult(
          `No logs found in '${DAILY_LOGS_DIR}' for workspace(s): ${wss.map((w) => w.name).join(", ")}.`
        );
      }
      const listing = logs.map((f) => `- ${displayPath(f)}`).join("\n");
      if (date === "list") {
        return textResult(`# Daily logs (${logs.length})\n\n${listing}`);
      }

      let target;
      if (date === "latest") {
        // Filenames embed dates (e.g. "2026-07-05.md"); files without a
        // parseable date fall back to their mtime for the comparison.
        const logDate = (f: FileEntry): string =>
          f.path.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? f.modified.slice(0, 10);
        target = [...logs].sort(
          (a, b) => logDate(b).localeCompare(logDate(a)) || b.modified.localeCompare(a.modified)
        )[0];
      } else {
        target = logs.find((f) => f.path.includes(date));
      }
      if (!target) {
        return textResult(`No log matching '${date}'. Available logs:\n${listing}`);
      }
      const ws = getWorkspaceByName(target.workspace);
      const abs = path.join(ws.root, target.path);
      const { content, totalLines } = readTextFileLines(abs, 0, 2000);
      return textResult(
        enforceCharacterLimit(
          `# ${displayPath(target)} (${totalLines} lines)\n\n${content}`,
          "Use workspace_read_file with offset to read the remainder."
        )
      );
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!WORKSPACES.length) {
    console.error(
      "ERROR: No valid workspace roots configured. Set WORKSPACE_ROOTS ('name=/path;name2=/path2') or create workspaces.json next to package.json."
    );
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `workspace-mcp-server v2 running via stdio (workspaces: ${WORKSPACES.map((w) => `${w.name}=${w.root}`).join(", ")})`
  );
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
