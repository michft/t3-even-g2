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
tap again to send, or quickly swipe R1 up then down (within 650 ms) to cancel. The same sequence
goes back one level: dictation or its error/sending screen returns to the current thread output,
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

Hardware acceptance checks:

1. Quit the Even app, connect from **Settings → G2 + R1**, and confirm both arms reach **Connected**.
2. From Home or Settings, use R1 to swipe to a thread and tap it. Confirm T3 opens the same thread.
   Tap R1 again, speak, and confirm live text appears in the composer and on the G2.
3. Tap R1 again and confirm the transcript is sent while any pre-existing typed draft is preserved.
4. Start another dictation, quickly swipe R1 up then down, and confirm it cancels without sending. Confirm the T3
   display returns automatically and another tap starts a fresh dictation without reconnecting.
5. Confirm the next assistant response appears on the G2; for a multi-page response, swipe up and
   down to move between lens-sized text windows. Double-tap while idle, choose a different thread,
   and verify the next dictation goes there, preserving the previous thread's draft.
6. Power-cycle one arm and confirm the app reconnects both arms and returns to **Connected**.
7. Leave the thread open, lock the iPhone for five minutes, then dictate using R1. Confirm the
   message reaches that thread once, the reply appears, and a second dictation works.

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
