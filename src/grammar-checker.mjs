/**
 * BeLikeNative Grammar Checking Engine
 *
 * Rule-based engine that scans text content line-by-line and returns
 * structured issue objects. No AI APIs required.
 *
 * NASA P10: all functions <60 lines, 2+ assertions, bounded loops,
 * no global mutable state.
 */

import { RULES } from "./rules.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_LINES_PER_FILE = 50_000;
const MAX_ISSUES_PER_FILE = 500;
const SEVERITY_RANK = Object.freeze({ error: 3, warning: 2, info: 1 });

// ---------------------------------------------------------------------------
// Markdown-aware line classifier — detect code blocks, frontmatter, HTML
// ---------------------------------------------------------------------------
function classifyLines(lines) {
  console.assert(Array.isArray(lines), "classifyLines: lines must be an array");
  console.assert(lines.length <= MAX_LINES_PER_FILE, `classifyLines: file exceeds ${MAX_LINES_PER_FILE} line limit`);

  const flags = new Array(lines.length);
  let inCodeBlock = false;
  let inFrontmatter = false;
  let frontmatterSeen = false;
  const bound = Math.min(lines.length, MAX_LINES_PER_FILE);

  for (let i = 0; i < bound; i++) {
    const trimmed = lines[i].trimStart();

    // YAML frontmatter toggle (only at top of file)
    if (trimmed === "---") {
      if (!frontmatterSeen && i === 0) {
        inFrontmatter = true;
        flags[i] = "skip";
        frontmatterSeen = true;
        continue;
      }
      if (inFrontmatter) {
        inFrontmatter = false;
        flags[i] = "skip";
        continue;
      }
    }

    // Fenced code block toggle
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      flags[i] = "skip";
      continue;
    }

    if (inFrontmatter || inCodeBlock) {
      flags[i] = "skip";
    } else {
      flags[i] = "prose";
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Strip markdown syntax from a prose line so rules see clean text
// ---------------------------------------------------------------------------
function stripMarkdownSyntax(line) {
  console.assert(typeof line === "string", "stripMarkdownSyntax: line must be a string");
  console.assert(line.length < 100_000, "stripMarkdownSyntax: line suspiciously long");

  let clean = line;

  // Remove inline code spans (backtick-wrapped)
  clean = clean.replace(/`[^`]+`/g, " ");

  // Remove link URLs but keep link text: [text](url) → text
  clean = clean.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Remove image syntax: ![alt](url) → alt
  clean = clean.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Remove HTML tags
  clean = clean.replace(/<[^>]+>/g, " ");

  // Remove heading markers
  clean = clean.replace(/^#{1,6}\s+/, "");

  // Remove bold/italic markers
  clean = clean.replace(/(\*{1,3}|_{1,3})/g, "");

  return clean;
}

// ---------------------------------------------------------------------------
// Check a single line against all rules; return issues found
// ---------------------------------------------------------------------------
function checkLine(rawLine, lineNumber, rules, minSeverity) {
  console.assert(typeof rawLine === "string", "checkLine: rawLine must be a string");
  console.assert(typeof lineNumber === "number" && lineNumber >= 1, "checkLine: lineNumber must be >= 1");

  const cleaned = stripMarkdownSyntax(rawLine);
  const issues = [];
  const minRank = SEVERITY_RANK[minSeverity] ?? 1;
  const bound = Math.min(rules.length, 1000); // hard upper bound on rules

  for (let r = 0; r < bound; r++) {
    const rule = rules[r];

    // Skip rules below threshold
    if (SEVERITY_RANK[rule.severity] < minRank) {
      continue;
    }

    // Reset regex lastIndex for global patterns
    rule.pattern.lastIndex = 0;

    let match = rule.pattern.exec(cleaned);
    let matchCount = 0;
    const matchLimit = 10; // max matches per rule per line

    while (match !== null && matchCount < matchLimit) {
      matchCount++;

      const snippet = extractSnippet(cleaned, match.index, match[0].length);
      const suggestion = computeFix(rule, match);

      issues.push(
        Object.freeze({
          ruleId: rule.id,
          line: lineNumber,
          column: match.index + 1,
          matched: match[0],
          snippet,
          suggestion,
          message: rule.message,
          severity: rule.severity,
          category: rule.category,
          l1Insight: rule.l1Insight,
        })
      );

      if (issues.length >= MAX_ISSUES_PER_FILE) {
        return issues;
      }

      match = rule.pattern.exec(cleaned);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Extract a context snippet around the match
// ---------------------------------------------------------------------------
function extractSnippet(text, matchStart, matchLen) {
  console.assert(typeof text === "string", "extractSnippet: text must be a string");
  console.assert(matchStart >= 0, "extractSnippet: matchStart must be >= 0");

  const contextChars = 30;
  const start = Math.max(0, matchStart - contextChars);
  const end = Math.min(text.length, matchStart + matchLen + contextChars);

  let snippet = "";
  if (start > 0) snippet += "...";
  snippet += text.slice(start, end);
  if (end < text.length) snippet += "...";

  return snippet;
}

// ---------------------------------------------------------------------------
// Compute a fix/suggestion string from the rule
// ---------------------------------------------------------------------------
function computeFix(rule, match) {
  console.assert(rule !== null && typeof rule === "object", "computeFix: rule must be an object");
  console.assert(match !== null, "computeFix: match must not be null");

  if (rule.fix === null) {
    return null;
  }

  if (typeof rule.fix === "function") {
    return rule.fix(match);
  }

  return String(rule.fix);
}

// ---------------------------------------------------------------------------
// Main: check an entire file's content
// ---------------------------------------------------------------------------
function checkFile(content, options = {}) {
  console.assert(typeof content === "string", "checkFile: content must be a string");
  console.assert(typeof options === "object" && options !== null, "checkFile: options must be an object");

  const minSeverity = options.minSeverity ?? "info";
  const rules = options.rules ?? RULES;

  const lines = content.split("\n");
  if (lines.length > MAX_LINES_PER_FILE) {
    return Object.freeze({
      issues: [],
      skipped: true,
      reason: `File exceeds ${MAX_LINES_PER_FILE} line limit`,
      stats: { total: 0, errors: 0, warnings: 0, infos: 0 },
    });
  }

  const lineFlags = classifyLines(lines);
  const allIssues = [];
  const bound = Math.min(lines.length, MAX_LINES_PER_FILE);

  for (let i = 0; i < bound; i++) {
    if (lineFlags[i] !== "prose") {
      continue;
    }
    const lineIssues = checkLine(lines[i], i + 1, rules, minSeverity);
    for (let j = 0; j < lineIssues.length && allIssues.length < MAX_ISSUES_PER_FILE; j++) {
      allIssues.push(lineIssues[j]);
    }
    if (allIssues.length >= MAX_ISSUES_PER_FILE) {
      break;
    }
  }

  const stats = computeStats(allIssues);

  return Object.freeze({
    issues: Object.freeze(allIssues),
    skipped: false,
    reason: null,
    stats,
  });
}

// ---------------------------------------------------------------------------
// Compute summary statistics
// ---------------------------------------------------------------------------
function computeStats(issues) {
  console.assert(Array.isArray(issues), "computeStats: issues must be an array");
  console.assert(issues.length <= MAX_ISSUES_PER_FILE, "computeStats: too many issues");

  let errors = 0;
  let warnings = 0;
  let infos = 0;
  const bound = Math.min(issues.length, MAX_ISSUES_PER_FILE);

  for (let i = 0; i < bound; i++) {
    const sev = issues[i].severity;
    if (sev === "error") errors++;
    else if (sev === "warning") warnings++;
    else infos++;
  }

  return Object.freeze({
    total: issues.length,
    errors,
    warnings,
    infos,
  });
}

// ---------------------------------------------------------------------------
// Filter issues to only those on specific changed lines (for PR diffs)
// ---------------------------------------------------------------------------
function filterToChangedLines(issues, changedLineNumbers) {
  console.assert(Array.isArray(issues), "filterToChangedLines: issues must be an array");
  console.assert(changedLineNumbers instanceof Set, "filterToChangedLines: changedLineNumbers must be a Set");

  const filtered = [];
  const bound = Math.min(issues.length, MAX_ISSUES_PER_FILE);

  for (let i = 0; i < bound; i++) {
    if (changedLineNumbers.has(issues[i].line)) {
      filtered.push(issues[i]);
    }
  }

  return Object.freeze(filtered);
}

export {
  checkFile,
  checkLine,
  classifyLines,
  stripMarkdownSyntax,
  filterToChangedLines,
  SEVERITY_RANK,
  MAX_ISSUES_PER_FILE,
};
