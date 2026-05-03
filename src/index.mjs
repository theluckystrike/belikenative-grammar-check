/**
 * BeLikeNative Grammar Check — GitHub Action Entry Point
 *
 * Orchestrates the full workflow:
 *   1. Read action inputs
 *   2. Fetch changed files from the PR
 *   3. Filter to documentation files
 *   4. Run grammar checks on each file
 *   5. Post review comments on lines with issues
 *   6. Set check status (pass/fail)
 *
 * NASA P10: all functions <60 lines, 2+ assertions, bounded loops,
 * no global mutable state.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import { checkFile, filterToChangedLines, SEVERITY_RANK } from "./grammar-checker.mjs";
import {
  getPRFiles,
  filterFilesByPattern,
  parseChangedLines,
  getFileContent,
  formatCommentBody,
  postReview,
  MAX_COMMENTS_PER_REVIEW,
} from "./github-api.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_FILES_TO_CHECK = 50;

// ---------------------------------------------------------------------------
// Read and validate action inputs
// ---------------------------------------------------------------------------
function readInputs() {
  const token = core.getInput("github-token", { required: true });
  const severityThreshold = core.getInput("severity-threshold") || "warning";
  const filePatterns = core.getInput("file-patterns") || "**/*.md,**/*.txt,**/*.mdx,**/*.rst";
  const maxComments = parseInt(core.getInput("max-comments") || "50", 10);
  const failOnError = core.getInput("fail-on-error") !== "false";

  console.assert(typeof token === "string" && token.length > 0, "readInputs: github-token is required");
  console.assert(
    ["error", "warning", "info"].includes(severityThreshold),
    `readInputs: invalid severity-threshold: ${severityThreshold}`
  );

  return Object.freeze({
    token,
    severityThreshold,
    filePatterns,
    maxComments: Math.min(maxComments, MAX_COMMENTS_PER_REVIEW),
    failOnError,
  });
}

// ---------------------------------------------------------------------------
// Extract PR context from the GitHub event
// ---------------------------------------------------------------------------
function extractPRContext() {
  const { context } = github;

  console.assert(context.payload.pull_request != null, "extractPRContext: this action must run on pull_request events");
  console.assert(
    typeof context.repo.owner === "string",
    "extractPRContext: could not determine repo owner"
  );

  const pr = context.payload.pull_request;

  return Object.freeze({
    owner: context.repo.owner,
    repo: context.repo.repo,
    prNumber: pr.number,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
  });
}

// ---------------------------------------------------------------------------
// Process a single file: fetch content, check grammar, collect comments
// ---------------------------------------------------------------------------
async function processFile(file, prCtx, inputs) {
  console.assert(typeof file.filename === "string", "processFile: file.filename required");
  console.assert(typeof prCtx.headRef === "string", "processFile: headRef required");

  core.info(`Checking: ${file.filename}`);

  // Fetch file content at the PR head
  const content = await getFileContent(
    prCtx.owner,
    prCtx.repo,
    file.filename,
    prCtx.headSha,
    inputs.token
  );

  // Run grammar check
  const result = checkFile(content, { minSeverity: inputs.severityThreshold });

  if (result.skipped) {
    core.warning(`Skipped ${file.filename}: ${result.reason}`);
    return [];
  }

  // Parse diff to find which lines were actually changed
  const changedLines = parseChangedLines(file.patch ?? "");

  // Filter issues to only changed lines (avoid noise on untouched code)
  const relevantIssues = filterToChangedLines(result.issues, changedLines);

  // Convert to review comments
  const comments = [];
  const bound = Math.min(relevantIssues.length, MAX_COMMENTS_PER_REVIEW);

  for (let i = 0; i < bound; i++) {
    const issue = relevantIssues[i];
    comments.push({
      path: file.filename,
      line: issue.line,
      body: formatCommentBody(issue),
      severity: issue.severity,
    });
  }

  core.info(`  Found ${relevantIssues.length} issue(s) on changed lines (${result.stats.total} total in file)`);

  return comments;
}

// ---------------------------------------------------------------------------
// Check all doc files and collect review comments
// ---------------------------------------------------------------------------
async function checkAllFiles(docFiles, prCtx, inputs) {
  console.assert(Array.isArray(docFiles), "checkAllFiles: docFiles must be an array");
  console.assert(docFiles.length > 0, "checkAllFiles: docFiles must not be empty");

  const allComments = [];
  const fileBound = Math.min(docFiles.length, MAX_FILES_TO_CHECK);

  for (let i = 0; i < fileBound; i++) {
    const fileComments = await processFile(docFiles[i], prCtx, inputs);
    for (let j = 0; j < fileComments.length && allComments.length < inputs.maxComments; j++) {
      allComments.push(fileComments[j]);
    }

    if (allComments.length >= inputs.maxComments) {
      core.warning(`Reached maximum comment limit (${inputs.maxComments}). Stopping.`);
      break;
    }
  }

  return allComments;
}

// ---------------------------------------------------------------------------
// Report results: post review and set outputs
// ---------------------------------------------------------------------------
async function reportResults(allComments, prCtx, inputs) {
  console.assert(Array.isArray(allComments), "reportResults: allComments must be an array");
  console.assert(typeof inputs.failOnError === "boolean", "reportResults: failOnError must be boolean");

  if (allComments.length > 0) {
    core.info(`Posting review with ${allComments.length} comment(s)...`);
    await postReview(prCtx.owner, prCtx.repo, prCtx.prNumber, prCtx.headSha, allComments, inputs.token);
    core.info("Review posted successfully.");
  } else {
    core.info("No grammar issues found on changed lines. Great writing!");
  }

  const errorCount = allComments.filter((c) => c.severity === "error").length;
  const warningCount = allComments.filter((c) => c.severity === "warning").length;

  core.setOutput("issues-found", allComments.length.toString());
  core.setOutput("errors", errorCount.toString());
  core.setOutput("warnings", warningCount.toString());

  if (errorCount > 0 && inputs.failOnError) {
    core.setFailed(`Found ${errorCount} grammar error(s). See review comments for details.`);
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------
async function run() {
  const inputs = readInputs();
  const prCtx = extractPRContext();

  core.info(`Checking PR #${prCtx.prNumber} in ${prCtx.owner}/${prCtx.repo}`);
  core.info(`Severity threshold: ${inputs.severityThreshold}`);
  core.info(`File patterns: ${inputs.filePatterns}`);

  console.assert(prCtx.prNumber > 0, "run: prNumber must be positive");
  console.assert(inputs.token.length > 0, "run: token must not be empty");

  // Step 1: Get changed files and filter to doc files
  const allFiles = await getPRFiles(prCtx.owner, prCtx.repo, prCtx.prNumber, inputs.token);
  core.info(`Total files changed in PR: ${allFiles.length}`);

  const docFiles = filterFilesByPattern(allFiles, inputs.filePatterns);
  core.info(`Documentation files to check: ${docFiles.length}`);

  if (docFiles.length === 0) {
    core.info("No documentation files changed. Skipping grammar check.");
    return;
  }

  // Step 2: Check all files and post results
  const allComments = await checkAllFiles(docFiles, prCtx, inputs);
  await reportResults(allComments, prCtx, inputs);
}

// ---------------------------------------------------------------------------
// Entry point with error boundary
// ---------------------------------------------------------------------------
run().catch((err) => {
  core.setFailed(`BeLikeNative Grammar Check failed: ${err.message}`);
  core.error(err.stack ?? err.message);
});
