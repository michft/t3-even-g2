# Changelog

Changes maintained by the Even G2 fork. Upstream release history remains in
[T3 Code releases](https://github.com/pingdotgg/t3code/releases).

## Unreleased

### Changed

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
