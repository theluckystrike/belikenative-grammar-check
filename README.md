# BeLikeNative Grammar Check

A GitHub Action that checks grammar in PR documentation files and posts inline review comments. Catches common non-native speaker errors with L1-aware explanations.

**Rule-based. No AI API keys required.**

## Features

- 55+ grammar, spelling, style, and punctuation rules
- L1 Insights: explains WHY non-native speakers make each error
- Posts inline review comments on changed lines only
- Markdown-aware: skips code blocks, frontmatter, and inline code
- Configurable severity threshold (error / warning / info)
- Sets check status: fails on errors, passes on warnings/info

## Quick Start

Create `.github/workflows/grammar-check.yml`:

```yaml
name: Grammar Check

on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - '**.md'
      - '**.txt'
      - '**.mdx'
      - '**.rst'

permissions:
  contents: read
  pull-requests: write

jobs:
  grammar-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: your-org/bln-grammar-check@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `github-token` | GitHub token for posting review comments | `${{ github.token }}` |
| `severity-threshold` | Minimum severity to report: `error`, `warning`, `info` | `warning` |
| `file-patterns` | Comma-separated glob patterns for files to check | `**/*.md,**/*.txt,**/*.mdx,**/*.rst` |
| `max-comments` | Maximum number of review comments per PR | `50` |
| `fail-on-error` | Fail the check if error-level issues are found | `true` |

## Outputs

| Output | Description |
|--------|-------------|
| `issues-found` | Total number of issues found |
| `errors` | Number of error-level issues |
| `warnings` | Number of warning-level issues |

## What It Catches

### Grammar Errors (severity: error)

- Missing articles: "I went to store" (missing "the")
- Wrong articles: "an university" (should be "a")
- Homophone confusion: their/there, its/it's, your/you're, then/than
- Modal verb errors: "could of" (should be "could have")
- Subject-verb agreement: "he don't" (should be "doesn't")
- Irregular past participles: "have went" (should be "have gone")
- Common misspellings: definately, seperate, occured, recieve, alot

### Style Warnings (severity: warning/info)

- Passive voice detection
- Wordy phrases: "in order to" (use "to"), "due to the fact that" (use "because")
- Unnecessary formality: "utilize" (use "use")
- Technical writing anti-patterns: "Click on" (use "Click"), "please", "simply"
- Minimizing language: "easy", "just", "obvious"

### L1 Insights

Each rule can include an L1 Insight explaining why speakers of specific languages make this error:

> **L1 Insight:** This is a common pattern for speakers of languages without articles (Chinese, Japanese, Korean, Russian, Turkish). These languages don't use "a/an/the", so omitting articles feels natural.

## How It Works

1. Triggers on PR open/synchronize events
2. Fetches the list of changed files via GitHub API
3. Filters to documentation files matching the configured patterns
4. For each file, fetches content and parses the diff to identify changed lines
5. Runs 55+ regex-based grammar rules against prose content (skips code blocks, frontmatter)
6. Only reports issues on lines that were actually changed in the PR
7. Posts a single PR review with inline comments on flagged lines
8. Sets check status: FAIL if errors found (configurable), PASS otherwise

## Markdown Awareness

The checker is markdown-aware and will skip:

- Fenced code blocks (triple backticks or tildes)
- YAML frontmatter (between `---` markers at file start)
- Inline code spans (backtick-wrapped text)
- HTML tags
- Link URLs (but checks link text)
- Image alt text is checked

## Local Development

```bash
# Install dependencies
npm install

# Run tests
npm test
```

## Architecture

```
src/
  index.mjs            # Action entry point (orchestrator)
  grammar-checker.mjs  # Rule engine (line-by-line checking)
  rules.mjs            # 55+ grammar rules (frozen, immutable)
  github-api.mjs       # GitHub API interactions (fetch, review)
```

All code follows NASA Power of 10 rules:
- All functions under 60 lines
- Minimum 2 assertions per function
- All loops have fixed upper bounds
- No global mutable state
- All API responses checked

## License

MIT

---

*Built by [BeLikeNative](https://belikenative.com) -- AI writing assistant for non-native speakers*
