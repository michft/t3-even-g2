<!--
PR creation is limited to repository collaborators. Public contributions start
with an issue in michft/t3-even-g2. This PR must implement accepted fork work.
See CONTRIBUTING.md and docs/operations/even-g2-triage.md.
-->

## Issue

<!-- Replace with the accepted fork issue number. Use "Refs" for a partial fix. -->

Closes #<issue-number>

## What changed and why

<!-- Describe the problem, resulting behavior, and scope. One concern per PR. -->

## Validation

<!-- List commands and results. State failures and remaining verification gaps.
     For G2 changes, distinguish simulated checks from physical hardware tests. -->

## UI evidence

<!-- Include before/after images for UI changes and video for motion or timing.
     Upload evidence to GitHub; do not commit PR-only assets. Delete if unused. -->

## Quality evidence

<!-- Complete this JSON block. README/changelog: updated with changed files,
     or not-needed with a concrete reason and []. All PRs need both decisions.
     See docs/agents/pr-quality.md. A different agent reviews the final diff
     and this description; a collaborator posts its attestation in a comment. -->

```pr-quality
{
  "author_agent": "<author task or execution ID, or human:login>",
  "readme": {
    "status": "updated",
    "reason": "<why README needs an update, or why not-needed>",
    "files": ["README.md"]
  },
  "changelog": {
    "status": "updated",
    "reason": "<why changelog needs an update, or why not-needed>",
    "files": ["CHANGELOG.md"]
  },
  "validation": "<commands, results, remaining verification gaps>",
  "design": "<smallest sufficient design and scope>",
  "regression": "<affected areas, neighboring checks, residual risks>"
}
```

## Checklist

- [ ] Linked an accepted issue in michft/t3-even-g2
- [ ] Kept changes within its acceptance criteria
- [ ] Recorded relevant validation and remaining gaps
- [ ] Updated affected user or contributor guides

<!-- For agent-assisted changes, end with the model and harness used. -->
