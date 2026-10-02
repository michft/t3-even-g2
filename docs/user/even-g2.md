# Even G2 glasses and R1 ring

This fork connects Even G2 glasses directly to T3 Code on an iPhone. Use the
glasses to choose an existing thread, read assistant replies, and dictate
messages. The phone connects to your T3 environment; the glasses do not connect
directly to the desktop or server.

You need iOS 26 or later and a custom native app containing this fork's G2
integration. An upstream-only checkout, Expo Go, and upstream app downloads do
not include these changes. See [build and diagnostics](../operations/even-g2.md)
for local installation. This is an experimental, unofficial integration;
firmware can affect input and recovery.

## Connect and choose a thread

Quit the Even app so it releases the glasses, including on other phones or
tablets using them. Connect an environment in T3 Code, then open **Settings →
Even G2 → G2 + R1**.

Swipe R1 up/down to choose an existing thread; tap R1 or the right G2 arm to
open it on the phone and glasses. The picker lists non-archived threads by
recent activity, with environment and project labels. Opening a thread on the
phone also selects it on the glasses. Threads open at their latest reply. If the
picker is empty, load threads on the phone first.

Hold R1 while reading to bring up the thread menu with the current thread
highlighted. It shows three nearby choices at a time: swipe R1 up/down to move
the highlight, then tap to open that thread. The list includes non-archived
threads by recent activity, including threads whose agents are idle. Tap the
left arm to return without switching threads.

## Controls by page

**Back means a single tap on the left G2 arm.** Long-press does not trigger
Back.

R1 long-press opens the thread menu while reading or waiting for a reply. It
does nothing while preparing, listening, or sending captured speech, and
releasing the hold does not open a choice. Arm holds do not open this menu.
When the lenses are asleep, tap once to wake them before holding R1.

| State                | Left-arm tap   | R1 tap         | Right-arm tap  |
| -------------------- | -------------- | -------------- | -------------- |
| Display asleep       | Wake only      | Wake only      | Wake only      |
| Thread picker        | Back to thread | Open selection | Open selection |
| Reply / empty thread | Open picker    | Dictate        | Latest reply   |
| Preparing dictation  | Cancel         | Wait           | No action      |
| Listening            | Cancel         | Send           | No action      |
| Sending / waiting    | Open picker    | Dictate        | Latest reply   |
| Speech error         | Dismiss        | Retry          | Latest reply   |

Right-arm tap jumps to the latest reply in the current thread. It does not
switch to another thread or start, send, or cancel dictation. If no reply
exists yet, it has no effect. In the picker, it opens the highlighted thread
or **Latest output** instead.

Swipes change selection in the picker and read pages and adjacent replies in
the reader. During Preparing or Listening, swipes do nothing. Swipe up from
Sending or a phone-waiting screen returns to replies.

While the picker is opening a thread, further selections wait until it finishes.
Back leaves the opening state for the active thread when available.

In **Settings → Even G2 → Natural scrolling**, on means swipe up advances
through content; off means swipe down advances. The sending screen's **swipe up
to replies** action uses physical up under either setting. Swipes never cancel
dictation, and up-then-down is not a Back gesture. A double-tap while the
display is awake and you are not dictating opens the picker and triggers display
recovery; use left-arm tap for Back.

The lenses go blank after 15 seconds without a tap, swipe, or R1 hold. Tap either G2 arm
or R1 once to wake the current view; that first tap only wakes, and the next tap
performs its usual action. Incoming replies stay hidden until you wake the
display. The same timeout applies during dictation: speech capture continues
while the lenses are blank. Wake with one tap, then tap R1 to send or the left
arm to cancel.

## Dictate and send

Open the intended thread, tap R1, speak, then tap R1 again to send. The glasses
show the newest recognized words while listening; the complete transcript is
sent. Speech belongs to the thread where dictation started.
Existing typed draft text stays on the phone; glasses send speech separately,
without that draft's attachments or context.

After sending, **Sending to T3 Code…** changes to **Thinking…** when phone state
reports work underway. Connection, approval, and answer waits have their own
notices; handle approvals and structured questions on the phone or desktop.
Swipe up to resume reading, or tap the left arm to choose another thread.
Neither action retracts the submitted message or stops agent work.

Left-arm tap during dictation cancels the current speech and preserves the
pre-existing draft. A Bluetooth interruption or display exit instead retains
recognized words in the originating phone draft without sending them. Review
that draft on the phone before sending.

## Read replies

The reader shows assistant text with a short originating prompt and reply/page
position. It is not the full phone/desktop conversation: tool activity,
attachments, and approval controls are not separate glasses pages. Creating
threads, changing settings, viewing files, terminal, and Git/review work remain
on the phone or desktop.

Swiping across a reply boundary moves into the neighboring reply; older history
loads as needed. Reading position is independent of the phone's scroll position.
New replies appear automatically when you are on the first page of the latest
reply. While reading older output or dictating, a new-reply marker appears
instead. Tap the right arm to jump directly to the latest reply. Back opens
the picker with **Latest output** selected; tap R1 or the right arm to open it,
or Back again to keep your previous position.

## Recovery and limits

T3 attempts to restore an awake display after a display exit. A timed-out
display stays blank until you tap to wake it. If recovery fails, tap R1 or use
**Settings → Even G2 → Resume T3 display** when available. To leave T3
deliberately, disconnect **G2 + R1** in Settings before returning to the Even
app.

Cached replies remain available within the app session; uncached history needs a
live environment connection. Select the thread before locking the phone.
Locked-phone dictation, wake/reconnect, and automatic display recovery need
verification on your firmware. A connected Bluetooth status does not prove taps,
audio, or display updates are working. Force-quitting T3 stops the session.

For failures, include the native build commit, iOS/G2/R1 versions, input source,
scrolling setting, and phone lock state in
[this fork's issue tracker](https://github.com/michft/t3-even-g2/issues). The
[diagnostics runbook](../operations/even-g2.md#export-diagnostics) explains how
to collect logs.
