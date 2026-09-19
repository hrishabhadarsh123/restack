/**
 * Small fs/path helpers used by the scanner, packer, state and converter.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

export interface WalkOptions {
  /** Directory names to skip entirely (any depth). */
  skipDirs?: string[];
  /** File extensions to include (with dot), e.g. ".php". Empty/undefined = all files. */
  includeExts?: string[];
  /** Follow symlinked directories (default false). */
  followSymlinks?: boolean;
  /** Optional glob exclusions (minimatch-lite, see util/glob.ts). */
  excludeGlobs?: string[];
  /** Optional glob inclusions; if non-empty, only matching files are kept. */
  includeGlobs?: string[];
}

export interface WalkedFile {
  /** Absolute path. */
  abs: string;
  /** Path relative to the walk root (forward slashes). */
  rel: string;
  /** Size in bytes. */
  size: number;
}

export const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".idea",
  ".vscode",
  "dist",
  "build",
  ".restack",
  "converted",
  ".next",
  "coverage",
]);

/** Files that often hold secrets — never packed into prompts. */
export const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.staging",
  ".env.test",
  "credentials.json",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "serviceAccountKey.json",
]);

export const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
]);

export function isSensitivePath(relPath: string): boolean {
  const base = path.posix.basename(relPath);
  if (SENSITIVE_FILE_NAMES.has(base)) return true;
  if (base.startsWith(".env.") || base === ".env") return true;
  const ext = path.posix.extname(base).toLowerCase();
  if (SENSITIVE_EXTENSIONS.has(ext)) return true;
  // e.g. "config/database.yml" style secrets are hard to know — keep it conservative
  return false;
}

/** Recursively walk a directory, skipping common junk dirs and honoring globs. */
export async function walkDirectory(root: string, opts: WalkOptions = {}): Promise<WalkedFile[]> {
  const skipDirs = new Set([...(opts.skipDirs ?? []), ...DEFAULT_SKIP_DIRS]);
  const includeExts = opts.includeExts && opts.includeExts.length > 0
    ? new Set(opts.includeExts.map((e) => (e.startsWith(".") ? e : "." + e).toLowerCase()))
    : null;
  const out: WalkedFile[] = [];

  async function rec(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip silently
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (!opts.followSymlinks && entry.isSymbolicLink()) continue;
        await rec(abs);
      } else if (entry.isFile()) {
        // Sensitive files (.env etc.) are always discovered so the scanner can
        // list and exclude them explicitly, regardless of extension filters.
        const ext = path.posix.extname(entry.name).toLowerCase();
        if (includeExts && !includeExts.has(ext) && !isSensitivePath(rel)) continue;
        if (opts.excludeGlobs?.some((g) => globMatches(g, rel))) continue;
        if (opts.includeGlobs && opts.includeGlobs.length > 0 && !opts.includeGlobs.some((g) => globMatches(g, rel))) continue;
        let size = 0;
        try {
          size = (await fsp.stat(abs)).size;
        } catch {
          continue;
        }
        out.push({ abs, rel, size });
      }
    }
  }

  await rec(root);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

export async function readTextFile(abs: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(abs);
    // Heuristic: refuse binary files (NUL byte in first 8k)
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function writeTextFile(abs: string, content: string): Promise<void> {
  await ensureDir(path.dirname(abs));
  await fsp.writeFile(abs, content, "utf8");
}

export async function fileExists(abs: string): Promise<boolean> {
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function dirExists(abs: string): Promise<boolean> {
  try {
    return (await fsp.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

/** Very small glob matcher supporting **, *, ? and {a,b} alternation. */
export function globMatches(glob: string, relPath: string): boolean {
  const re = globToRegExp(glob);
  return re.test(relPath);
}

export function globToRegExp(glob: string): RegExp {
  let src = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" or trailing "**"
        if (glob[i + 2] === "/") {
          src += "(?:.*/)?";
          i += 3;
        } else {
          src += ".*";
          i += 2;
        }
      } else {
        src += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      src += "[^/]";
      i += 1;
    } else if (c === "{") {
      // {a,b,c}
      let depth = 1;
      let j = i + 1;
      while (j < glob.length && depth > 0) {
        if (glob[j] === "{") depth++;
        else if (glob[j] === "}") depth--;
        if (depth > 0) j++;
      }
      const inner = glob.slice(i + 1, j);
      const parts = splitTopLevel(inner);
      src += "(?:" + parts.map((p) => globToRegExp(p).source.replace(/^\^|\$$/g, "")).join("|") + ")";
      i = j + 1;
    } else if ("\\^$.|+()[]".includes(c)) {
      src += "\\" + c;
      i += 1;
    } else {
      src += c;
      i += 1;
    }
  }
  return new RegExp("^" + src + "$");
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}
