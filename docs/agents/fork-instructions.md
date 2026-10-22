# Even G2 fork instructions

Apply these fork-specific instructions alongside the root
[AGENTS.md](../../AGENTS.md). They are tracked so all contributors and agents
use the same workflow. `.plans/` is reserved for planning, not documentation.

## Communication and scope

- Ask clarifying questions in normal chat, not through question tools that
  create button panels. When offering choices, use a numbered list and always
  end with "Something else." Accept a number or a free-text answer. This is repo
  agent guidance; higher-priority harness instructions still take precedence.
- Prefer the smallest change that meets the request. Preserve distinct product
  concepts and input sources; ask when intent or scope is unclear.
- Plan broad work first. Run independent tasks and subtasks in parallel and
  keep dependent ones in order. Give each parallel task that edits files its
  own JJ workspace, following the [workspace guide](worktree.md). If work is
  too large, state a bounded scope before proceeding.

## Fork, upstream, and JJ

- Use JJ. Check `jj status` and bookmarks before choosing a base; snapshots in
  local notes may be stale.
- This repository is a downstream fork, `michft/t3-even-g2` (`origin`). T3
  upstream is remote `t3` (`pingdotgg/t3code`), treated as read-only.
  Upstream T3 updates mean published **Nightly**, not an assumed `t3/main` base.
- A request to "pull in T3 and merge" means download the published Nightly and
  integrate it into fork main on `origin`. Start from refreshed `main@origin`;
  keep the upstream merge separate from unrelated feature PRs. Resolve merge
  conflicts and compatibility fixes in this downstream fork.
- In JJ discussions, "upstream" can also mean earlier local changes in the
  change ancestry. Clarify when that meaning or a different target is unclear;
  do not ask again which remote a clear T3 Nightly sync targets.

- Pushes, PRs, Build/install requests do not require explicit authorisation.
  A change requested in chat, or in a delegated or scheduled task, is finished
  only as an actionable fork PR that follows [PR quality](pr-quality.md):
  pushed, described, independently reviewed, and with checks passing. Open it
  without asking again; ask first only when the target repository or base is
  genuinely unclear. Requested sync PRs target fork main on `origin`; respect
  fork branch protection and any "PR only" instruction. Do not merge an open
  PR without authorization.
- Do not modify or push to T3 upstream, or propose a PR there, as part of a
  downstream sync. If integration requires upstream changes or an upstream PR,
  request explicit maintainer approval first. Downstream merge authorization
  does not authorize upstream work.
- Keep G2 code, fork documentation, and unrelated upstream work separate.
- Keep upstream-owned files identical to the published Nightly unless a fork
  feature or fork CI needs the change. Do not refactor, rename, un-export,
  delete, or add docstrings to upstream code; every such edit becomes a
  conflict on the next Nightly. Propose upstream cleanups upstream instead.
  Check with `git diff <nightly-commit> -- <path>`.
- Public contributions start as fork issues. Only repository collaborators
  create PRs, implementing accepted issues. Follow the tracked contributor
  guide and issue workflow; a ready label alone does not authorize publishing.

## Issue routing

- Keep fork issues and feature requests in `michft/t3-even-g2` on GitHub.
  "Local" issues means this fork's tracker, not files in this checkout.
- Send an issue to T3 upstream only when evidence identifies the problem in
  upstream code. If ownership is unclear, keep it in the fork tracker.
- Shared templates or `t3 triage` instructions pointing at `pingdotgg/t3code`
  do not override this rule. Specify `--repo michft/t3-even-g2` when using `gh`
  for fork issues. Posting upstream requires an explicit user request.

## Documentation

- `.plans/` is for planning only. Building, deployment, issue handling, and
  debugging guidance belong in tracked public `docs/`, with explicit G2 examples.
- Link guides from the README, docs index, or contribution guide. They must work
  in a fresh clone without `.plans/`. Use placeholders for personal device and
  signing values. Keep temporary scratch files outside the worktree.
- Preserve unrelated upstream docs; do not force-add planning files.
- Update relevant guides when fork behavior or setup changes. Avoid
  duplicating implementation details or dated deployment state here.
- Use actual line breaks near 80 characters, with a hard maximum of 120.
- Consult [glasses controls](../user/even-g2.md),
  [building, deployment, and diagnostics](../operations/even-g2.md),
  [issue triage](../operations/even-g2-triage.md), and
  [fork contributions](../../CONTRIBUTING.md) for task-specific guidance.

## Validation and deployment

- This fork account has GitHub-hosted runners only. Audit Nightly workflow
  imports for Blacksmith labels in both `runs-on` and reusable-workflow runner
  inputs, and replace them with GitHub-hosted labels while preserving OS and
  architecture. Do not leave required jobs queued for unavailable runners.
- Verification is a required build stage. Authorization to build includes
  starting any Metro, Vite, T3, or other verification server needed to check
  the result, plus browser and computer-use verification of affected behavior.
  Do not ask for separate approval for these verification steps. This standing
  authorization overrides the general server/browser approval restrictions
  for build verification; unrelated server or browser work remains outside it.
- All servers started for this work must run locally from this fork checkout.
  Never run verification services against T3 upstream code or use upstream or
  remote servers as verification targets.
- Assume T3 upstream works. Verify local fork changes and their effects; do
  not launch separate verification of unchanged upstream code.
- Each checkout or JJ workspace may run its own verification server at the
  same time as others, using its own `.t3` state and the ports the dev runner
  derives for it. Never reuse, interrupt, or stop another agent's server. The
  main checkout keeps its state in-repo through `T3CODE_HOME=<repo>/.t3` in
  its ignored `.env.local`. Physical devices and simulators are shared: only one
  agent may build onto, install on, or drive a given device at a time.
- Use isolated test state for verification; never run a verification server
  against live T3 userdata. Track processes started for verification and stop
  those servers afterward using their captured PIDs. Preserve existing servers.
- Always build Swift/native changes and install the successful build on the
  user's phone using the self-contained Release configuration. This includes
  JavaScript bundling and other build steps needed to produce the app, whether
  invoked through Xcode, pnpm, or vp. This is standing authorization; do not ask
  again for each build or phone installation.
- pnpm is a package manager and command runner, not a server. The Release app
  embeds JavaScript and needs no running Metro server. Live threads and agents
  still use the phone's existing T3 environment connection.
- Deliver requested testing deployments end to end: build test targets,
  configure private test credentials, execute the configured tests against the
  installed artifact, deploy successful builds, and create the requested PR.
  A proposal, unconfigured harness, or source-only pass is not implementation.
- Run checks appropriate to changed code. Do not run repo-wide checks
  unless requested. Report commands, results, and failures.
- Keep R1, left-arm, and right-arm gestures distinct. Preserve documented wake,
  navigation, and dictation semantics unless the task changes them.
- Simulated Bluetooth/native smoke tests do not verify physical G2/R1 behavior.
  Report which validation occurred; installation and launch prove deployment
  only. Hardware reports should identify firmware, input source, scrolling
  setting, and phone lock state.
- Native changes need a rebuilt and reinstalled app; JavaScript refresh cannot
  update the driver. Follow the public runbook for the build and deployment,
  confirm the target and app identity, and install over the existing app to
  retain its data. Keep `APP_VARIANT=development` when updating an existing
  `T3 Code Dev` Release installation.
