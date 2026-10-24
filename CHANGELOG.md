# Changelog

Changes maintained by the Even G2 fork. Upstream release history remains in
[T3 Code releases](https://github.com/pingdotgg/t3code/releases).

## Unreleased

### Added

- Group sidebar projects into swipeable spaces on web and desktop, with the
  current space shown in the sidebar footer.

### Fixed

- Keep iPhone thread headings readable with one Thread tools menu, allow
  landscape rotation, show the existing sidebar when usable width fits, and
  retain thread-list navigation after returning to portrait.

- Route the fork checkout's triage command, source lookups, and reports to
  `michft/t3-even-g2`, preserving maintainer acceptance and publishing controls.

- Submit the current address and pairing code from mobile native toolbar buttons.

- Prevent the mobile header from crashing while connecting an environment.

- Stop redrawing the G2 thread picker when unchanged choices arrive, and wait
  for glasses acknowledgements without polling.

- Keep fork workflows on available GitHub-hosted runners after Nightly imports.

- Recover mobile secure-storage reads after iOS protected-data denials and
  unlock, preserving the saved connection catalog and healthy background reads.

### Changed

- Run installed-native connection checks on iPhone and iPad simulators with the
  same private read-only test configuration used for physical iOS deployments.

- Allow iOS test deployments to require authenticated host and installed-native
  configuration checks, using private read-only credentials and isolated sessions.

- Integrate T3 Nightly `v0.1.2-nightly.20261021.3499`, restoring mobile config
  compatibility while preserving G2 controls,
  fork appearance, numbered replies, signing, and GitHub-hosted runners.

- Integrate T3 Nightly 20261020 on current fork main, retaining G2 controls,
  repository/server tints, numbered replies and the existing iOS app identity.

- Integrate T3 Nightly 20261017 on current fork main, preserving G2/R1,
  repository colours, numbered clarification replies and fork signing.

- Document the upstream relay deploy and Release workflows as disabled in the
  fork because they need T3 secrets; the relay failed on pushes to `main` and
  Release on scheduled runs.

- Restore upstream-owned files to the published Nightly, removing fork-only
  refactors, export narrowing and docstrings that caused merge conflicts.
  Mention server and repository thread colours in the README.

- Integrate T3 Nightly 20261015 on current fork main, preserving repository
  colours, G2 settings, numbered clarification replies and fork signing.

- Restore mobile repository colour tabs and independent server/repository tints;
  remove the explanatory subtitle and place Natural G2 scrolling and G2 + R1
  below the other Interface settings.

- Integrate T3 Nightly 20261013 into current fork main, preserving G2/R1,
  numbered clarification replies, fork signing and host-owned appearance;
  retain imported reference submodule metadata for CI checkout cleanup.

- Validate physical iOS updates before installation, preserve signed app and
  Keychain identity, and retain one artifact with per-device deployment receipts.
- Add an isolated fork TestFlight profile with explicit Apple/Expo identity,
  store signing, increasing build numbers, and Expo OTA updates disabled.
- Integrate T3 Nightly 20261011, preserving G2/R1 controls, numbered
  clarification replies, fork app signing, and environment appearance.
- Keep native layout metrics buildable with Xcode 27.0 by checking the UIKit
  SDK version before compiling iOS 27.1 hinge APIs.

- Render structured clarification questions as ordinary conversation text on
  web, desktop, and mobile; accept numbered choices through the text composer.

- Document enrolled Developer Team signing for longer-lived iOS deployments,
  including profile expiry and app identity/Keychain compatibility checks.
- Ask agent clarification questions in chat, using numbered choices with
  "Something else" last instead of question-tool button panels.
- Require docstring coverage above 90%, targeting 100%, with measurement
  evidence in PR validation.
- Require PR documentation relevance decisions, design and regression
  assessments, and independent agent review evidence tied to the final commit
  and PR description. CI checks the evidence; maintainers require `Check` and
  `PR quality` in the main ruleset to enforce merging.
