const assert = require("node:assert/strict");
const test = require("node:test");
const { bodyDigest, evaluateQuality, runQualityGate } = require("./pr-quality.cjs");

const sha = "a".repeat(40);
const manifest = () => ({
  author_agent: "author-task-123",
  readme: {
    status: "updated",
    reason: "New contributor setup needs a README link.",
    files: ["README.md"],
  },
  changelog: {
    status: "not-needed",
    reason: "Contributor-only guidance; no shipped behavior changed.",
    files: [],
  },
  validation: "node --test .github/scripts/pr-quality.test.cjs: passed.",
  design: "Reuses GitHub statuses and existing script patterns; no dependency added.",
  regression: "Only CI and contribution workflow affected; product clients unchanged.",
});
const block = (name, value) => `\x60\x60\x60${name}\n${JSON.stringify(value)}\n\x60\x60\x60`;

function fixture(evidence = manifest()) {
  const pull = {
    state: "open",
    head: { sha },
    body: block("pr-quality", evidence),
    changed_files: 1,
  };
  const review = {
    head_sha: sha,
    body_sha256: bodyDigest(pull.body),
    reviewer_agent: "review-task-456",
    model: "review-model",
    harness: "review-harness",
    result: "pass",
    findings: "No unresolved findings; docs decisions and regression scope checked.",
  };
  return {
    pull,
    review,
    files: [{ filename: "README.md", status: "modified" }],
    documents: { "README.md": true, "CHANGELOG.md": true },
    comments: [
      {
        id: 1,
        trusted: true,
        user: { login: "maintainer" },
        body: block("pr-quality-review", review),
      },
    ],
  };
}

test("accepts changed README plus independently reviewed changelog exemption", () => {
  assert.match(evaluateQuality(fixture()), /verified \(maintainer\)/);
});

test("requires actual matching documentation changes for updated decisions", () => {
  const data = fixture();
  for (const files of [
    [],
    [{ filename: "README.md", status: "removed" }],
    [{ filename: "docs/user/help.md", status: "added" }],
  ]) {
    assert.throws(() => evaluateQuality({ ...data, files }), /README updated/);
  }
  const evidence = manifest();
  evidence.changelog = {
    status: "updated",
    reason: "Changed shipped behavior.",
    files: ["CHANGELOG.md"],
  };
  assert.throws(() => evaluateQuality(fixture(evidence)), /Changelog updated/);
  const updated = fixture(evidence);
  updated.files.push({ filename: "CHANGELOG.md", status: "added" });
  assert.match(evaluateQuality(updated), /verified/);
});

test("requires both root documents and completed assessments even for docs-only PRs", () => {
  for (const path of ["README.md", "CHANGELOG.md"]) {
    const data = fixture();
    data.documents[path] = false;
    assert.throws(() => evaluateQuality(data), /must exist/);
  }
  for (const field of ["author_agent", "validation", "design", "regression"]) {
    const evidence = manifest();
    evidence[field] = "<fill in>";
    assert.throws(() => evaluateQuality(fixture(evidence)), /placeholder/);
  }
  const evidence = manifest();
  evidence.changelog.reason = "";
  assert.throws(() => evaluateQuality(fixture(evidence)), /Changelog reason/);
});

test("rejects stale review after either code or PR description changes", () => {
  const data = fixture();
  assert.throws(
    () => evaluateQuality({ ...data, pull: { ...data.pull, head: { sha: "b".repeat(40) } } }),
    /stale/,
  );
  assert.throws(
    () =>
      evaluateQuality({ ...data, pull: { ...data.pull, body: data.pull.body + "\nNew scope" } }),
    /stale/,
  );
  assert.equal(
    bodyDigest(data.pull.body + "\n"),
    bodyDigest(data.pull.body.replace(/\n/g, "\r\n")),
  );
});

test("rejects self-review, failed review, missing review, and external attestations", () => {
  for (const [field, value, message] of [
    ["reviewer_agent", "author-task-123", /different agent/],
    ["result", "fail", /must pass/],
    ["findings", "TBD", /placeholder/],
  ]) {
    const data = fixture();
    data.review[field] = value;
    data.comments[0].body = block("pr-quality-review", data.review);
    assert.throws(() => evaluateQuality(data), message);
  }
  assert.throws(() => evaluateQuality({ ...fixture(), comments: [] }), /collaborator/);
  const external = fixture();
  external.comments[0].trusted = false;
  assert.throws(() => evaluateQuality(external), /collaborator/);
});

test("latest collaborator attestation can revoke a prior pass; skipped bot review cannot pass", () => {
  const data = fixture();
  data.comments.push({
    ...data.comments[0],
    id: 2,
    body: block("pr-quality-review", { ...data.review, result: "fail" }),
  });
  assert.throws(() => evaluateQuality(data), /must pass/);
  assert.throws(
    () =>
      evaluateQuality({
        ...fixture(),
        comments: [{ id: 3, trusted: true, body: "CodeRabbit review skipped: merge T3 Nightly" }],
      }),
    /collaborator/,
  );
});

test("rejects duplicate or malformed evidence blocks and never executes their content", () => {
  const data = fixture();
  assert.throws(
    () =>
      evaluateQuality({
        ...data,
        pull: { ...data.pull, body: data.pull.body + "\n" + data.pull.body },
      }),
    /Exactly one/,
  );
  assert.throws(
    () =>
      evaluateQuality({
        ...data,
        pull: { ...data.pull, body: "```pr-quality\nprocess.exit(0)\n```" },
      }),
    /JSON object/,
  );
});

function apiFixture(options = {}) {
  const data = fixture();
  const statuses = [];
  const failures = [];
  const reads = [];
  let pullReads = 0;
  return {
    statuses,
    failures,
    reads,
    data,
    args: {
      pullNumber: 24,
      context: { repo: { owner: "michft", repo: "t3-even-g2" }, runId: 42 },
      core: {
        info() {},
        setFailed(message) {
          failures.push(message);
        },
      },
      github: {
        rest: {
          pulls: {
            async get() {
              pullReads++;
              return {
                data:
                  pullReads > 1 && options.changeDuringRun
                    ? { ...data.pull, body: "Changed scope" }
                    : data.pull,
              };
            },
            listFiles() {},
            list() {},
          },
          issues: { listComments() {} },
          repos: {
            listCommitStatusesForRef() {},
            async createCommitStatus(status) {
              statuses.push(status);
            },
            async getContent(params) {
              reads.push(params);
              if (options.readFailure)
                throw Object.assign(new Error("API unavailable"), { status: 503 });
              return { data: { type: "file", size: 100 } };
            },
            async getCollaboratorPermissionLevel({ username }) {
              return {
                data: {
                  permission: options.permissions?.[username] ?? options.permission ?? "write",
                },
              };
            },
          },
        },
        async paginate(endpoint) {
          if (endpoint === this.rest.repos.listCommitStatusesForRef) return options.history ?? [];
          if (endpoint === this.rest.pulls.listFiles)
            return options.incompleteFiles ? [] : data.files;
          if (endpoint === this.rest.pulls.list)
            return options.openPulls ?? [{ ...data.pull, number: 24 }];
          return data.comments.map(({ trusted: _trusted, ...comment }) => comment);
        },
      },
    },
  };
}

test("API integration posts status on PR head, reads its documents, and checks live collaborator permission", async () => {
  const run = apiFixture();
  await runQualityGate(run.args);
  assert.deepEqual(
    run.statuses.map((status) => status.state),
    ["pending", "success"],
  );
  assert.ok(run.statuses.every((status) => status.sha === sha && status.context === "PR quality"));
  assert.ok(run.reads.every((read) => read.ref === sha));
  assert.deepEqual(run.failures, []);
  const external = apiFixture({ permission: "read" });
  await runQualityGate(external.args);
  assert.equal(external.statuses.at(-1).state, "failure");
  assert.match(external.failures[0], /collaborator/);
});

test("deleted or stripped newest review cannot revive an older pass on later events", async () => {
  const history = [
    {
      context: "PR quality",
      description: "Review 2: review failed",
      creator: { login: "github-actions[bot]" },
    },
  ];
  for (const edit of ["deleted", "stripped"]) {
    const run = apiFixture({ history });
    if (edit === "stripped")
      run.data.comments.push({ id: 2, body: "review removed", user: { login: "maintainer" } });
    await runQualityGate(run.args);
    assert.equal(run.statuses.at(-1).state, "failure");
    assert.match(run.failures[0], /removed/);
    assert.match(run.statuses.at(-1).description, /^Review 2; revoked 2:/);
    const fresh = apiFixture({ history });
    fresh.data.comments[0].id = 3;
    await runQualityGate(fresh.args);
    assert.equal(fresh.statuses.at(-1).state, "success");
  }
});

test("deletion event records unseen attestation removal; unrelated commenters cannot revoke", async () => {
  for (const permission of ["write", "read"]) {
    const run = apiFixture({ permissions: { external: permission } });
    run.args.context.payload = {
      action: "deleted",
      issue: { number: 24 },
      comment: { ...run.data.comments[0], id: 2, user: { login: "external" } },
    };
    await runQualityGate(run.args);
    assert.equal(run.statuses.at(-1).state, permission === "write" ? "failure" : "success");
    assert.match(
      run.statuses.at(-1).description,
      permission === "write" ? /^Review 2; revoked 2:/ : /^Review 1; revoked 0:/,
    );
  }
});

test("edited event revokes an unseen stripped review; restoring its old block cannot pass", async () => {
  const run = apiFixture();
  const removed = { ...run.data.comments[0], id: 2, body: "Review block removed" };
  run.data.comments.push(removed);
  run.args.context.payload = {
    action: "edited",
    issue: { number: 24 },
    comment: removed,
    changes: { body: { from: block("pr-quality-review", { ...run.data.review, result: "fail" }) } },
  };
  await runQualityGate(run.args);
  assert.equal(run.statuses.at(-1).state, "failure");
  assert.match(run.statuses.at(-1).description, /^Review 2; revoked 2:/);

  const restored = apiFixture({
    history: [{ ...run.statuses.at(-1), creator: { login: "github-actions[bot]" } }],
  });
  restored.data.comments[0].id = 2;
  await runQualityGate(restored.args);
  assert.equal(restored.statuses.at(-1).state, "failure");
  assert.match(restored.failures[0], /removed/);
  restored.data.comments[0].id = 3;
  await runQualityGate(restored.args);
  assert.equal(restored.statuses.at(-1).state, "success");
});

test("a successful PR cannot lend its status to a different open PR with the same head", async () => {
  const run = apiFixture({
    openPulls: [
      { number: 24, head: { sha } },
      { number: 25, head: { sha } },
    ],
  });
  await runQualityGate(run.args);
  assert.equal(run.statuses.at(-1).state, "failure");
  assert.match(run.failures[0], /share this head SHA/);
  const unique = apiFixture({
    openPulls: [
      { number: 24, head: { sha } },
      { number: 25, head: { sha: "b".repeat(40) } },
    ],
  });
  await runQualityGate(unique.args);
  assert.equal(unique.statuses.at(-1).state, "success");
});

test("fails closed for incomplete diffs, unavailable API, or concurrent PR edits", async () => {
  for (const options of [
    { incompleteFiles: true },
    { readFailure: true },
    { changeDuringRun: true },
  ]) {
    const run = apiFixture(options);
    await runQualityGate(run.args);
    assert.deepEqual(
      run.statuses.map((status) => status.state),
      ["pending", "failure"],
    );
    assert.equal(run.failures.length, 1);
  }
});
