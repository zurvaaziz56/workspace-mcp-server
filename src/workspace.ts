/**
 * Filesystem helpers for the workspace MCP server (multi-root).
 * All access is read-only and confined to the registered workspace roots.
 *
 * Root configuration priority:
 *   1. WORKSPACE_ROOTS env var — "name=/abs/path;name2=/abs/path2"
 *   2. workspaces.json next to package.json — { "name": "/abs/path", ... }
 *   3. WORKSPACE_ROOT env var (legacy single root, registered as "workspace")
 *   4. Built-in default (~/workspace)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

export interface Workspace {
  name: string;
  root: string;
}

export const PROJECTS_DIR = "02 Projects";
export const DAILY_LOGS_DIR = "01 Daily Logs";

/** Maximum characters returned in any single tool response. */
export const CHARACTER_LIMIT = 25000;

/** Directory names never traversed. The server's own folder is excluded so
 * tool source code doesn't pollute search results and recent activity. */
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "workspace-mcp-server",
]);

/** Extensions treated as searchable/readable text. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".xml", ".html",
  ".css", ".js", ".ts", ".py", ".sh", ".toml", ".ini", ".log",
]);

const DEFAULT_WORKSPACES: Record<string, string> = {
  homebase: path.join(os.homedir(), "workspace"),
};

function loadRootsConfig(): Record<string, string> {
  const env = process.env.WORKSPACE_ROOTS;
  if (env) {
    const out: Record<string, string> = {};
    for (const pair of env.split(";")) {
      const idx = pair.indexOf("=");
      if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
    if (Object.keys(out).length) return out;
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, "..", "workspaces.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.keys(parsed).length &&
      Object.values(parsed).every((v) => typeof v === "string")
    ) {
      return parsed as Record<string, string>;
    }
  } catch {
    // no config file or unparseable — fall through
  }
  if (process.env.WORKSPACE_ROOT) {
    return { workspace: process.env.WORKSPACE_ROOT };
  }
  return DEFAULT_WORKSPACES;
}

export const WORKSPACES: Workspace[] = Object.entries(loadRootsConfig())
  .map(([name, root]) => ({ name, root: path.resolve(root) }))
  .filter((ws) => {
    const ok = fs.existsSync(ws.root) && fs.statSync(ws.root).isDirectory();
    if (!ok) {
      console.error(
        `workspace-mcp-server: skipping workspace '${ws.name}' — root '${ws.root}' does not exist`
      );
    }
    return ok;
  });

export function workspaceNames(): string[] {
  return WORKSPACES.map((w) => w.name);
}

/**
 * Resolve a `workspace` tool parameter to concrete workspaces.
 * "all" (or empty) means every registered workspace.
 */
export function resolveWorkspaces(param: string): Workspace[] {
  const p = param.trim().toLowerCase();
  if (!p || p === "all") return WORKSPACES;
  const match = WORKSPACES.find((w) => w.name.toLowerCase() === p);
  if (!match) {
    throw new Error(
      `Unknown workspace '${param}'. Registered workspaces: ${workspaceNames().join(", ")}, or 'all'.`
    );
  }
  return [match];
}

/**
 * Resolve a workspace-relative path to an absolute path, rejecting anything
 * that escapes the workspace root (e.g. "../", absolute paths outside).
 */
export function resolveWithinRoot(ws: Workspace, relPath: string): string {
  const abs = path.resolve(ws.root, relPath);
  if (abs !== ws.root && !abs.startsWith(ws.root + path.sep)) {
    throw new Error(
      `Path '${relPath}' is outside workspace '${ws.name}'. Use paths relative to that workspace's root.`
    );
  }
  return abs;
}

/**
 * Split a possibly workspace-prefixed path ("homebase:01 Daily Logs/x.md")
 * into its workspace and relative parts. Returns undefined workspace when
 * the path carries no known prefix.
 */
export function parseWorkspacePath(p: string): { workspace?: Workspace; relPath: string } {
  const idx = p.indexOf(":");
  if (idx > 0) {
    const prefix = p.slice(0, idx).trim().toLowerCase();
    const ws = WORKSPACES.find((w) => w.name.toLowerCase() === prefix);
    if (ws) return { workspace: ws, relPath: p.slice(idx + 1) };
  }
  return { relPath: p };
}

export function isTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isExcluded(name: string, includeHidden: boolean): boolean {
  if (EXCLUDED_DIRS.has(name)) return true;
  if (!includeHidden && name.startsWith(".")) return true;
  return false;
}

export interface FileEntry {
  /** Workspace name this file belongs to. */
  workspace: string;
  /** Path relative to the workspace root, using "/" separators. */
  path: string;
  size: number;
  modified: string; // ISO 8601
  isText: boolean;
}

/** Display form used in markdown output: "workspace:relative/path". */
export function displayPath(f: Pick<FileEntry, "workspace" | "path">): string {
  return `${f.workspace}:${f.path}`;
}

/**
 * Recursively collect files under a directory inside a workspace.
 * `relDir` is relative to the workspace root. Returns entries sorted by path.
 * Returns [] when the directory doesn't exist.
 */
export function walkFiles(
  ws: Workspace,
  relDir = "",
  opts: { recursive?: boolean; includeHidden?: boolean } = {}
): FileEntry[] {
  const { recursive = true, includeHidden = false } = opts;
  const startAbs = resolveWithinRoot(ws, relDir);
  const out: FileEntry[] = [];

  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable/missing directory — skip silently
    }
    for (const entry of entries) {
      if (isExcluded(entry.name, includeHidden)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) visit(abs);
      } else if (entry.isFile()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        out.push({
          workspace: ws.name,
          path: path.relative(ws.root, abs).split(path.sep).join("/"),
          size: stat.size,
          modified: stat.mtime.toISOString(),
          isText: isTextFile(abs),
        });
      }
    }
  };

  visit(startAbs);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** List immediate subdirectory names of a workspace-relative directory. */
export function listSubdirectories(ws: Workspace, relDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolveWithinRoot(ws, relDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !isExcluded(e.name, false))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export interface SearchMatch {
  workspace: string;
  file: string;
  line: number;
  text: string;
}

/**
 * Case-insensitive plain-text search across text files in the given
 * workspaces, optionally scoped to a relative directory within each.
 * Caps matches per file so one file cannot drown out the rest.
 */
export function searchWorkspaces(
  query: string,
  workspaces: Workspace[],
  relScope = "",
  opts: { maxPerFile?: number } = {}
): SearchMatch[] {
  const { maxPerFile = 5 } = opts;
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const ws of workspaces) {
    for (const entry of walkFiles(ws, relScope)) {
      if (!entry.isText) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(ws.root, entry.path), "utf-8");
      } catch {
        continue;
      }
      if (!content.toLowerCase().includes(needle)) continue;

      const lines = content.split("\n");
      let perFile = 0;
      for (let i = 0; i < lines.length && perFile < maxPerFile; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({
            workspace: ws.name,
            file: entry.path,
            line: i + 1,
            text: truncateLine(lines[i].trim(), 200),
          });
          perFile++;
        }
      }
    }
  }
  return matches;
}

function truncateLine(line: string, max: number): string {
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/** Read a text file, returning a slice of lines plus totals. */
export function readTextFileLines(
  absPath: string,
  offset: number,
  limit: number
): { content: string; totalLines: number; startLine: number; endLine: number } {
  const raw = fs.readFileSync(absPath, "utf-8");
  const lines = raw.split("\n");
  const slice = lines.slice(offset, offset + limit);
  return {
    content: slice.join("\n"),
    totalLines: lines.length,
    startLine: Math.min(offset + 1, lines.length),
    endLine: Math.min(offset + slice.length, lines.length),
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Truncate a response string to CHARACTER_LIMIT with an explanatory notice. */
export function enforceCharacterLimit(text: string, hint: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Response truncated at ${CHARACTER_LIMIT} characters. ${hint}]`
  );
}
