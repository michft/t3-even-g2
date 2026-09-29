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
You can also open a thread directly on the iPhone. Once a thread is open, tap R1 to start dictation,
tap again to send, or quickly swipe R1 up then down (within 650 ms) to cancel. You can retry the
sequence immediately while dictation is starting or listening. Back goes one level up:
dictation or its error/sending screen returns to the current thread output,
preserving its reading position. Back from thread output opens the thread picker; Back there returns
to the last open thread. Dismissing Sending does not retract a submitted message.
A lone up swipe waits briefly for the
second gesture, then scrolls normally; down alone scrolls immediately. Hold (long-press) remains
an alternative when the glasses deliver that event. In **Settings → Even G2**, **Natural
scrolling** makes swipe up advance through content; turn it off for swipe down to advance instead.
This preference is saved on the phone and does not reverse the physical up-then-down Back/Cancel sequence.
Turn on **Fast Back gesture** beside it to require the two swipes within 350 ms instead of 650 ms,
reducing accidental Back actions when changing scroll direction.
Long-press requires firmware that delivers the Even Hub long-press event; tap-then-hold remains
the firmware menu gesture.
While idle, double-tap also returns to the thread picker; firmware exits still cancel active dictation.
Scroll backward through a reply to reach the previous reply's last page; scroll forward to read
newer replies. Each reply includes a short prompt label and a reply/page position. Older replies load
as you reach the edge of available history. If loading is unavailable, keep reading cached output or
swipe again to retry. Reading older output does not change which thread receives dictation.

New text preserves your reading position. New replies appear automatically while you are on the
first page of the latest reply; while you are reading older output or dictating, a new-reply marker
appears instead. Back opens the thread picker with **Latest output** highlighted; tap to jump to
the newest reply, or Back again to return to your previous reading position. Recent thread positions
and output remain available during this app session, including while the phone is locked; uncached
history needs a live environment connection. Restarting T3 requires loading the thread again.

If a double-tap returns the glasses to
Even, T3 automatically restores its display.
Dictation stays stopped until you tap again; returning to Even does not send your partial transcript.
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
show what reached the driver; `gesture.ignored`, `swipe.armed`, `swipe.expired`, `swipe.matched`,
and dictation transitions explain its decisions. `display.request` records a requested screen,
not confirmation that the user saw it. Keep screenshots/observations alongside these records.

Focused test commands (repo root):

```bash
bash apps/mobile/modules/t3-even-g2/tests/connection-smoke.sh --startup-back
bash apps/mobile/modules/t3-even-g2/tests/connection-smoke.sh --diagnostics
node --test scripts/g2-diagnostics.test.ts
```

The existing connection suite also runs these groups. They cover cancellation during tap feedback
and across preparation, plus diagnostic persistence, rotation, and report parsing.

Hardware test/debug run:

Use a disposable thread for send tests and a thread with several multi-page replies for history
tests. Record the T3 build, iOS version, glasses/R1 firmware, and both scrolling settings. Start
with **Fast Back gesture** off and **Natural scrolling** on. Except for explicit timing tests,
pause a second between separate actions. Changes to this native driver require an updated native
app; reloading JavaScript alone does not install them.

1. Quit Even on every paired phone/tablet. Connect from **Settings → G2 + R1**. Both arms should
   connect and show the T3 thread picker.
2. From Home or Settings, swipe R1 through the picker and tap a thread. The glasses and iPhone
   should select the same thread.
3. Tap R1, say “ring input test,” and tap again. Live text should appear on both surfaces and
   send exactly once. Confirm the assistant reply appears on the glasses.
4. Start dictation with a single right-arm tap, then cancel with R1 up→down. Repeat with the
   left arm. Both arm taps should start the same action as R1; note any missing or different input.
5. Start with R1, say “arm send test,” then send with a right-arm tap. Repeat with the left arm.
   Each run should send once, without requiring another ring tap.
6. Start dictation, speak, then swipe R1 up→down quickly. Listening should stop, nothing should
   send, and the previous reply and reading position should return.
7. Repeat step 6 using only right-arm swipes, then only left-arm swipes. Record whether each
   arm delivers both swipe directions on this firmware.
8. Start dictation and cancel immediately during **Tap received**. Test again after **Preparing**,
   then after **Listening** appears, one attempt at a time. Also start up during tap feedback and
   finish down during Preparing. It should stay cancelled even if microphone startup completes late.
9. While listening, swipe down, then immediately up→down without a pause. This is the debounce
   regression: it must cancel despite the preceding down swipe. Repeat five times.
10. After cancellation, immediately repeat up→down. Duplicate input inside 400 ms should not
    jump another level to the picker. After a one-second pause, a fresh pair should open it.
11. While listening, try up→down roughly 200 ms apart, then 500 ms apart. With Fast Back off,
    both should cancel. Restart dictation between attempts.
12. While listening, leave roughly one second between up and down. It should remain listening;
    use a fresh quick pair to cancel. Record perceived timing rather than treating hand timing
    as an exact measurement.
13. Enable **Fast Back gesture**. Repeat the 200 ms and 500 ms pairs: only the faster pair should
    cancel. Repeat step 9, then turn Fast Back off for the remaining tests.
14. In a multi-page reply, swipe once in each direction, pausing a second between swipes.
    With Natural scrolling on, up advances and down goes backward. A lone up has a brief delay.
15. Turn Natural scrolling off and repeat step 14: directions should reverse. Start dictation
    and confirm physical up→down still cancels. Restore Natural scrolling afterward.
16. Read an older reply on page two or later, start dictation, then cancel. The same reply/page
    should return. Back once more, pause, then Back from the picker: reading position stays intact.
17. From older output, Back to the picker and tap **Latest output**. The newest reply should open.
    Scroll across reply boundaries and confirm prompt labels and reply/page positions match.
18. Dictate while reading older output. The message should go to the currently selected thread.
    A new reply should mark new output without pulling you away from the older reading position.
19. Type an unsent draft on the phone. Start and cancel dictation, then separately dictate and
    send. The typed draft should survive both operations; only the dictated text should send.
20. While idle, double-tap R1. T3 should recover its display if firmware exits to Even, then show
    the picker. Select a different thread and start dictation. Before sending, confirm live text
    appears in that thread's phone composer. Send once and verify it reaches only that thread.
21. While listening, double-tap. Dictation should cancel without sending and T3 should recover.
    Test long-press separately as an alternate Back; note firmware that does not deliver it.
22. Start dictation but remain silent, then tap to finish. If recognition reports no speech,
    Back should dismiss the notice and return to the same reply/page. A new tap should retry.
23. Disconnect/reconnect G2, then test loss of range or a normal glasses power cycle. Both arms
    should reconnect, and two consecutive dictations should work. If automatic display recovery
    fails, test **Settings → Even G2 → Resume T3 display** and record that separately.
24. Select a thread, lock the iPhone for five minutes, then dictate/send twice using R1. Each
    message should reach that thread once, with replies on the glasses. Unlock and verify history.

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
