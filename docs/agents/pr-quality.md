# PR quality and human acceptance

Every fork PR needs documentation relevance decisions, passing CI, an independent
agent review, and an assessment of design and regression scope. This applies to
Nightly integrations and documentation changes too. Update README and changelog
when relevant; do not make meaningless edits merely to satisfy a checkbox.

## Responsibilities

The author runs focused checks automatically, verifies the requested behavior,
and reviews affected entry points, clients, contracts, providers, connection
modes, and reverse states. Explain which areas apply, which do not, and why the
change is the smallest sufficient solution. Record failures and verification
gaps honestly. Do not claim that tests prove all other areas are unaffected.

A different agent execution reviews the final diff, requirements, documentation
decisions, validation evidence, and regression risks. It must not have authored
the patch. Identify author and reviewer by stable task or execution IDs, not two
names for the same agent. Resolve valid findings, explain rejected findings, then
rerun affected checks and review the final revision. A skipped CodeRabbit review
does not count; the automatic Nightly skip remains unchanged.

The human sets acceptance criteria, judges tradeoffs and remaining gaps, checks
the review evidence, and authorizes publishing and merging. CI verifies evidence
and test results; it cannot prove that an agent actually ran independently or
that its judgement is correct. A repository collaborator attests that review
took place. The collaborator may operate both agents through one GitHub account.

For example, a G2 input change must distinguish R1, left-arm, and right-arm
behavior. Simulated checks do not prove glasses behavior. An iPhone deployment
must preserve the existing app identity and saved environments, and verify the
installed native build rather than infer success from a browser or iPad alone.
See the [G2 runbook](../operations/even-g2.md).

## PR description

Keep exactly one `pr-quality` JSON block, provided by the
[PR template](../../.github/pull_request_template.md). Complete every field:

- `author_agent`: author execution ID; human-only work uses `human:<login>`.
- `readme` and `changelog`: `status` is `updated` or `not-needed`, with a concrete
  `reason`. For `updated`, list changed files in `files`; otherwise use `[]`.
  README updates can name a component README. Changelog updates name the root
  `CHANGELOG.md`. Relevant user or operation guides still need updates too.
- `validation`: commands and results, plus any remaining verification gaps.
- `design`: why this scope and design are minimal; mention avoided dependencies
  or abstractions when useful.
- `regression`: affected and neighboring areas, relevant checks, and residual
  risk. State whether web, desktop, mobile, server, or shared contracts apply.

Root `README.md` and `CHANGELOG.md` must remain nonempty files. CI checks that
claimed updates exist in the PR diff. Documentation exemptions and the quality
of these assessments are judged by the independent reviewer and human.

## Independent review evidence

After reviewing the final commit and completed PR description, a repository
collaborator with write access posts a PR comment containing this block:

```pr-quality-review
{
  "head_sha": "<full PR head commit SHA>",
  "body_sha256": "<digest of completed PR description>",
  "reviewer_agent": "<distinct reviewer task or execution ID>",
  "model": "<actual reviewer model>",
  "harness": "<actual reviewer harness>",
  "result": "pass",
  "findings": "<findings, fixes or rejected findings with reasons; remaining gaps>"
}
```

Add the review report or a public evidence link beside the block. Use `fail` for
unresolved findings. CI uses the latest collaborator review comment; deleting it
or posting a newer failed review removes the pass. An external comment cannot
attest a review. A bot's green or skipped status alone cannot satisfy this gate.

Get the SHA and normalized description digest from the current PR:

```sh
gh pr view <number> --repo michft/t3-even-g2 --json headRefOid,body |
  node .github/scripts/pr-quality.cjs
```

Line endings and surrounding whitespace are normalized. Any other description
edit or head change invalidates the attestation. Review again and post a fresh
comment after fixes. Do not reuse an old review for a new commit. CI remembers
the newest observed attestation in commit status history; removing that evidence
requires a fresh review comment and cannot revive an older pass.

## CI and merge enforcement

[PR quality CI](../../.github/workflows/pr-quality.yml) reads PR metadata through
GitHub APIs and executes only default-branch code. It publishes `PR quality` on
the PR head, rechecking on pushes, description edits, and comment changes. It
fails for missing or invalid evidence, stale or failed review, missing required
documents, and unverified claimed documentation edits. Open PRs must have unique
head commits because GitHub statuses are shared per commit. API failures fail closed.
The existing CI aggregate `Check` continues to require tests and other CI jobs
to pass; local command prose is not a substitute for that result.

After this workflow lands on `main`, a repository administrator must create or
update a `main`-only ruleset requiring `Check` and `PR quality`, selecting
GitHub Actions as their source. Leave shared dev/prod branch rules unchanged.
Preserve existing PR, deletion, history, and bypass rules. Do not enable a
required status before its workflow exists, or
every PR will wait for a status that cannot run. Workflow files alone do not
change GitHub merge rules. See GitHub's
[ruleset API documentation](https://docs.github.com/en/rest/repos/rules).

Verify enforcement with an open PR: missing evidence must be red, completed
current review plus green tests must pass, and a new commit must invalidate the
review. The workflow's manual dispatch accepts a PR number for recovery. Confirm
both statuses are required in the merge panel; a green workflow alone is not
proof of merge enforcement. Administrators remain responsible for bypasses.

## Where information lives

This tracked guide owns the policy. Root `AGENTS.md`, fork instructions, and the
contribution guide link here. CI owns mechanical enforcement. The issue owns
acceptance criteria; the PR owns validation and review evidence. `.plans/` holds
local, uncommitted implementation plans and links to this guide, not a second
policy or implementation history.
