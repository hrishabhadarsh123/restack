/**
 * Scanner: walks a legacy project, detects the stack, classifies file roles,
 * estimates tokens and flags sensitive/oversized files.
 */
import path from "node:path";
import {
  walkDirectory,
  readTextFile,
  isSensitivePath,
  type WalkedFile,
} from "./util/fs.js";
import { estimateTokens } from "./util/tokens.js";
import type { FileEntry, FileRole, ScanResult, LegacyStack } from "./types.js";

/** Files over this many estimated tokens are summarized instead of packed verbatim. */
export const LARGE_FILE_TOKENS = 3_000;

const CODE_EXTS = [
  ".php", ".phtml", ".inc", ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".json", ".yml", ".yaml",
  ".xml", ".ini", ".conf", ".cfg", ".sql", ".sh", ".bat", ".md", ".txt", ".toml",
];

function languageFor(rel: string): string {
  const ext = path.posix.extname(rel).toLowerCase();
  const map: Record<string, string> = {
    ".php": "php", ".phtml": "php-template", ".inc": "php",
    ".py": "python", ".pyw": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
    ".html": "html", ".htm": "html",
    ".css": "css", ".scss": "scss", ".sass": "sass", ".less": "less",
    ".json": "json", ".yml": "yaml", ".yaml": "yaml",
    ".xml": "xml", ".ini": "ini", ".conf": "ini", ".cfg": "ini",
    ".sql": "sql", ".sh": "bash", ".bat": "batch",
    ".md": "markdown", ".txt": "text", ".toml": "toml",
  };
  return map[ext] ?? "other";
}

function detectRole(rel: string): FileRole {
  const base = path.posix.basename(rel).toLowerCase();
  const lower = rel.toLowerCase();
  if (/^(package\.json|composer\.json|requirements.*\.txt|setup\.py|setup\.cfg|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|build\.gradle)$/.test(base)) return "config";
  if (/^(index|main|app|server|bootstrap|manage|wsgi|application)\.(php|py|js|ts)$/.test(base)) return "entry";
  const isCode = /\.(php|py|js|phtml)$/.test(lower);
  if (isCode && /(^|\/)(routes?|controllers?|views?|pages?|endpoints?)(\/|$)/.test(lower)) return "route";
  if (isCode && /(^|\/)api(\/|$)/.test(lower)) return "route";
  if (/\.(phtml|html|htm|tpl|hbs|ejs|twig|jinja|jinja2)$/.test(lower)) return "template";
  if (/\.(css|scss|sass|less)$/.test(lower)) return "style";
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(lower) || /\.(test|spec)\./.test(base)) return "test";
  if (/(^|\/)(includes?|inc|lib|libs|utils?|helpers?|common|shared)(\/|$)/.test(lower)) return "shared";
  if (lower.includes("/components/") || lower.includes("/widgets/")) return "component";
  return "other";
}

interface StackDetection {
  stack: LegacyStack;
  evidence: string[];
  libraries: string[];
  confidence: number;
}

function detectStack(
  files: WalkedFile[],
  texts: Map<string, string | null>,
): StackDetection {
  const rels = files.map((f) => f.rel);
  const relSet = new Set(rels);
  const evidence: string[] = [];
  const libraries = new Set<string>();
  let phpScore = 0;
  let py2Score = 0;

  const has = (rel: string) => relSet.has(rel);
  const anyMatch = (re: RegExp) => rels.some((r) => re.test(r.toLowerCase()));

  // --- Strong structural markers -------------------------------------------
  if (has("composer.json")) {
    phpScore += 30;
    evidence.push("composer.json present");
    const text = texts.get("composer.json");
    if (text) {
      const require = text.match(/"require"\s*:\s*\{([\s\S]*?)\}/);
      if (require) {
        for (const lib of ["laravel/framework", "symfony/http-foundation", "slim/slim", "guzzlehttp/guzzle"]) {
          if (require[1]!.includes(`"${lib}"`)) libraries.add(lib.split("/")[0]!);
        }
      }
    }
  }
  const phpCount = rels.filter((r) => /\.php$/.test(r)).length;
  if (phpCount > 0) {
    phpScore += 25;
    evidence.push(`${phpCount} .php file(s) found`);
  }

  if (has("setup.py") || has("setup.cfg") || anyMatch(/requirements[\w.-]*\.txt$/)) {
    py2Score += 15;
    evidence.push("python packaging present (setup.py / requirements*.txt)");
  }
  const pyCount = rels.filter((r) => /\.py$/.test(r)).length;
  if (pyCount > 0) {
    py2Score += 15;
    evidence.push(`${pyCount} .py file(s) found`);
  }

  // --- Content markers: Python 2 vs 3 ---------------------------------------
  let py2Signals = 0;
  let py3Signals = 0;
  for (const f of files) {
    if (!/\.(py|pyw)$/.test(f.rel)) continue;
    const text = texts.get(f.rel);
    if (!text) continue;
    if (/\bprint\s+[^(\s=]/.test(text)) {
      py2Signals++;
      if (py2Signals <= 3) evidence.push(`py2 print statement: ${f.rel}`);
    }
    if (/\bprint\s*\(/.test(text)) py3Signals++;
    if (/except\s+\w+\s*,\s*\w+\s*:/.test(text)) {
      py2Signals++;
      if (py2Signals <= 4) evidence.push(`py2 except syntax: ${f.rel}`);
    }
    if (/except\s+\w+\s+as\s+\w+\s*:/.test(text)) py3Signals++;
    if (/\bhas_key\s*\(/.test(text)) py2Signals++;
    if (/\b(iteritems|iterkeys|itervalues)\s*\(/.test(text)) py2Signals++;
    if (/\bxrange\s*\(/.test(text)) {
      py2Signals++;
      if (py2Signals <= 4) evidence.push(`py2 xrange: ${f.rel}`);
    }
    if (/^\s*#\s*-\*-\s*coding\s*[:=]/m.test(text)) py2Signals++;
    if (/\bfrom\s+__future__\s+import\b/.test(text)) py3Signals++;
  }
  if (py2Signals > 0) py2Score += Math.min(35, py2Signals * 10);
  if (py3Signals > 0 && py2Signals === 0) py2Score = Math.max(0, py2Score - 10);

  // --- Content markers: jQuery / client-side --------------------------------
  let jquerySignals = 0;
  for (const f of files) {
    if (!/\.(html|htm|phtml|php|js)$/.test(f.rel)) continue;
    const text = texts.get(f.rel);
    if (!text) continue;
    if (/jQuery|\b\$\((['"]).*?\1\)|jquery[-.]min\.js|ajax\(|\.getJSON\(/.test(text)) {
      jquerySignals++;
      if (jquerySignals === 1) evidence.push(`jQuery usage detected: ${f.rel}`);
    }
  }
  if (jquerySignals > 0) {
    phpScore += Math.min(15, jquerySignals * 5);
    libraries.add("jquery");
  }

  // Common frontend libs (informational)
  for (const f of files) {
    const text = texts.get(f.rel);
    if (!text) continue;
    if (/bootstrap(\.min)?\.(css|js)/.test(text)) libraries.add("bootstrap");
    if (/chart\.js|Chart\(/.test(text)) libraries.add("chart.js");
    if (/datatables/.test(text)) libraries.add("datatables");
  }

  // --- Decide ----------------------------------------------------------------
  let stack: LegacyStack = "unknown";
  let confidence = 0;
  if (phpScore >= 25 && phpScore > py2Score + 10) {
    stack = "php-jquery";
    confidence = Math.min(0.99, 0.5 + phpScore / 100);
  } else if (py2Score >= 25 && py2Score > phpScore + 10) {
    stack = "python2";
    confidence = Math.min(0.99, 0.5 + py2Score / 100);
  } else if (phpScore > 0 || py2Score > 0) {
    stack = phpScore >= py2Score ? "php-jquery" : "python2";
    confidence = 0.35;
    evidence.push("low-confidence: mixed or weak signals");
  }
  if (stack === "unknown") evidence.push("no recognizable legacy markers found");

  return {
    stack,
    evidence,
    libraries: [...libraries].sort(),
    confidence: Math.round(confidence * 100) / 100,
  };
}

export interface ScanOptions {
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

/**
 * Scan a legacy project directory. Reads all candidate source files into
 * memory (needed later by the packer anyway). Throws if the root is invalid.
 */
export async function scanProject(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const absRoot = path.resolve(root);
  const walked = await walkDirectory(absRoot, {
    includeExts: CODE_EXTS,
    includeGlobs: opts.includeGlobs,
    excludeGlobs: opts.excludeGlobs,
  });

  const files: FileEntry[] = [];
  const texts = new Map<string, string | null>();
  const excludedSensitive: string[] = [];
  const oversizedFiles: string[] = [];

  for (const wf of walked) {
    // Compute rel without extension filters first so sensitive config files
    // (.env has no code extension) are still discovered.
    if (isSensitivePath(wf.rel)) {
      excludedSensitive.push(wf.rel);
      texts.set(wf.rel, null);
      files.push({
        rel: wf.rel,
        size: wf.size,
        tokens: 0,
        language: "other",
        role: "other",
        text: null,
      });
      continue;
    }
    let text: string | null = null;
    let tokens = 0;
    if (wf.size <= 512 * 1024) {
      text = await readTextFile(wf.abs);
      tokens = text == null ? 0 : estimateTokens(text);
    }
    if (text != null && tokens > LARGE_FILE_TOKENS) {
      oversizedFiles.push(wf.rel);
      // Keep text for later summarization — but mark it oversized.
    }
    texts.set(wf.rel, text);
    files.push({
      rel: wf.rel,
      size: wf.size,
      tokens,
      language: languageFor(wf.rel),
      role: detectRole(wf.rel),
      text,
    });
  }

  const detection = detectStack(walked, texts);
  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);

  return {
    root: absRoot,
    stack: detection.stack,
    evidence: detection.evidence,
    confidence: detection.confidence,
    files,
    totalTokens,
    libraries: detection.libraries,
    excludedSensitive,
    oversizedFiles,
  };
}

export interface ScanJsonReport {
  root: string;
  stack: LegacyStack;
  confidence: number;
  evidence: string[];
  libraries: string[];
  fileCount: number;
  readableFileCount: number;
  totalTokens: number;
  /** True when the whole project fits a planning window with headroom. */
  fitsInOneWindow: boolean;
  excludedSensitive: string[];
  oversizedFiles: string[];
  files: Array<{
    path: string;
    role: FileRole;
    language: string;
    tokens: number;
    size: number;
    readable: boolean;
  }>;
}

/**
 * Machine-readable form of a scan (emitted by `restack scan --json`).
 * Pure function so it can be unit-tested without running the CLI.
 */
export function buildScanJsonReport(scan: ScanResult): ScanJsonReport {
  const codeFiles = scan.files.filter((f) => f.text != null);
  return {
    root: scan.root,
    stack: scan.stack,
    confidence: scan.confidence,
    evidence: scan.evidence,
    libraries: scan.libraries,
    fileCount: scan.files.length,
    readableFileCount: codeFiles.length,
    totalTokens: scan.totalTokens,
    fitsInOneWindow: scan.totalTokens <= 160_000,
    excludedSensitive: scan.excludedSensitive,
    oversizedFiles: scan.oversizedFiles,
    files: scan.files.map((f) => ({
      path: f.rel,
      role: f.role,
      language: f.language,
      tokens: f.tokens,
      size: f.size,
      readable: f.text != null,
    })),
  };
}
