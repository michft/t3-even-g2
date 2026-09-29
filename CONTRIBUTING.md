# Contributing to the Even G2 fork

Public contributions start with an issue in
[michft/t3-even-g2](https://github.com/michft/t3-even-g2/issues). Bugs, feature
requests, reproduction details, and diagnostic evidence are welcome.

**Pull request creation is limited to repository collaborators.** External
contributors should open or update an issue rather than submit a PR. A
maintainer reviews the issue, accepts its scope, and assigns implementation to
a collaborator or an agent operating through an authorized collaborator.
Opening an issue does not automatically start an agent or promise a fix.

## Report or investigate an issue

Search open and closed fork issues first. Use **G2 bug report**, **G2 feature
request**, or **G2 triage report** as appropriate. Keep one problem per issue.

Follow the [triage guide](docs/operations/even-g2-triage.md) to investigate from
a phone or desktop, collect G2 diagnostics, and prepare a report. Keep reports
here when ownership is uncertain. Escalate upstream only when evidence
identifies a defect in upstream code.

## From an accepted issue to a PR

1. A maintainer checks evidence, duplicates, impact, and scope. Missing details
   get `needs-info`; accepted work gets `ready-for-agent` or `ready-for-human`.
2. The maintainer records acceptance criteria and verification expectations,
   assigns an owner, and explicitly requests implementation. A ready label is
   a queue state, not permission for an unattended agent to publish changes.
3. The owner implements the agreed scope on a separate branch or JJ bookmark
   and runs relevant checks. For native G2 changes, distinguish local tests,
   phone build/install results, and physical glasses verification.
4. When authorized to publish, the collaborator opens a PR against this fork.
   Link the accepted issue with `Closes #123` for a complete fix or `Refs #123`
   for partial work. Do not target T3 upstream by default.
5. Review checks and findings, verify the acceptance criteria, then merge.
   Record any remaining hardware verification before closing the issue.

See the [maintainer workflow](docs/operations/even-g2-triage.md#maintainer-workflow)
for labels and a phone-friendly handoff prompt.

## PR requirements

- One concern per PR; keep unrelated work separate.
- Use a conventional title, such as `fix(mobile): recover G2 display after idle`.
- Explain the problem and resulting behavior, then list validation results.
- Include before/after images for UI changes; include video for motion or
  timing. Upload evidence to GitHub instead of committing PR-only assets.
- Update relevant tracked guides when behavior or setup changes.
- End agent-assisted descriptions with the model and harness used.

PR size and trust labels provide context; they do not grant permission to open
PRs. Repository collaborator access controls that permission.

## Development setup

Use the [development runbook](docs/operations/development.md#first-checkout)
and [mobile setup](apps/mobile/README.md#development). Follow the repository
[agent instructions](AGENTS.md) and [documentation rules](AGENTS.md#documentation).

User and contributor guides belong in tracked `docs/`. Private machine details
and checkout notes belong in gitignored `.plans/`.
