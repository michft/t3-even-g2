# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

For simulator/emulator development, select and boot a device, then ensure its native client matches
this checkout before starting Metro:

```bash
node ../../scripts/mobile-native-client.ts ensure ios <simulator-udid>
# Or: node ../../scripts/mobile-native-client.ts ensure android <emulator-serial>
vp run dev:client
```

The helper compares a local Expo fingerprint and the installed binary with its last successful
build record. It builds and installs missing, stale, or unverified clients and reuses matching ones.
Use `check` instead of `ensure` for a read-only decision: exit 0 means compatible, 2 means a build is
needed, and 1 means an operational error. Run it on the simulator host; no EAS login is required.
An externally installed client is unverified until the helper builds it once.

Start Metro for an already verified dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

### Even G2 + R1 direct mode

The iOS 26 build can connect directly to both Even G2 arms. It uses the G2 microphone for
on-device dictation, the R1 ring for start/send/cancel gestures, and the G2 display for assistant
reply history. This is an experimental, unofficial protocol integration and may need updates
after glasses firmware changes.

Before connecting, quit the Even app so it releases the glasses. Disconnect G2 from T3 and quit
Even on any other phone or tablet using the glasses. In T3 Code, open Settings and tap
**G2 + R1**. On the glasses, swipe R1 up/down to choose a thread and tap to open it in T3. The picker
shows non-archived threads in recent-activity order, with their environment and project labels.
You can also open a thread directly on the iPhone. Opening or reopening a thread starts at its
latest reply on the glasses. R1 pages through glasses output independently of the phone's scroll
position; the phone can remain at the live bottom while you read older replies on the glasses.
Once a thread is open, tap R1 to start dictation and tap again to send. Recognized words scroll
on the glasses so the newest line stays at the bottom; the complete transcript is retained for
sending. After sending, the glasses show **Sending to T3 Code…**, then **Thinking…** when the
phone reports work underway. While waiting, swipe up to return to the current thread's replies,
or hold Back to open the thread picker. These actions leave the submitted message running.
Offline, approval, and input waits point to the connection or phone instead of claiming the agent
is thinking. Swipe up leaves the waiting screen regardless of the Natural scrolling setting.
Swipes scroll while reading. Up→down is no longer a Back or Cancel gesture anywhere,
and swipes do nothing during dictation. Starting dictation has no tap-confirmation screen.

Hold (long-press) goes Back when the glasses firmware delivers that event. During dictation it
explicitly cancels; from thread output it opens the picker; from the picker it restores the last
open thread. Error notices return to the current reply and reading position.
Tap-then-hold remains the firmware menu gesture.
In **Settings → Even G2**, **Natural scrolling** makes swipe up advance through content; turn it
off for swipe down to advance instead. While idle, double-tap also returns to the thread picker.
Scroll backward through a reply to reach the previous reply's last page; scroll forward to read
newer replies. Each reply includes a short prompt label and a reply/page position. Older replies load
as you reach the edge of available history. If loading is unavailable, keep reading cached output or
swipe again to retry. Reading older output does not change which thread receives dictation.

New text preserves your reading position. New replies appear automatically while you are on the
first page of the latest reply; while you are reading older output or dictating, a new-reply marker
appears instead. Back opens the thread picker with **Latest output** highlighted; tap to jump to
the newest reply. Older replies show **Back,tap: Latest** as a reminder. The picker labels this
as a quick action, separate from its thread count. Back again returns to the previous reading
position; explicitly opening a thread starts at latest. Cached output remains available during
this app session, including while the phone is locked; uncached
history needs a live environment connection. Restarting T3 requires loading the thread again.

If a double-tap returns the glasses to
Even, T3 automatically restores its display.
Dictation stays stopped until you tap again. Display exits and Bluetooth interruptions keep already
recognized words in the originating phone draft without sending them; explicit cancellation discards
only the current dictation. Review the retained draft before sending it from the phone.
If recovery fails, tap R1 to retry or use **Settings → Even G2 → Resume T3 display**.
To leave T3 on purpose, disconnect **G2 + R1** in Settings.
Existing typed composer text is preserved.

Select the desired thread before locking the iPhone. Bluetooth background delivery is enabled,
and T3 remembers both arms for reconnection after sleep or loss of range. Force-quitting T3 stops
this session; reopen T3 and its thread before using R1 again. Locked-phone dictation and automatic
display recovery require verification on your glasses firmware; a Bluetooth connection alone does
not confirm the glasses are still delivering taps or microphone audio.

A paid Apple Developer Program membership is not required for local testing on your own iPhone.
Add your Apple Account to Xcode, connect and trust the iPhone, enable Developer Mode when prompted,
then use the Personal Team build with a bundle identifier you control:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.g2 \
pnpm run ios:dev -- --device
```

Free Personal Team provisioning expires after seven days, so Xcode must rebuild/reinstall the app
periodically. Expo Go cannot load this native G2 module. A physical iPhone is required for G2 BLE
testing; the iOS Simulator can only exercise the non-hardware UI.

Run `vp run test:g2-native` for protocol/codec checks and `vp run test:g2-connection` for the
native driver's recovery and repeated-dictation checks with simulated Bluetooth callbacks.

G2 gesture diagnostics persist inside the native app, including Release builds. No Metro server
or attached console is required. Logs contain timestamps, input source, thread IDs, state, and
accept/ignore decisions; they omit speech and reply text. Two rotating segments retain at most
about 1 MiB. Export soon after a failed attempt; older events eventually rotate out.

From the repo root, download a paired iPhone's logs without restarting the app:

```bash
node scripts/g2-diagnostics.ts pull <device-id> <installed-bundle-id>
node scripts/g2-diagnostics.ts report <download-directory>
```

The download command prints its directory. Reports default to the latest app connection run;
add an ISO start time as the last argument to include earlier runs. `gesture.received` records
show what reached the driver; `gesture.ignored` and dictation transitions explain its decisions. Reply/page IDs correlate navigation with
`display.scheduled` and `display.write-completed`. A successful write means the Bluetooth transport
accepted the payload, not confirmation that the user saw it. `display.request` records dictation
screen requests. Keep screenshots/observations alongside these records.

Focused test commands (repo root):

```bash
bash apps/mobile/modules/t3-even-g2/tests/connection-smoke.sh --startup-input
bash apps/mobile/modules/t3-even-g2/tests/connection-smoke.sh --diagnostics
bash apps/mobile/modules/t3-even-g2/tests/connection-smoke.sh --sending
node --test scripts/g2-diagnostics.test.ts
```

The connection suite covers startup swipes, explicit Back, long transcript display, interruption
retention, full-text sending, diagnostic persistence, rotation, and report parsing.

Hardware test/debug run:

Use a new thread reserved for send tests and a thread with several multi-page replies for history.
Record the T3 build, iOS version, glasses/R1 firmware, and Natural scrolling setting. Run one check
at a time. Changes to this native driver require an updated native app.

1. Open a thread on the phone. Confirm glasses open its latest reply at page one.
2. Swipe through a long reply. Confirm pages move while the phone can stay at the live bottom.
3. Reverse swipe direction. Confirm no Back action or thread-picker jump occurs.
4. Tap R1, then immediately swipe up→down. Listening should continue; nothing should send.
5. Repeat up→down during Preparing, then during Listening, as separate attempts.
6. Dictate more than one screen of text. The newest line should remain visible at the bottom.
7. Keep dictating across several screenfuls. Send once and verify the full text, including its start.
8. Dictate line breaks and a long uninterrupted phrase. Confirm the latest words remain visible.
9. Type an unsent phone draft, then dictate and send. Typed text should remain; dictated text sends once.
10. Dictate a distinctive phrase, then double-tap to trigger a display exit. Confirm no send occurs
    and recognized words remain in the originating phone draft after recovery.
11. With recognized words still unsent, disconnect/reconnect the glasses. Verify the draft survives.
12. After interruption, start another dictation. New words should append after the retained draft,
    without duplicating the older words. Explicitly review/send retained text from the phone.
13. Test long-press separately. If firmware reports it, it should cancel active dictation or go Back.
    Record missing long-press events rather than substituting an up→down gesture.
14. From an older reply, use supported Back to reach the picker, then tap **Latest output**.
    Confirm newest reply, page one. Open another thread and confirm its latest reply too.
15. Send while a reply is delayed. Confirm Sending changes to Thinking when work starts;
    swipe up returns to replies, then Back opens the picker. Repeat with Natural scrolling off.
    Reading and dictation swipes must never cancel or go Back.
16. Select a thread, lock the phone, then dictate/send twice. Verify each message reaches that thread once.
17. Power-cycle the glasses. Confirm recovery and two consecutive dictations. If needed, separately
    test **Settings → Even G2 → Resume T3 display**.

For each failure, record `step | input device | starting screen/reply/page | exact gesture order |
approximate gaps | expected | actual | recovery needed`. Capture whether Listening remained on,
whether any message sent, and whether one or both displays changed. Download native logs after the
attempt and include gesture `kind` and `source`: system events distinguish `ring`, `rightTemple`, and
`leftTemple`; container events may only identify `textContainer` or `listContainer`.

Head nods/tilts are not acceptance inputs yet: this direct driver does not enable or decode IMU
motion data. Test them separately only after motion support is implemented.

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

Run the hardware-independent G2 protocol fixtures on macOS:

```bash
pnpm run test:g2-native
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

Preview and production variants use Expo fingerprinting so OTA updates only reach binaries with matching native dependencies, config plugins, and patches. CI uses the `preview:dev` profile to reuse a compatible native build when possible.

The development variant uses `appVersion` to avoid recalculating the native fingerprint for each Metro launch manifest. `MOBILE_VERSION_POLICY` can override either default. If you distribute a custom Release build with the development identity and publish OTA updates to it, set `MOBILE_VERSION_POLICY=fingerprint` for both its build and updates. Changing the runtime policy requires a native rebuild for OTA matching; an existing dev client can still load local Metro bundles.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
