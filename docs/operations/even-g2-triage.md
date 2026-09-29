# Even G2 fork triage

Use a normal T3 thread to investigate a problem and prepare an issue for
[michft/t3-even-g2](https://github.com/michft/t3-even-g2/issues). Here, "local"
means this fork's GitHub tracker. It does not mean an offline issue database.

The phone controls the conversation; the agent runs on the connected T3
environment's machine. That machine needs this fork checkout and an available
agent. GitHub access is needed to search or post issues. For native iPhone
diagnostics, use a Mac that can reach the paired phone.

## What is available

This is a manual, agent-assisted workflow. The repository has a bug form with
`needs-triage`, a structured triage report form, and a fork feature request
form. These forms do not automatically investigate or prioritize reports.
There is no dedicated mobile triage screen or configured multi-stage triage
queue. GitHub only shows template changes once they reach its default branch.

Do not use `npx t3 triage` for this fork workflow yet. Its current playbook and
generated context still point to T3 upstream, including upstream source and
issue links. Changing the issue templates did not adapt that CLI. Use the
thread workflow below instead.

## Start on the phone

1. Connect the T3 mobile app to your existing environment. Select the project
   rooted at your Even G2 fork checkout on that machine, then open a thread.
2. Describe one problem: steps, expected result, actual result, approximate
   time, and frequency. For an existing issue, include its fork issue URL.
3. Include the installed app's build commit if known, iOS and G2/R1 firmware,
   input source (R1, left arm, or right arm), Natural scrolling setting, and
   whether the phone was locked or backgrounded. Say when a value is unknown;
   the current checkout commit may differ from the installed build.
4. Ask the agent to investigate and prepare a report. For example:

```text
Investigate this Even G2 fork issue in the current project.
Read AGENTS.md and docs/operations/even-g2-triage.md.
Search michft/t3-even-g2 for duplicates. Keep this report in that fork.
Use local fork code and available diagnostics; identify missing evidence.
Prepare findings and an issue draft. Do not post it or change code yet.

Problem:
Steps:
Expected:
Actual:
Time and timezone:
Installed build and device/firmware details:
```

If the mobile app cannot connect, use an existing desktop/web session or record
the details directly in the fork tracker. Phone access to an agent requires a
working environment connection; the Release app does not need Metro.

## Collect phone evidence

Server logs do not capture all phone Bluetooth, microphone, or display failures.
Ask the agent on the paired Mac to collect G2 diagnostics soon after the fault.
From the fork repository root, the existing commands are:

```bash
node scripts/g2-diagnostics.ts pull <device-id> <installed-bundle-id>
node scripts/g2-diagnostics.ts report <download-directory>
```

Replace placeholders with the confirmed phone and installed app identity. Use
`xcrun devicectl list devices` to find the paired device and
`xcrun devicectl device info apps --device <device-id>` to check its app IDs.
The pull command prints the download directory without restarting the app.
Reports default to the latest connection run; append an ISO timestamp to the
report command to select events from that time onward.

These commands run on the Mac with Xcode tooling, not inside the iPhone app.
If the Mac cannot reach the phone, record that limitation and continue with
available evidence; a T3 connection alone does not grant access to phone logs.

Include what you saw on the glasses. A completed Bluetooth write does not prove
the displayed result. Distinguish simulated checks from physical hardware
observations, and remove secrets or identifying metadata from shared evidence.

## Review, file, and follow up

Search open and closed fork issues first. If a report matches, prepare an update
for that issue instead of creating a duplicate. Otherwise, draft one report
with the problem, diagnosis and uncertainty, reproduction steps, expected and
actual behavior, impact, installed version, environment, evidence, related
issues, and any workaround. Agent-assisted reports should name the model and
harness used.

Review the draft in the phone thread. To publish, explicitly ask the agent to
file it in `michft/t3-even-g2` or add it to the matching fork issue. The agent
should specify `--repo michft/t3-even-g2` when using `gh` and return the issue
URL. If host GitHub authentication is unavailable, copy the draft into the
fork tracker using your phone browser. Use the bug form for faults and the
feature form for improvements when those forms are available.

For a later triage pass, open a project thread and give the agent the fork
issue URL. Ask it to check missing evidence, duplicates, impact, and the next
action. Request implementation separately. Record verification results on the
issue when authorized, and close it once the fix is confirmed.

Assume upstream works. Keep uncertain ownership in the fork tracker. Only
propose upstream escalation when evidence identifies an upstream-code defect;
posting upstream requires an explicit user request. Never launch upstream
verification. Run verification servers locally from this fork with isolated
test state, never live T3 userdata. Before starting one, check for existing
verification servers on this machine; wait for another agent's verification
to finish rather than starting a competing session on another port. Stop only
the servers you started, using their captured PIDs. See
[AGENTS.md](../../AGENTS.md) for repository instructions.
