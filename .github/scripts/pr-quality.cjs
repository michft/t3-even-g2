const { createHash } = require("node:crypto");

const STATUS_CONTEXT = "PR quality";

function parseBlock(body, name) {
  const blocks = [
    ...(body ?? "").matchAll(
      new RegExp(`^\x60\x60\x60${name}\\r?\\n([\\s\\S]*?)^\x60\x60\x60[ \\t]*\\r?$`, "gm"),
    ),
  ];
  if (blocks.length !== 1) throw new Error(`Exactly one ${name} JSON block is required.`);
  try {
    const value = JSON.parse(blocks[0][1]);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw new Error(`${name} must contain a JSON object.`);
  }
}

function requireText(value, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /<[^>]+>|\b(?:TODO|TBD)\b|^\.\.\.$/i.test(value)
  ) {
    throw new Error(`${label} needs completed evidence, not a placeholder.`);
  }
}

function bodyDigest(body) {
  return createHash("sha256")
    .update((body ?? "").replace(/\r\n/g, "\n").trim())
    .digest("hex");
}

function assessDocumentation(assessment, label, files, matchesPath) {
  if (!assessment || !["updated", "not-needed"].includes(assessment.status)) {
    throw new Error(`${label} status must be updated or not-needed.`);
  }
  requireText(assessment.reason, `${label} reason`);
  if (!Array.isArray(assessment.files)) throw new Error(`${label} files must be an array.`);
  if (assessment.status === "not-needed") {
    if (assessment.files.length) throw new Error(`${label} not-needed must have no files.`);
    return;
  }
  if (
    !assessment.files.length ||
    assessment.files.some(
      (path) =>
        typeof path !== "string" ||
        !matchesPath(path) ||
        !files.some((file) => file.filename === path && file.status !== "removed"),
    )
  ) {
    throw new Error(`${label} updated must name matching files changed in this PR.`);
  }
}

function latestReview(comments) {
  return comments
    .filter((item) => item.trusted && /^```pr-quality-review\r?$/m.test(item.body ?? ""))
    .sort(
      (left, right) =>
        right.id - left.id || Number(right.deleted ?? false) - Number(left.deleted ?? false),
    )[0];
}

function evaluateQuality({
  pull,
  files,
  documents,
  comments,
  lastReviewId = 0,
  revokedReviewId = 0,
}) {
  for (const path of ["README.md", "CHANGELOG.md"]) {
    if (!documents[path]) throw new Error(`${path} must exist as a nonempty file at the PR head.`);
  }
  const evidence = parseBlock(pull.body, "pr-quality");
  for (const field of ["author_agent", "validation", "design", "regression"]) {
    requireText(evidence[field], field);
  }
  assessDocumentation(evidence.readme, "README", files, (path) => /(^|\/)README\.md$/.test(path));
  assessDocumentation(evidence.changelog, "Changelog", files, (path) => path === "CHANGELOG.md");

  // Review is an authenticated maintainer attestation, not an author checkbox.
  // Same GitHub account may operate two agents; their execution IDs must differ.
  const comment = latestReview(comments);
  if (!comment)
    throw new Error("A collaborator must attest the independent agent review in a PR comment.");
  if (comment.deleted || comment.id < lastReviewId || comment.id <= revokedReviewId) {
    throw new Error("Latest review evidence was removed; post a fresh independent review.");
  }
  const review = parseBlock(comment.body, "pr-quality-review");
  if (review.head_sha !== pull.head.sha || review.body_sha256 !== bodyDigest(pull.body)) {
    throw new Error("Independent review is stale: review the current head and PR description.");
  }
  for (const field of ["reviewer_agent", "model", "harness", "findings"])
    requireText(review[field], field);
  if (review.reviewer_agent.trim() === evidence.author_agent.trim()) {
    throw new Error("Reviewer must be a different agent execution from the author.");
  }
  if (review.result !== "pass")
    throw new Error("Independent review must pass with no unresolved findings.");
  return `Documentation, scope and independent review verified (${comment.user.login}).`;
}

async function runQualityGate({ github, context, core, pullNumber }) {
  const repo = context.repo;
  const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: pullNumber });
  if (pull.state !== "open") return;
  let lastReviewId = 0;
  let revokedReviewId = 0;
  const status = (state, description) =>
    github.rest.repos.createCommitStatus({
      ...repo,
      sha: pull.head.sha,
      context: STATUS_CONTEXT,
      state,
      description: `Review ${lastReviewId}; revoked ${revokedReviewId}: ${description}`.slice(
        0,
        140,
      ),
      target_url: `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`,
    });
  await status("pending", "Checking current PR quality evidence.");
  try {
    // Remember the newest observed attestation in GitHub's own status history.
    // Removing or editing it must not revive an older pass on the same head.
    const history = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
      ...repo,
      ref: pull.head.sha,
      per_page: 100,
    });
    for (const previous of history) {
      if (previous.context !== STATUS_CONTEXT || previous.creator?.login !== "github-actions[bot]")
        continue;
      const record = /^Review (\d+)(?:; revoked (\d+))?:/.exec(previous.description ?? "");
      lastReviewId = Math.max(lastReviewId, Number(record?.[1] ?? 0));
      revokedReviewId = Math.max(revokedReviewId, Number(record?.[2] ?? 0));
    }
    const [files, comments, documentEntries] = await Promise.all([
      github.paginate(github.rest.pulls.listFiles, {
        ...repo,
        pull_number: pullNumber,
        per_page: 100,
      }),
      github.paginate(github.rest.issues.listComments, {
        ...repo,
        issue_number: pullNumber,
        per_page: 100,
      }),
      Promise.all(
        ["README.md", "CHANGELOG.md"].map(async (path) => {
          try {
            const { data } = await github.rest.repos.getContent({
              ...repo,
              path,
              ref: pull.head.sha,
            });
            return [path, data.type === "file" && data.size > 0];
          } catch (error) {
            if (error.status === 404) return [path, false];
            throw error;
          }
        }),
      ),
    ]);
    const event = context.payload;
    const previousBody = event?.changes?.body?.from;
    const strippedReview =
      event?.action === "edited" &&
      /^```pr-quality-review\r?$/m.test(previousBody ?? "") &&
      !/^```pr-quality-review\r?$/m.test(event.comment?.body ?? "");
    if (
      event?.issue?.number === pullNumber &&
      event.comment &&
      (event.action === "deleted" || strippedReview)
    ) {
      comments.push({
        ...event.comment,
        body: strippedReview ? previousBody : event.comment.body,
        deleted: true,
      });
    }
    // GitHub's changed-files endpoint caps results at 3,000. Never silently
    // accept incomplete diffs (including large Nightly integrations).
    if (files.length !== pull.changed_files)
      throw new Error("Incomplete changed-file list; quality gate cannot verify this PR.");
    const permissions = new Map();
    for (const comment of comments) {
      if (!/^```pr-quality-review\r?$/m.test(comment.body ?? "")) continue;
      const username = comment.user.login;
      if (!permissions.has(username)) {
        try {
          const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
            ...repo,
            username,
          });
          permissions.set(username, ["admin", "maintain", "write"].includes(data.permission));
        } catch (error) {
          if (error.status !== 404) throw error;
          permissions.set(username, false);
        }
      }
      comment.trusted = permissions.get(username);
    }
    const newestReview = latestReview(comments);
    if (newestReview?.deleted || (lastReviewId && (newestReview?.id ?? 0) < lastReviewId)) {
      revokedReviewId = Math.max(revokedReviewId, lastReviewId, newestReview?.id ?? 0);
    }
    lastReviewId = Math.max(lastReviewId, newestReview?.id ?? 0);
    const description = evaluateQuality({
      pull,
      files,
      documents: Object.fromEntries(documentEntries),
      comments,
      lastReviewId,
      revokedReviewId,
    });
    const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: pullNumber });
    if (current.head.sha !== pull.head.sha || bodyDigest(current.body) !== bodyDigest(pull.body)) {
      throw new Error("PR changed during evaluation; rerun PR quality.");
    }
    // Statuses belong to commits, not PRs. A shared head could otherwise borrow
    // another PR's passing description/review evidence. Require unique heads.
    const openPulls = await github.paginate(github.rest.pulls.list, {
      ...repo,
      state: "open",
      per_page: 100,
    });
    if (openPulls.some((item) => item.number !== pullNumber && item.head.sha === pull.head.sha)) {
      throw new Error("Multiple open PRs share this head SHA; use a unique commit before review.");
    }
    await status("success", description);
    core.info(description);
  } catch (error) {
    await status("failure", error.message);
    core.setFailed(error.message);
  }
}

module.exports = { bodyDigest, evaluateQuality, runQualityGate, STATUS_CONTEXT };

if (require.main === module) {
  const { readFileSync } = require("node:fs");
  const pull = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(
    JSON.stringify({ head_sha: pull.headRefOid, body_sha256: bodyDigest(pull.body) }, null, 2) +
      "\n",
  );
}
