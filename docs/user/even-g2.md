# Even G2 glasses and R1 ring

This fork connects Even G2 glasses directly to T3 Code on an iPhone. Use the glasses to choose
an existing thread, read assistant replies, and dictate messages. The phone connects to your T3
environment; the glasses do not connect directly to the desktop or server.

You need iOS 26 or later and a custom native app containing this fork's G2 integration. An
upstream-only checkout, Expo Go, and upstream app downloads do not include these changes.
See [build and diagnostics](../operations/even-g2.md) for local installation.
This is an experimental, unofficial integration; firmware can affect input and recovery.

## Connect and choose a thread

Quit the Even app so it releases the glasses, including on other phones or tablets using them.
Connect an environment in T3 Code, then open **Settings → Even G2 → G2 + R1**.

Swipe R1 up/down to choose an existing thread; tap R1 or the right G2 arm to open it on the
phone and glasses. The picker lists non-archived threads by recent activity, with environment
and project labels. Opening a thread on the phone also selects it on the glasses.
Threads open at their latest reply. If the picker is empty, load threads on the phone first.

## Controls by page

**Back means a single tap on the left G2 arm.** Long-press does not trigger Back.

| Page or state                          | R1 / right-arm single tap                 | Swipe                           | Left-arm tap (Back)                  |
| -------------------------------------- | ----------------------------------------- | ------------------------------- | ------------------------------------ |
| Thread picker                          | Open selected thread or **Latest output** | Change selection                | Return to active thread, if any      |
| Reply reader or empty active thread    | Start dictation                           | Read pages and adjacent replies | Open thread picker                   |
| Preparing dictation                    | Wait for microphone                       | No action                       | Cancel dictation                     |
| Listening                              | Finish and send speech                    | No action                       | Cancel current dictation             |
| Sending / Thinking / waiting on phone  | Start another dictation                   | Up: return to current replies   | Open thread picker                   |
| Dictation error / no speech recognized | Retry dictation                           | No action                       | Dismiss notice and return to replies |

While the picker is opening a thread, further selections wait until it finishes. Back leaves
the opening state for the active thread when available.

In **Settings → Even G2 → Natural scrolling**, on means swipe up advances through content;
off means swipe down advances. The sending screen's **swipe up to replies** action uses physical
up under either setting. Swipes never cancel dictation, and up-then-down is not a Back gesture.
An idle double-tap opens the picker and triggers display recovery; use left-arm tap for Back.

## Dictate and send

Open the intended thread, tap R1 or the right arm, speak, then tap again to send. The glasses show
the newest recognized words while listening; the complete transcript is sent. Speech belongs
to the thread where dictation started. Existing typed draft text stays on the phone; glasses
send speech separately, without that draft's attachments or context.

After sending, **Sending to T3 Code…** changes to **Thinking…** when phone state reports work
underway. Connection, approval, and answer waits have their own notices; handle approvals and
structured questions on the phone or desktop. Swipe up to resume reading, or tap the left arm
to choose another thread. Neither action retracts the submitted message or stops agent work.

Left-arm tap during dictation cancels the current speech and preserves the pre-existing draft.
A Bluetooth interruption or display exit instead retains recognized words in the originating
phone draft without sending them. Review that draft on the phone before sending.

## Read replies

The reader shows assistant text with a short originating prompt and reply/page position.
It is not the full phone/desktop conversation: tool activity, attachments, and approval controls
are not separate glasses pages. Creating threads, changing settings, viewing files, terminal,
and Git/review work remain on the phone or desktop.

Swiping across a reply boundary moves into the neighboring reply; older history loads as needed.
Reading position is independent of the phone's scroll position. New replies appear automatically
when you are on the first page of the latest reply. While reading older output or dictating,
a new-reply marker appears instead. Back opens the picker with **Latest output** selected;
tap R1/right arm to jump there, or Back again to keep your previous position.

## Recovery and limits

T3 attempts to restore its display after a display exit. If recovery fails, tap R1 or use
**Settings → Even G2 → Resume T3 display** when available. To leave T3 deliberately, disconnect
**G2 + R1** in Settings before returning to the Even app.

Cached replies remain available within the app session; uncached history needs a live environment
connection. Select the thread before locking the phone. Locked-phone dictation, wake/reconnect,
and automatic display recovery need verification on your firmware. A connected Bluetooth status
does not prove taps, audio, or display updates are working. Force-quitting T3 stops the session.

For failures, include the native build commit, iOS/G2/R1 versions, input source, scrolling setting,
and phone lock state in [this fork's issue tracker](https://github.com/michft/t3-even-g2/issues).
The [diagnostics runbook](../operations/even-g2.md#export-diagnostics) explains how to collect logs.
