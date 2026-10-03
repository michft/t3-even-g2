# Even G2 native builds and diagnostics

Use this runbook for the fork's iOS integration. User-facing setup and gestures
live in [Even G2 glasses and R1 ring](../user/even-g2.md).

## Build prerequisites

Use this fork's G2 checkout, including `apps/mobile/modules/t3-even-g2`, its
mobile bridge, and `scripts/g2-diagnostics.ts`.

Use a physical iPhone on iOS 26 or later for Bluetooth and microphone checks.
Expo Go cannot load the module; a simulator cannot validate glasses hardware.
Native changes require rebuilding and reinstalling the app. JavaScript refresh
alone cannot update the driver.

Follow [mobile development](../../apps/mobile/README.md#development) for
dependencies, native client setup, and signing. For a local Personal Team build,
connect and trust your iPhone, then run from `apps/mobile` with a bundle
identifier you control:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.g2 \
vp run ios:dev -- --device
```

For a self-contained Release build without Metro, use the same environment
variables with `vp run ios:release -- --device`. Personal Team builds omit
unsupported extensions and entitlements; see the mobile README. Quit the Even
app before connecting G2 through T3.

## Release build example

Match the mobile app's orchestration protocol to the environment host. A V1
mobile app cannot connect to an Orchestrator V2 server, and a V2 mobile app
cannot connect to a V1 server. After merging a published T3 Nightly that changes
the protocol, rebuild and reinstall the G2 app before checking its connections.
See the Nightly release notes for host and client compatibility requirements.
Keep the installed bundle ID when updating so saved connections and app data
remain associated with the same installation.

From `apps/mobile`, build a self-contained app with a bundle identifier you
control. Connect and trust the target iPhone first:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.g2 \
vp run ios:release -- --device
```

This script uses the production app variant. If updating an existing
`T3 Code Dev` installation, keep that installation's development identity and
bundle ID, and use Release configuration in its generated Xcode workspace.
Changing app identity creates a different installation. Install over the
existing app rather than uninstalling it when preserving its data.

A Release app embeds JavaScript and needs no Metro server. It still connects
to a T3 environment for live threads and agent work. A successful build and
launch do not verify physical G2/R1 behavior; run the hardware checks below.

## Reusing the native setup

- Native source-only edits can rebuild an existing Xcode workspace. Inspect
  local generated-project changes before running a clean Expo prebuild.
- After native dependency or patch changes, rerun CocoaPods as described in the
  mobile README; old Pods may still reference a previous pnpm package path.
- If Xcode cannot find Node, check `apps/mobile/ios/.xcode.env.local` for a stale
  executable path after a Node upgrade.
- If `vp` is absent from `PATH`, use `node_modules/.bin/vp` from the repository
  root instead of reinstalling dependencies just to find the runner.
- Substitute your own device ID, signing team, bundle ID, and build directory
  in the public deployment examples below.

## Rebuild and deploy an existing development-identity app

Use this example when updating an existing `T3 Code Dev` installation with a
self-contained Release binary. It assumes `apps/mobile/ios/T3CodeDev.xcworkspace`
and its Pods were generated for the development variant using the mobile setup
guide. If they are missing, generate them with `APP_VARIANT=development` and
the same Personal Team bundle identifier before building. Do not use the
production-variant `ios:release` script to update a development identity.

Run from the repository root. First identify the connected phone and its
installed app; the simulator and any paired iPad are different targets:

```bash
xcrun devicectl list devices
xcrun devicectl device info apps --device <device-id>
```

Replace these placeholders with the confirmed device, installed bundle ID, and
your Xcode signing team. Keep the same shell for the remaining commands:

```bash
G2_DEVICE_ID='YOUR-IPHONE-DEVICE-ID'
G2_BUNDLE_ID='com.example.t3code.g2'
G2_TEAM_ID='YOUR-APPLE-TEAM-ID'
G2_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t3-even-g2-release.XXXXXX")"

APP_VARIANT=development \
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID="$G2_BUNDLE_ID" \
xcodebuild \
  -workspace apps/mobile/ios/T3CodeDev.xcworkspace \
  -scheme T3CodeDev \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$G2_BUILD_DIR" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$G2_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY='Apple Development' \
  build
```

Require exit code zero and `BUILD SUCCEEDED` before installing. Confirm the
output contains embedded JavaScript, then install over the existing app:

```bash
G2_APP="$G2_BUILD_DIR/Build/Products/Release-iphoneos/T3CodeDev.app"
test -f "$G2_APP/main.jsbundle" &&
  xcrun devicectl device install app --device "$G2_DEVICE_ID" "$G2_APP"
```

Only after installation succeeds, launch the installed app:

```bash
xcrun devicectl device process launch --device "$G2_DEVICE_ID" "$G2_BUNDLE_ID"
```

If device discovery or installation fails, check pairing, trust, connection,
and local access to CoreDevice services. Signing requires the selected Xcode
account and provisioning access. Report deployment failures separately from
glasses behavior; do not treat an old installed app as the new build.

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
vp test run \
  apps/mobile/src/features/even-g2/useEvenG2ThreadBridge.test.ts \
  apps/mobile/src/features/even-g2/evenG2ThreadBridge.logic.test.ts \
  apps/mobile/src/features/even-g2/evenG2HistoryBridge.test.ts
vp test run scripts/g2-diagnostics.test.ts
```

These checks exercise code with simulated Bluetooth callbacks. They do not prove
behavior on physical G2/R1 firmware. Report that distinction in issues and PRs.

## Export diagnostics

The native app retains diagnostics across launches, including Release builds
without Metro. Logs include timestamps, gesture source, thread IDs, state, and
accept/ignore decisions. They omit speech and reply text. Export soon after a
failure because two rotating segments retain about 1 MiB in total.

From the repository root, download logs from a paired iPhone without restarting
T3:

```bash
node scripts/g2-diagnostics.ts pull <device-id> <installed-bundle-id>
node scripts/g2-diagnostics.ts report <download-directory>
```

The pull command prints its download directory. Reports default to the latest
connection run; add an ISO start time as the final argument to include earlier
runs. `gesture.received` shows what reached the driver, including `leftTemple`
for left-arm Back; `gesture.ignored` explains rejected input. Reply/page IDs
correlate with `display.scheduled` and `display.write-completed`. A completed
Bluetooth write is not proof that a frame appeared on the glasses. Include what
you saw alongside the logs, and redact identifying metadata before sharing.

## Hardware verification

Record the native build commit, iOS/G2/R1 firmware, input source, Natural
scrolling setting, and whether the phone is locked. Use a dedicated thread for
sends and another with several replies.

1. Open a thread through the picker, then through the phone. Both should select
   its latest reply.
2. Read older pages; phone scrolling should remain independent. Reverse swipe
   direction without triggering Back. Repeat with Natural scrolling off.
3. Dictate through R1 taps. Swipes during Preparing or Listening must
   not cancel. Left-arm tap must cancel; long-press must not act as Back. Send a
   transcript longer than a lens page and confirm its beginning and end arrive
   once, in the originating thread.
4. Delay a reply. Confirm Sending becomes Thinking when work starts. Swipe up
   returns to replies; left-arm tap opens the picker. Changing thread must not
   stop the submitted work. Repeat with Natural scrolling off; physical swipe up
   still leaves the waiting screen.
5. Trigger a display exit or Bluetooth interruption during speech. Confirm words
   remain unsent in the phone draft. Explicit cancellation should preserve only
   the pre-existing draft.
6. Check **Latest output**, reconnect, locked-phone dictation, and two
   consecutive sends. Report untested combinations explicitly rather than
   inferring success from connection status.

## Detailed hardware regression checks

The display now blanks after 15 seconds, including during dictation. During
these checks, wake with one tap before testing the next action if it has timed
out. Speech capture continues while blank. Verify wake-only taps separately on
each arm and R1.

Use a new thread reserved for send tests and a thread with several multi-page
replies for history. Record the T3 build, iOS version, glasses/R1 firmware, and
Natural scrolling setting. Run one check at a time. Changes to this native
driver require an updated native app.

1. Open a thread on the phone. Confirm glasses open its latest reply at page
   one.
2. Swipe through a long reply. Confirm pages move while the phone can stay at
   the live bottom.
3. Reverse swipe direction. Confirm no Back action or thread-picker jump occurs.
4. Tap R1, then immediately swipe up→down. Listening should continue; nothing
   should send.
5. Repeat up→down during Preparing, then during Listening, as separate attempts.
6. Dictate more than one screen of text. The newest line should remain visible
   at the bottom.
7. Keep dictating across several screenfuls. Send once and verify the full text,
   including its start.
8. Dictate line breaks and a long uninterrupted phrase. Confirm the latest words
   remain visible.
9. Type an unsent phone draft, then dictate and send. Typed text should remain;
   dictated text sends once.
10. Dictate a distinctive phrase, then double-tap to trigger a display exit.
    Confirm no send occurs and recognized words remain in the originating phone
    draft after recovery.
11. With recognized words still unsent, disconnect/reconnect the glasses. Verify
    the draft survives.
12. After interruption, start another dictation. New words should append after
    the retained draft, without duplicating the older words. Explicitly
    review/send retained text from the phone.
13. Tap the left G2 arm to cancel dictation, dismiss an error, open the picker
    from a reply or waiting screen, and return from the picker. R1 taps still
    open, dictate, and send.
    Right-arm taps select in the picker or jump to the current thread's latest
    reply; they do nothing during dictation. Long-press must not trigger Back.
    Confirm logs identify the left tap as `leftTemple`.
14. From an older reply, tap the left G2 arm to reach the picker, then tap
    **Latest output**. Confirm newest reply, page one. Open another thread and
    confirm its latest reply too.
15. Send while a reply is delayed. Confirm Sending changes to Thinking when work
    starts; swipe up returns to replies, then Back opens the picker. Repeat with
    Natural scrolling off. Reading and dictation swipes must never cancel or go
    Back.
16. Select a thread, lock the phone, then dictate/send twice. Verify each
    message reaches that thread once.
17. Power-cycle the glasses. Confirm recovery and two consecutive dictations. If
    needed, separately test **Settings → Even G2 → Resume T3 display**.

For each failure, record
`step | input device | starting screen/reply/page | exact gesture order |
approximate gaps | expected | actual | recovery needed`.
Capture whether Listening remained on, whether any message sent, and whether one
or both displays changed. Download native logs after the attempt and include
gesture `kind` and `source`: system events distinguish `ring`, `rightTemple`,
and `leftTemple`; container events may only identify `textContainer` or
`listContainer`.

Head nods/tilts are not acceptance inputs yet: this direct driver does not
enable or decode IMU motion data. Test them separately only after motion support
is implemented.

`display.request` records dictation screen requests. Capture screenshots or
observations alongside diagnostics; successful Bluetooth writes alone do not
confirm visible output.
