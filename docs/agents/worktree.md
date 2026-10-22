# Parallel tasks in JJ workspaces

Independent tasks and subagents may run in parallel. Give each task that edits
files its own JJ workspace with Git colocation. Read-only research and review
may share a checkout. Creating local workspaces for an already authorized task
does not need another confirmation.

## Location and ownership

- Create workspaces at `<repo>/.worktrees/<task-name>`, for example
  `~/src/even-g2/.worktrees/spaces-mobile`. `/.worktrees/` is ignored by Git,
  Vitest, and Metro.
- Use JJ to create and manage workspaces, changes, and bookmarks. Git colocation
  makes each workspace a linked Git worktree, so Git-based tools work there and
  a detached Git HEAD is normal.
- Do not create a second checkout with `git worktree add`, and do not use
  `git checkout` or `git switch` in a JJ-owned workspace.
- Do not create this project's workspaces under `~/.t3/worktrees`.
- A new workspace starts from the chosen revision. It does not copy another
  workspace's uncommitted edits or ignored files such as `.env.local`.
- Preserve unrelated edits in the main checkout. Never delete or move another
  agent's active workspace.

## Create a workspace

From the main checkout, inspect the current state and fetch:

```sh
cd <repo>
jj status
jj workspace list
jj git fetch --remote origin
mkdir -p .worktrees
```

When no earlier PR remains unmerged, start from fork `main`:

```sh
jj workspace add --colocate --name task-a -r main@origin .worktrees/task-a
jj -R .worktrees/task-a bookmark create feat/task-a -r @
```

Use a distinct workspace name, path, and bookmark for each parallel task.
Confirm the base before editing: `jj -R .worktrees/task-a log -r @-`.

Then install dependencies and link the shared `.env` files, as T3's
Setup Worktree action does for its own worktrees:

```sh
cd .worktrees/task-a
T3CODE_PROJECT_ROOT=<repo> node scripts/setup-worktree.ts
```

Wait for `.t3/setup-done`. If `.t3/setup-failed` appears, read its error tail.
Do not symlink `node_modules` from another checkout.

## State, ports, and verification servers

- The dev runner, `pair`, and `migrate-dev-db` recognize the workspace as a
  linked worktree. Its state lives in its own `.t3`, and its ports derive from
  its path. Read the actual ports from the `[dev-runner]` line.
- Each workspace may run its own verification server at the same time as other
  workspaces. Never reuse, interrupt, or stop another agent's server. Stop your
  own by the PID you captured.
- Seed test data with `vp run migrate-dev-db` from inside the workspace while
  its server is stopped.
- Physical devices and simulators are shared. Only one agent may build onto,
  install on, or drive a given device or simulator at a time. Agree the order
  through the parent agent.

## Sequential changes and PR stacking

- Start a sequential or follow-on change from the previous change's latest
  bookmark, including its review fixes. Do not restart from `main` while the
  predecessor is still unmerged.
- Create a new workspace and bookmark on that revision instead of editing the
  previous task's workspace. For example, replace `-r main@origin` above with
  `-r feat/previous-task`.
- Every new PR stacks on the previous unmerged PR. Target its branch as the PR
  base and name that predecessor in the PR body. Coordinate publication order
  even when the implementation tasks ran in parallel.
- Merge stacks bottom-up into `main`. After a predecessor merges, retarget its
  immediate successor to `main` **before** merging the successor. Merging a PR
  into an already merged base branch leaves its changes off `main`. Fetch and
  confirm the merged changes are on `main@origin` before continuing.

## Assign parallel work

- Give each implementation agent a bounded task, its absolute workspace path,
  base revision, bookmark, and validation requirements. Keep dependent tasks in
  order and run independent ones concurrently.
- Bind the agent or thread to that workspace through the orchestration tool's
  workspace selection. A shell `cd` does not change T3's thread binding. Verify
  the resolved path before editing.
- For a new T3 thread, use `t3_thread_launch` with
  `workspaceStrategy: {"type": "existing_worktree", "worktreePath": ...}` and
  the prepared absolute path.
- If a delegated agent cannot attach to the prepared workspace, report that
  limitation. Do not substitute an outside checkout or let parallel agents edit
  the same checkout. Read-only subtasks can still proceed.
- Supply only the environment files the task's target needs. Never commit
  secrets or copy them into chat.

## Verify and publish

Run these from the main checkout, not from inside the workspace:

```sh
cd <repo>
jj -R .worktrees/task-a status
jj -R .worktrees/task-a workspace list
git -C .worktrees/task-a rev-parse --show-toplevel
```

Run the task's focused checks and relevant builds inside its workspace, review
its diff, then advance only its bookmark and push with JJ:

```sh
jj -R .worktrees/task-a bookmark set feat/task-a -r @
jj -R .worktrees/task-a git push --remote origin --bookmark feat/task-a
```

Only fast-forward pushes are allowed, and the user merges PRs. Follow
[PR quality](pr-quality.md) for each PR. Return the workspace path, bookmark,
commit, validation results, and PR URL to the parent agent.

## Clean up

When a task's PR has merged and nothing in its workspace is unpublished, run
from the main checkout:

```sh
cd <repo>
jj workspace forget task-a
rm -rf .worktrees/task-a
```

`jj workspace forget` also removes the colocated Git worktree record.

Remove only workspaces you created. Keep any with unreviewed or unpublished
work.
