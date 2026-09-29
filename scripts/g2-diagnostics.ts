// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone host diagnostics CLI uses only Node APIs and plain console output.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

interface DiagnosticEvent {
  readonly event: string;
  readonly run: string;
  readonly time: string;
  readonly uptimeMs: number;
  readonly fields: Record<string, unknown>;
}

/** Reads complete records; a live export may end halfway through its final line. */
export function parseEvents(contents: string): DiagnosticEvent[] {
  const lines = contents.split("\n");
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1) return [];
      throw error;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Invalid G2 diagnostic record at line ${index + 1}`);
    }
    const fields = value as Record<string, unknown>;
    const { schema, event, run, time, uptimeMs } = fields;
    if (
      schema !== 1 ||
      typeof event !== "string" ||
      typeof run !== "string" ||
      typeof time !== "string" ||
      typeof uptimeMs !== "number"
    ) {
      throw new Error(`Unsupported G2 diagnostic record at line ${index + 1}`);
    }
    return [{ event, run, time, uptimeMs, fields }];
  });
}

/** Shows observed events and timing without treating absence of an event as a passed test. */
export function formatReport(events: readonly DiagnosticEvent[], since?: string): string {
  const cutoff = since === undefined ? undefined : Date.parse(since);
  if (cutoff !== undefined && !Number.isFinite(cutoff)) throw new Error("Invalid ISO start time");
  const latestRun = events.at(-1)?.run;
  const selected = events.filter((event) =>
    cutoff === undefined ? event.run === latestRun : Date.parse(event.time) >= cutoff,
  );
  if (!selected.length) return "No G2 events in requested window.";
  const lastTime = new Map<string, number>();
  const rows = selected.map(({ event, run, time, uptimeMs, fields }) => {
    const delta = Math.max(0, uptimeMs - (lastTime.get(run) ?? uptimeMs));
    lastTime.set(run, uptimeMs);
    const details = [
      "attempt",
      "kind",
      "source",
      "arm",
      "phase",
      "reason",
      "screen",
      "thread",
      "targetThread",
      "status",
      "sinceInputMs",
      "windowMs",
      "cancelled",
      "hasText",
      "reply",
      "page",
      "displayReply",
      "displayPage",
      "displayPicker",
      "written",
    ].flatMap((key) =>
      fields[key] === undefined ? [] : [`${key}=${JSON.stringify(fields[key])}`],
    );
    return `${time} +${delta.toFixed(1)}ms ${event} ${details.join(" ")}`;
  });
  return [
    `${selected.length} recorded events. Deltas are between logged events; inspect gesture.received for input timing.`,
    ...rows,
  ].join("\n");
}

/** Copies only G2 diagnostics from the paired phone; never restarts or changes its app. */
function main(args: string[]): void {
  const [command, first, second] = args;
  if (command === "pull" && first && second && args.length === 3) {
    const destination = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-g2-diagnostics-"));
    NodeChildProcess.execFileSync(
      "xcrun",
      [
        "devicectl",
        "device",
        "copy",
        "from",
        "--device",
        first,
        "--domain-type",
        "appDataContainer",
        "--domain-identifier",
        second,
        "--source",
        "Library/Application Support/EvenG2Diagnostics",
        "--destination",
        destination,
        "--timeout",
        "30",
      ],
      { stdio: "inherit" },
    );
    console.log(`Saved G2 logs: ${destination}`);
    console.log(
      `Read latest run: node scripts/g2-diagnostics.ts report ${JSON.stringify(destination)}`,
    );
    return;
  }
  if (command === "report" && first && args.length <= 3) {
    const events = ["previous.jsonl", "current.jsonl"].flatMap((name) => {
      const path = NodePath.join(first, name);
      return NodeFS.existsSync(path) ? parseEvents(NodeFS.readFileSync(path, "utf8")) : [];
    });
    console.log(formatReport(events, second));
    return;
  }
  throw new Error(
    "Usage: g2-diagnostics.ts pull <device> <bundle-id> | report <directory> [since-ISO-time]",
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
