# Even G2 native builds and diagnostics

Use this runbook for the fork's iOS integration. User-facing setup and gestures live in
[Even G2 glasses and R1 ring](../user/even-g2.md).

## Build prerequisites

Use this fork's G2 checkout, including `apps/mobile/modules/t3-even-g2`, its mobile bridge,
and `scripts/g2-diagnostics.ts`.

Use a physical iPhone on iOS 26 or later for Bluetooth and microphone checks. Expo Go cannot
load the module; a simulator cannot validate glasses hardware. Native changes require rebuilding
and reinstalling the app. JavaScript refresh alone cannot update the driver.

Follow [mobile development](../../apps/mobile/README.md#development) for dependencies, native
client setup, and signing. For a local Personal Team build, connect and trust your iPhone, then
run from `apps/mobile` with a bundle identifier you control:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.g2 \
vp run ios:dev -- --device
```

For a self-contained Release build without Metro, use the same environment variables with
`vp run ios:release -- --device`. Personal Team builds omit unsupported extensions and
entitlements; see the mobile README. Quit the Even app before connecting G2 through T3.

## Current local iPhone deployment

Verified on 2026-09-29 in `/Users/mt/src/even-g2`. This setup builds a self-contained **Release**
binary using the **development app identity** (`T3 Code Dev`). Keep `APP_VARIANT=development`
when updating this installation; the generic `ios:release` script above regenerates a production
variant instead. Release configuration embeds JavaScript and does not need a Metro server.

| Setting                  | Verified value                                        |
| ------------------------ | ----------------------------------------------------- |
| Physical iPhone          | `deadbeef7`, iPhone 17 Pro                            |
| Device UDID              | `00008150-00112CC60EF2401C`                           |
| Installed bundle ID      | `net.mich431.t3code.g2.mappe`                         |
| Personal Team            | `PP97C35JA7`                                          |
| Workspace / scheme       | `apps/mobile/ios/T3CodeDev.xcworkspace` / `T3CodeDev` |
| Reusable build directory | `/private/tmp/even-g2-release-20260929`               |

Run from the repository root. Confirm the physical device and installed identity before deploying;
the paired iPad and simulators are separate targets:

```bash
xcrun devicectl list devices
xcrun devicectl device info apps \
  --device 00008150-00112CC60EF2401C \
  --filter 'bundleIdentifier CONTAINS "t3"'
```

For native source changes with the existing generated workspace and Pods, rebuild directly:

```bash
APP_VARIANT=development \
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=net.mich431.t3code.g2.mappe \
xcodebuild \
  -workspace apps/mobile/ios/T3CodeDev.xcworkspace \
  -scheme T3CodeDev \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /private/tmp/even-g2-release-20260929 \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM=PP97C35JA7 \
  CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY='Apple Development' \
  build > /private/tmp/even-g2-iphone-build.log 2>&1
```

Require exit code zero and `BUILD SUCCEEDED` in the log before installing. Confirm the output
`T3CodeDev.app` contains `main.jsbundle`. Install over the existing app without uninstalling it
to retain its data, then launch:

```bash
xcrun devicectl device install app \
  --device 00008150-00112CC60EF2401C \
  /private/tmp/even-g2-release-20260929/Build/Products/Release-iphoneos/T3CodeDev.app
xcrun devicectl device process launch \
  --device 00008150-00112CC60EF2401C net.mich431.t3code.g2.mappe
```

Run launch only after install succeeds. Successful installation and launch confirm deployment,
not G2/R1 behavior; use the hardware checks below for that.

### Reusing or repairing the local setup

- `apps/mobile/ios` is generated and untracked. Native source-only edits do not require a clean
  prebuild. If it is missing or app configuration changes, regenerate using the mobile README's
  setup with the three environment variables above, then build with the same signing overrides.
  Inspect local native edits before running `expo prebuild --clean`.
- After native dependency or patch changes, rerun CocoaPods as described in the mobile README.
  Existing Pods may otherwise reference an old pnpm package path.
- Check `apps/mobile/ios/.xcode.env.local` if the build cannot find Node. This setup used
  `/opt/homebrew/Cellar/node/26.8.2/bin/node`; Homebrew upgrades can invalidate that path.
- The `/private/tmp` build directory is a disposable cache, not a required artifact. Xcode can
  recreate it. If choosing another path, update both build and install commands.
- If `vp` is absent from `PATH`, use `node_modules/.bin/vp` from the repository root. Avoid
  reinstalling dependencies merely to locate the existing runner.
- A sandboxed `devicectl` call timed out waiting for `CoreDeviceService`; the same command worked
  with access outside the sandbox. Request that access if needed. Signing also needs access to
  the local Xcode account and provisioning services. Personal Team provisioning expires after
  seven days; rebuild/reinstall when needed.

## Focused checks

From `apps/mobile`, run protocol/codec and simulated connection checks:

```bash
vp run test:g2-native
vp run test:g2-connection
```

From the repository root, isolate the relevant connection group or bridge tests:

```bash
bash apps/mobile/modules/t3-even-g2/tests/connection-smoke.sh --startup-input
bash apps/mobile/modules/t3-even-g2/tests/connection-smoke.sh --sending
bash apps/mobile/modules/t3-even-g2/tests/connection-smoke.sh --history
vp test run apps/mobile/src/features/even-g2/useEvenG2ThreadBridge.test.ts apps/mobile/src/features/even-g2/evenG2ThreadBridge.logic.test.ts apps/mobile/src/features/even-g2/evenG2HistoryBridge.test.ts
vp test run scripts/g2-diagnostics.test.ts
```

These checks exercise code with simulated Bluetooth callbacks. They do not prove behavior on
physical G2/R1 firmware. Report that distinction in issues and PRs.

## Export diagnostics

The native app retains diagnostics across launches, including Release builds without Metro.
Logs include timestamps, gesture source, thread IDs, state, and accept/ignore decisions. They
omit speech and reply text. Export soon after a failure because two rotating segments retain
about 1 MiB in total.

From the repository root, download logs from a paired iPhone without restarting T3:

```bash
node scripts/g2-diagnostics.ts pull <device-id> <installed-bundle-id>
node scripts/g2-diagnostics.ts report <download-directory>
```

The pull command prints its download directory. Reports default to the latest connection run;
add an ISO start time as the final argument to include earlier runs. `gesture.received` shows
what reached the driver, including `leftTemple` for left-arm Back; `gesture.ignored` explains
rejected input. Reply/page IDs correlate with `display.scheduled` and `display.write-completed`.
A completed Bluetooth write is not proof that a frame appeared on the glasses. Include what
you saw alongside the logs, and redact identifying metadata before sharing.

## Hardware verification

Record the native build commit, iOS/G2/R1 firmware, input source, Natural scrolling setting, and
whether the phone is locked. Use a dedicated thread for sends and another with several replies.

1. Open a thread through the picker, then through the phone. Both should select its latest reply.
2. Read older pages; phone scrolling should remain independent. Reverse swipe direction without
   triggering Back. Repeat with Natural scrolling off.
3. Dictate through R1/right-arm taps. Swipes during Preparing or Listening must not cancel.
   Left-arm tap must cancel; long-press must not act as Back. Send a transcript longer than a
   lens page and confirm its beginning and end arrive once, in the originating thread.
4. Delay a reply. Confirm Sending becomes Thinking when work starts. Swipe up returns to replies;
   left-arm tap opens the picker. Changing thread must not stop the submitted work. Repeat with
   Natural scrolling off; physical swipe up still leaves the waiting screen.
5. Trigger a display exit or Bluetooth interruption during speech. Confirm words remain unsent
   in the phone draft. Explicit cancellation should preserve only the pre-existing draft.
6. Check **Latest output**, reconnect, locked-phone dictation, and two consecutive sends.
   Report untested combinations explicitly rather than inferring success from connection status.
