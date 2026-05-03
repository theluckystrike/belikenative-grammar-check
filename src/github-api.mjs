/**
 * BeLikeNative GitHub API Interactions
 *
 * Handles all communication with the GitHub API:
 *   - Fetching changed files in a PR
 *   - Parsing diff hunks to identify changed line numbers
 *   - Posting review comments on specific lines
 *   - Setting check status
 *
 * Uses the native fetch API (Node 20+). No external HTTP libraries.
 *
 * NASA P10: all functions <60 lines, 2+ assertions, bounded loops,
 * no global mutable state.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_FILES_PER_PR = 300;
const MAX_COMMENTS_PER_REVIEW = 60;
const API_BASE = "https://api.github.com";

// ---------------------------------------------------------------------------
// Core fetch wrapper with error checking
// ---------------------------------------------------------------------------
async function apiFetch(url, token, options = {}) {
  console.assert(typeof url === "string" && url.length > 0, "apiFetch: url must be a non-empty string");
  console.assert(typeof token === "string" && token.length > 0, "apiFetch: token must be a non-empty string");

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers ?? {}),
  };

  const resp = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "(unreadable)");
    throw new Error(`GitHub API ${resp.status} ${resp.statusText}: ${url}\n${body}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Get list of changed files in a PR (paginated)
// ---------------------------------------------------------------------------
async function getPRFiles(owner, repo, prNumber, token) {
  console.assert(typeof owner === "string" && owner.length > 0, "getPRFiles: owner required");
  console.assert(typeof prNumber === "number" && prNumber > 0, "getPRFiles: prNumber must be > 0");

  const files = [];
  let page = 1;
  const maxPages = 10; // hard upper bound

  while (page <= maxPages) {
    const url = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const batch = await apiFetch(url, token);

    console.assert(Array.isArray(batch), "getPRFiles: API response must be an array");

    for (let i = 0; i < batch.length && files.length < MAX_FILES_PER_PR; i++) {
      files.push(batch[i]);
    }

    if (batch.length < 100 || files.length >= MAX_FILES_PER_PR) {
      break;
    }

    page++;
  }

  return files;
}

// ---------------------------------------------------------------------------
// Filter files by glob patterns (simplified pattern matching)
// ---------------------------------------------------------------------------
function filterFilesByPattern(files, patterns) {
  console.assert(Array.isArray(files), "filterFilesByPattern: files must be an array");
  console.assert(typeof patterns === "string" && patterns.length > 0, "filterFilesByPattern: patterns must be a non-empty string");

  const extensions = extractExtensions(patterns);
  const matched = [];
  const bound = Math.min(files.length, MAX_FILES_PER_PR);

  for (let i = 0; i < bound; i++) {
    const file = files[i];

    // Skip deleted files
    if (file.status === "removed") {
      continue;
    }

    const filename = file.filename ?? "";
    const ext = getExtension(filename);

    if (extensions.has(ext)) {
      matched.push(file);
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Extract file extensions from glob patterns like "**/*.md,**/*.txt"
// ---------------------------------------------------------------------------
function extractExtensions(patterns) {
  console.assert(typeof patterns === "string", "extractExtensions: patterns must be a string");
  console.assert(patterns.length > 0, "extractExtensions: patterns must not be empty");

  const parts = patterns.split(",");
  const exts = new Set();
  const bound = Math.min(parts.length, 50);

  for (let i = 0; i < bound; i++) {
    const trimmed = parts[i].trim();
    const dotIndex = trimmed.lastIndexOf(".");
    if (dotIndex >= 0) {
      exts.add(trimmed.slice(dotIndex));
    }
  }

  return exts;
}

// ---------------------------------------------------------------------------
// Get file extension
// ---------------------------------------------------------------------------
function getExtension(filename) {
  console.assert(typeof filename === "string", "getExtension: filename must be a string");
  console.assert(filename.length < 1000, "getExtension: filename suspiciously long");

  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 0) return "";
  return filename.slice(dotIndex);
}

// ---------------------------------------------------------------------------
// Parse diff patch to get changed line numbers in the new file
// ---------------------------------------------------------------------------
function parseChangedLines(patch) {
  console.assert(typeof patch === "string" || patch == null, "parseChangedLines: patch must be a string or null");

  if (!patch) {
    return new Set();
  }

  // Clamp assertion — we still process but warn
  console.assert(patch.length < 5_000_000, "parseChangedLines: patch is very large");

  const changedLines = new Set();
  const lines = patch.split("\n");
  let currentLine = 0;
  const bound = Math.min(lines.length, 100_000);

  for (let i = 0; i < bound; i++) {
    const line = lines[i];

    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      // Added line
      changedLines.add(currentLine);
      currentLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Removed line — don't increment currentLine
    } else {
      // Context line
      currentLine++;
    }
  }

  return changedLines;
}

// ---------------------------------------------------------------------------
// Fetch raw file content from the repo at a specific ref
// ---------------------------------------------------------------------------
async function getFileContent(owner, repo, path, ref, token) {
  console.assert(typeof path === "string" && path.length > 0, "getFileContent: path required");
  console.assert(typeof ref === "string" && ref.length > 0, "getFileContent: ref required");

  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`;
  const data = await apiFetch(url, token);

  console.assert(typeof data.content === "string" || data.download_url, "getFileContent: no content in response");

  if (data.content) {
    // Base64-encoded content
    return Buffer.from(data.content, "base64").toString("utf-8");
  }

  // Fallback: download from download_url
  const resp = await fetch(data.download_url);
  if (!resp.ok) {
    throw new Error(`Failed to download file: ${resp.status}`);
  }
  return resp.text();
}

// ---------------------------------------------------------------------------
// Format a single issue as a PR review comment body
// ---------------------------------------------------------------------------
function formatCommentBody(issue) {
  console.assert(issue !== null && typeof issue === "object", "formatCommentBody: issue must be an object");
  console.assert(typeof issue.message === "string", "formatCommentBody: issue.message required");

  const severityIcon =
    issue.severity === "error" ? "\u274c" : issue.severity === "warning" ? "\u26a0\ufe0f" : "\u2139\ufe0f";

  const parts = [];

  parts.push(`${severityIcon} **Grammar Issue** (BeLikeNative)\n`);
  parts.push(`**Found:** \`${issue.matched}\``);

  if (issue.suggestion) {
    parts.push(`**Suggestion:** **${issue.suggestion}**`);
  }

  parts.push(`**Rule:** ${issue.message}`);
  parts.push(`**Category:** ${issue.category} | **Severity:** ${issue.severity}`);

  if (issue.l1Insight) {
    parts.push("");
    parts.push(`> \ud83d\udca1 **L1 Insight:** ${issue.l1Insight}`);
  }

  parts.push("");
  parts.push("---");
  parts.push("*Powered by [BeLikeNative](https://belikenative.com)*");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Post a PR review with inline comments
// ---------------------------------------------------------------------------
async function postReview(owner, repo, prNumber, commitSha, comments, token) {
  console.assert(typeof commitSha === "string" && commitSha.length > 0, "postReview: commitSha required");
  console.assert(Array.isArray(comments), "postReview: comments must be an array");

  // Clamp to max comments
  const clamped = comments.slice(0, MAX_COMMENTS_PER_REVIEW);

  const url = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;

  const reviewComments = [];
  const bound = Math.min(clamped.length, MAX_COMMENTS_PER_REVIEW);

  for (let i = 0; i < bound; i++) {
    const c = clamped[i];
    reviewComments.push({
      path: c.path,
      line: c.line,
      side: "RIGHT",
      body: c.body,
    });
  }

  const hasErrors = comments.some((c) => c.severity === "error");

  const body = {
    commit_id: commitSha,
    event: hasErrors ? "REQUEST_CHANGES" : "COMMENT",
    body: buildReviewSummary(comments),
    comments: reviewComments,
  };

  return apiFetch(url, token, {
    method: "POST",
    body,
  });
}

// ---------------------------------------------------------------------------
// Build the top-level review summary
// ---------------------------------------------------------------------------
function buildReviewSummary(comments) {
  console.assert(Array.isArray(comments), "buildReviewSummary: comments must be an array");

  let errors = 0;
  let warnings = 0;
  let infos = 0;
  const bound = Math.min(comments.length, MAX_COMMENTS_PER_REVIEW);

  for (let i = 0; i < bound; i++) {
    const sev = comments[i].severity;
    if (sev === "error") errors++;
    else if (sev === "warning") warnings++;
    else infos++;
  }

  console.assert(errors + warnings + infos === bound, "buildReviewSummary: count mismatch");

  const parts = [];
  parts.push("## \ud83d\udcdd BeLikeNative Grammar Check Summary\n");

  if (errors > 0) parts.push(`- \u274c **${errors}** error(s)`);
  if (warnings > 0) parts.push(`- \u26a0\ufe0f **${warnings}** warning(s)`);
  if (infos > 0) parts.push(`- \u2139\ufe0f **${infos}** info(s)`);

  if (errors === 0 && warnings === 0 && infos === 0) {
    parts.push("\u2705 No grammar issues found. Great writing!");
  }

  parts.push("");
  parts.push("*Powered by [BeLikeNative](https://belikenative.com) \u2014 AI writing assistant for non-native speakers*");

  return parts.join("\n");
}

export {
  apiFetch,
  getPRFiles,
  filterFilesByPattern,
  extractExtensions,
  parseChangedLines,
  getFileContent,
  formatCommentBody,
  postReview,
  buildReviewSummary,
  MAX_COMMENTS_PER_REVIEW,
};
