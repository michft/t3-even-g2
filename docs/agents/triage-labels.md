# Triage labels

The canonical skill roles use the same names in the fork's GitHub tracker:

| State             | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `needs-triage`    | Awaiting maintainer evaluation                           |
| `needs-info`      | Waiting for specific evidence from the reporter          |
| `ready-for-agent` | Accepted, fully specified work for an assigned agent     |
| `ready-for-human` | Accepted work requiring human judgment or implementation |
| `wontfix`         | Not accepted; close with the reason                      |

Every triaged issue has one category (`bug` or `enhancement`) and one state.
Remove the previous state when transitioning. If states conflict, ask the
maintainer which applies instead of guessing. `via-triage` records provenance,
not readiness; it can coexist with any state.

New issues enter `needs-triage`. A reporter reply to `needs-info` requires
maintainer re-evaluation before returning to `needs-triage`; no automatic agent
is launched. Ready issues are accepted work. Assign an owner before starting,
link the implementation PR, and use assignment plus that PR to track progress.
No additional in-progress labels are required.
