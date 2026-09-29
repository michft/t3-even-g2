import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";
import { formatReport, parseEvents } from "./g2-diagnostics.ts";

function line(event: string, uptimeMs: number, run = "one", extra: Record<string, unknown> = {}) {
  return (
    JSON.stringify({
      schema: 1,
      event,
      run,
      time: `2026-09-29T04:20:00.000Z`,
      uptimeMs,
      ...extra,
    }) + "\n"
  );
}

test("reports ignored gestures and their timing, including fractional milliseconds", () => {
  const events = parseEvents(
    line("tap.accepted", 100) +
      line("gesture.received", 175.5, "one", { kind: "scrollUp", phase: "tap-feedback" }) +
      line("gesture.ignored", 176, "one", { reason: "swipe-debounce" }),
  );
  const report = formatReport(events);
  NodeAssert.match(report, /\+75\.5ms gesture.received/);
  NodeAssert.match(report, /phase="tap-feedback"/);
  NodeAssert.match(report, /reason="swipe-debounce"/);
});

test("handles a live export's partial last line but rejects corrupt complete records", () => {
  NodeAssert.equal(parseEvents(line("swipe.matched", 200) + '{"event":').length, 1);
  NodeAssert.throws(() => parseEvents('{"event":\n'));
  NodeAssert.throws(() => parseEvents('{"schema":2}\n'));
});

test("defaults to latest launch and supports an explicit cross-launch time window", () => {
  const events = parseEvents(line("old", 100) + line("new", 200, "two"));
  NodeAssert.doesNotMatch(formatReport(events), /ms old/);
  NodeAssert.match(formatReport(events), /ms new/);
  NodeAssert.match(formatReport(events, "2026-09-29T04:00:00Z"), /ms old/);
  NodeAssert.match(formatReport(events, "2026-09-29T05:00:00Z"), /No G2 events/);
  NodeAssert.throws(() => formatReport(events, "invalid"));
});
