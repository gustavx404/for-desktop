# Rust-owned screen capture -- spike notes

## Session update (2026-08-21, third session): the REAL "share twice" bug
## found and fixed -- a per-capture Tokio runtime orphaning ashpd's cached
## D-Bus connection

The `.stop()`-override fix from earlier this same day (still correct, see
below) turned out to fix a *real* bug but not *the* bug: live-tested
after it shipped, sharing still hung on the second attempt, silently --
no picker dialog, nothing in the app, "share once then the button does
nothing" exactly as originally reported. Root-caused this time by adding
`eprintln!` at every `await` point inside `negotiate_portal()`
(`Screencast::new`, `create_session`, `select_sources`, `start`,
`open_pipe_wire_remote`) and reading a live capture: the second call
hung on the very first line, `Screencast::new().await`, forever.

**Root cause**: `run_capture()` created a **fresh `tokio::runtime::Runtime`
per capture session** (`tokio::runtime::Runtime::new()?`, dropped at the
end of that same function). `ashpd` (the portal client crate this addon
uses) caches its D-Bus session connection **process-wide**, once, in a
plain `static SESSION: OnceLock<zbus::Connection>`
(`ashpd-0.13.13/src/proxy.rs:27`, confirmed by reading the vendored
source directly under `~/.cargo/registry`) -- created on whichever Tokio
runtime happens to be active the first time any portal call is made, and
reused via that `OnceLock` by every later call, regardless of which
runtime asks for it. Dropping the first capture's runtime tears down its
I/O driver and aborts every task spawned on it, including zbus's own
background task that actually pumps the connection's socket -- the
`zbus::Connection` *handle* survives (it's owned by ashpd's static, not
by the dropped runtime), so `Proxy::connection()` happily hands it back
on the second call, but nothing is left running to ever complete a
pending call on it. Second negotiation, second runtime, first `.await`:
hangs forever, no error, no timeout, nothing -- exactly the "silent
hang, no dialog, button just stops responding" symptom, for as many
reshares as were attempted after the first.

**Fix** (`src/lib.rs`): one `static RUNTIME: OnceLock<tokio::runtime::Runtime>`,
created once and reused by every `run_capture()` call, replacing the
per-call `Runtime::new()`. `Runtime::block_on` is safe to call from
multiple threads against the same shared runtime (each capture still
gets its own OS thread via `std::thread::spawn` in `start_capture`, they
just now share one Tokio runtime instance instead of each getting -- and
then killing -- their own).

**Live-confirmed working**: three consecutive share -> stop -> share
rounds in the same app session, all completing cleanly
(`[stoat-capture-diag]` showing a full `Screencast::new -> create_session
-> select_sources -> start -> open_pipe_wire_remote -> ... -> stop ->
joined` cycle every time, no hangs). This is the actual fix for the
long-standing "works once" bug -- the `.stop()`-override change earlier
this session was real and worth keeping (it fixed a genuine, separate
app-state-desync issue), but was not sufficient on its own.

Also added this session, alongside the above (kept, working as intended):
`PersistMode::Application` + an in-memory (process-lifetime,
`static RESTORE_TOKEN: Mutex<Option<String>>`) portal restore token in
`negotiate_portal()`, so only the *first* share of an app session shows
the interactive picker dialog -- confirmed live: round 2 and round 3
both reused the token from round 1 and skipped the dialog entirely, no
picker shown, straight to capturing. Doesn't affect the runtime bug
either way (it was masked by, not caused by, the missing dialog), but is
a real, independent UX improvement worth keeping.

**Live-measured resource cost** at the current 1920x1080@60fps setting,
one active share, one remote participant: renderer RSS ~1GB, CPU ~100%
(a full core) -- this is the "known real tension" flagged below made
concrete: LiveKit's software VP8 simulcast encode (no VP8 hardware
encode on this AMD GPU) is genuinely expensive at 60fps, independent of
anything in this addon. Worth a real per-resolution/fps cost table
before deciding a final target, not assumed further.

Diagnostic `eprintln!`s added this session (`negotiate_portal`'s
per-await tracing) removed once the bug they were added to find was
confirmed fixed; the higher-level `[stoat-capture-diag]` lines
(`start_capture`/`stop` lifecycle) stay, per this file's existing
practice of keeping those.

## Session update (2026-08-21, second session): "share twice" bug
## root-caused (partially) and fixed; resolution/framerate raised back to
## 1440p60fps

### "Share only works once" -- root cause found, fix applied

Root cause, confirmed against `livekit-client`'s actual source
(`github.com/livekit/client-sdk-js`, `src/room/track/Track.ts` and
`LocalParticipant.ts`, fetched and read this session -- the previous
session's "not yet investigated" item): per the Media Capture and
Streams spec, `MediaStreamTrack.stop()` does **not** dispatch `'ended'`
when the application itself calls it -- that event exists specifically
for *spontaneous* endings (e.g. a camera unplugged), so the caller isn't
notified of something it already knows it did. LiveKit's own unpublish
path (`LocalParticipant.unpublishTrack` -> `LocalTrack.stop()` ->
`Track.stop()` -> `mediaStreamTrack.stop()`) is exactly this kind of
app-initiated call, and runs by default (`stopLocalTrackOnUnpublish`
defaults to `true`) every single time the user clicks "stop sharing".
This app's own `state.tsx` also attaches
`localTrack.on("ended", () => this.toggleScreenshare())` -- so the
*app's* "am I sharing" flag depends on the exact same event this
patch's cleanup was waiting for, and neither was ever going to fire on
a normal stop.

That fully explains every earlier session's symptoms: `trackShareRound`'s
`'ended'`-only cleanup never actually ran on a real "stop sharing" click,
silently leaking the Rust capture and leaving `usingRustCapture`/
`realVideoTrack` pointed at a round LiveKit already considered gone --
which is exactly what made the *next* `getDisplayMedia` call fall into
this file's reuse branch and hand back a track for a capture nobody was
draining anymore, instead of negotiating fresh. It also explains why the
app's own share button silently did nothing on a second attempt: its
`toggleScreenshare()` state was never getting flipped back either, for
the identical reason.

The previous session's workaround -- sniffing `console.log` for
LiveKit's internal `"unpublishing track"` line and calling `.stop()` on
whatever `realVideoTrack` currently was -- is now understood to have
been actively unsafe on top of not fully fixing it: that log line fires
for the provisional round's own unpublish too (not just a genuine user
stop), and by the time it's read, `realVideoTrack` may already have been
reassigned to a *newer* round by `getDisplayMedia`'s reuse branch --
meaning it could kill a share that was still live, a believable
explanation for "worked once, then failed again on retest."

**Fix applied** (`src/world/screenShareAudio.ts`): removed the
`console.log` sniffing entirely. `trackShareRound` now overrides the
video track's own `.stop()` method (shadowing the native one as an own
property on that specific instance) to run the round-ended cleanup
synchronously, in addition to calling through to the real native stop.
This ties cleanup to the exact call that ends a round -- whoever makes
it (LiveKit's unpublish, this app, or this patch's own write-failure
handling) -- with no event-timing dependency and no cross-round race:
`liveRounds.add(videoTrack)` now happens *before* stopping any stale
round, so a stale round's own overridden `.stop()` (which now runs
cleanup synchronously) sees the new round already present and correctly
treats it as a handoff, not the end of the whole share. The native
`'ended'` listener is kept too, as a second path into the same
(idempotent) cleanup function, for the Chromium-fallback path's one
truly spontaneous case: the user closing the shared window via the OS
itself rather than this app's UI.

Not yet live-tested end to end (needs a real portal share/stop/reshare
cycle) -- confirmed by reading the actual `livekit-client` source rather
than guessing from symptoms this time, and the crate builds clean, but
this should still be verified with a real multi-round share before
trusting it the way earlier "fixed" attempts turned out not to be.

### Resolution/framerate raised back toward 1440p60fps

`MAX_FRAME_DIMENSION` (1280 -> 2560) and `MIN_FRAME_INTERVAL` (100ms/
~10fps -> 16ms/~60fps) in `src/lib.rs` were both dropped chasing a
500MB RAM budget in the *previous* session, reasoning that the real
achievable throughput to this app's self-hosted LiveKit server was
capped around 13-15fps / ~950kbps by the network path -- specifically,
the Oracle VPS relay's low outbound bandwidth tier plus a WireGuard
tunnel hop. That same session then migrated the whole stack off that
VPS onto this user's home connection directly (real public IP, TURN
enabled) -- if that ceiling really was the VPS/tunnel, it may no longer
apply. Raised both back to the newly-requested 1440p60fps target on
that basis; **not yet confirmed against real stats post-migration**.
Both crate builds (debug and release) compile clean at these values.
`downscale_packed_4bpp` is a no-op for any source at or below 2560px on
its longer side, so a 1440p (or smaller) monitor now shares at native
resolution; a 4K+ monitor still gets downscaled down to 1440p.

**Live-tested, reverted**: 2560 (1440p) + 60fps froze the whole app
within ~10-15s of a real share (confirmed via CDP -- `Runtime.evaluate`
on the renderer didn't even respond within 5s, meaning the main thread
was genuinely saturated, not just laggy). This is the *exact* freeze
item 6 further down already documented once ("full native monitor res
at 60-80fps reliably froze the whole app") and fixed by downscaling to
1920 -- the VPS migration fixed a *different* bottleneck (encode/send
throughput) and was never going to help this one, which is real
main-thread cost per frame (a ~14.75MB copy every 16ms at 2560, a
`VideoFrame` construction + `write()` on the page's main thread for
each), unrelated to network. Reverted `MAX_FRAME_DIMENSION` back to
1920 (see its own comment in `src/lib.rs`) -- the highest value a prior
session actually confirmed working at 60fps. Kept `MIN_FRAME_INTERVAL`
at 60fps for now since 1920x1080@60fps was that prior session's own
confirmed-working combination, not an untested guess.

To actually reach 1440p without refreezing, the JS-side per-frame cost
itself needs to come down first -- candidates, not yet attempted: a
real reusable buffer pool (noted as "deliberately not done" earlier in
this file) instead of a fresh `Vec`/`VideoFrame` per frame, or capping
delivery below 60fps specifically at higher resolutions (trade fps for
resolution rather than assuming both are free once the network is
fixed).

Separately noticed and worth fixing regardless of resolution/fps
(not yet done, flagging for later): `CaptureHandle::stop()` is a plain
synchronous NAPI call that blocks the *calling* thread (the renderer's
main JS thread, in every real caller) on `JoinHandle::join()`. Normally
fast (~100ms, bounded by the capture thread's own stop-flag timer), but
if the renderer's main thread is ever independently overloaded (as
above), a call to `stop()` just becomes one more thing queued behind
that overload rather than a way out of it -- worth making genuinely
non-blocking (spawn the join on its own thread, or a real async NAPI
task) as a hardening measure, so a slow/stuck teardown can never freeze
the whole UI. Deferred this session to avoid stacking an untested
concurrency change on top of an already-live-tested revert.

Known real tension, still not measured: LiveKit's own simulcast encode
(`encoderImplementation: "libvpx"` -- software, this AMD GPU's VA-API
doesn't support VP8 hardware *encode*) does real CPU work that scales
with pixel count, for *two* layers at once. Even at 1080p60fps this
could be CPU-heavy -- "low CPU" and "60fps" may be in real tension on
this hardware regardless of resolution. Next step: a live share/call at
the current 1920x1080@60fps settings, then read the real `[stoat-stats]`
console output (already wired up in `screenShareAudio.ts`) plus
`ps`/`top` RSS and CPU% for the Electron renderer process during an
active share, to see what's actually happening now rather than guessing
further.

## Session update (2026-08-21, later): RAM/CPU fixed and verified; "share
## twice" bug still open

### RAM/CPU/leak -- CONFIRMED FIXED, extensively tested

Root causes (both real, both fixed):
1. **`VideoFrame` was never `close()`d** in `screenShareAudio.ts`'s
   `framePort.onmessage` handler -- a stale comment claimed `write()` took
   ownership and closed it; confirmed live via a wrapped-`VideoFrame`
   instrumentation that it does not. Every frame written leaked forever
   (RSS 279MB -> 2GB+ in under 20s). Fixed: `vf.close()` in the
   `write()`'s `.finally()`.
2. **The Rust capture thread was never actually stopped** in two
   situations: (a) when `getDisplayMedia`'s reuse-check failed and a
   fresh capture was negotiated, the *previous* `activeCaptureHandleId`
   was silently overwritten with nothing left to `stop()` it (confirmed
   live: thread count climbing 66 -> 220+ across a handful of rounds).
   Fixed in `startRustCapture()`: stop any still-active previous handle
   before negotiating a new one. (b) When a round's track died without
   its `'ended'` event ever firing (see below), the same leak recurred.
   Fixed via the write-failure/`.enabled`-adjacent detection described
   below (though see "still open" section -- this part is unfinished).

Also tuned for a ~500MB RAM budget during an active share (target given
by the user): capture resolution 1080p -> 720p, framerate 60fps -> 10fps
(the app's own simulcast layers never used more than 13-15fps anyway,
confirmed via real WebRTC stats), `mimalloc` as the crate's global
allocator (glibc was holding onto the frequent multi-MB alloc/free
pattern rather than returning it to the OS), and skipping the
destination buffer's zero-init in `downscale_packed_4bpp` (every byte
gets overwritten by the loop anyway). Result, confirmed live across many
repeated share/stop cycles: RSS climbs to ~500MB during a share, settles
back to ~380-400MB, stays flat -- no unbounded growth, no leaked
threads.

### Network -- migrated off the Oracle VPS relay entirely

TURN was disabled in `livekit.yml` (root cause of most connection
failures/timeouts) -- enabled it (`turn.enabled: true`, `udp_port: 3478`,
`relay_range_start/end: 30000-30100`), which required: exposing those
ports through the container (`compose.yml`), the VPS's iptables
DNAT+FORWARD+MASQUERADE rules (both the PREROUTING/POSTROUTING *and* the
FORWARD-chain ACCEPT rules -- the FORWARD chain's default DROP policy was
silently eating the new ports even after DNAT correctly rewrote them,
found by watching `iptables -t nat -L -v` packet counters going from 0 to
nonzero only after adding those), and the corresponding Oracle Cloud
Security List ingress rules (the OS-level firewall alone wasn't enough;
confirmed via a real STUN round-trip test from outside).

Given that worked, the whole self-hosted stack was migrated off the VPS
entirely, straight to the user's home connection (confirmed real public
IP, not CGNAT) via DuckDNS:
- Ports 80/443 are ISP-blocked inbound (confirmed via direct TCP connect
  tests -- 443 refused outright, 80 answered with something that clearly
  wasn't Caddy) -- worked around by exposing on port 8443 instead
  (already the container's host-mapped port, `8443:443` in `compose.yml`
  -- no docker change needed, just router forwarding + updating every
  `https://zerosecx.duckdns.org` reference to include `:8443`:
  `Revolt.toml`, `stoat.json`, `.env.web` -- all on the LiveKit/app
  server at `192.168.20.189`, all backed up with a `.bak-port8443` suffix
  before editing).
- Caddy's automatic HTTPS needs port 80 or 443 reachable for its default
  ACME challenge -- neither works now, so switched to a DNS-01 challenge
  via the DuckDNS API instead (needs no open port at all). Required a
  custom Caddy build (`Dockerfile.caddy`, `caddy:2-builder` +
  `xcaddy build --with github.com/caddy-dns/duckdns`) since the stock
  `docker.io/caddy` image doesn't include DNS provider plugins;
  `compose.yml`'s `caddy` service now builds from that instead of using
  the bare image. `Caddyfile` got a `tls { dns duckdns {$DUCKDNS_TOKEN} }`
  block; `DUCKDNS_TOKEN` added to `.env.web` (which `docker-compose.yml`
  already wires as caddy's `env_file`).
- A DuckDNS updater (`/opt/duckdns/update.sh` + a `*/5 * * * *` crontab
  entry) now runs directly on `192.168.20.189` to keep the A record
  pointed at the home connection's current IP.
- `livekit.yml`'s `rtc.node_ip` (previously hardcoded to the VPS's static
  IP) switched to `use_external_ip: true` instead, since a home IP can
  change under DuckDNS -- this makes LiveKit auto-discover its current
  public IP via STUN at startup rather than needing a manual update every
  time the IP changes.
- Confirmed end-to-end working directly (API, TLS cert, LiveKit) with
  the VPS's WireGuard tunnel (`wg-quick.wg0`) stopped and removed from
  boot. The VPS itself is no longer in the request path for this app at
  all; safe to fully decommission whenever convenient.

### Still open: screen share only works once per app session

**Symptom**: first `getDisplayMedia`-driven share of an app session works
correctly end-to-end (video publishes, is visible to other participants,
audio works). After the user stops it and tries to share again, nothing
visibly happens -- no picker, no error, `md.getDisplayMedia` (this
patch's override) is never even re-entered. Confirmed via
`stoatchat/for-web`'s own source (`packages/client/components/rtc/
state.tsx`, `toggleScreenshare()`): there is exactly **one** call site
that triggers `getDisplayMedia` --
`room.localParticipant.setScreenShareEnabled(true, {...})` (LiveKit's own
high-level API calls it internally) -- gated on the app's own reactive
`this.screenshare()` state flag. If that flag is wrong (says "already
sharing" when nothing real is being sent, or vice versa), the button does
whatever's consistent with the *wrong* state, not the real one.

**The mechanism, confirmed via source**: that same code attaches
`localTrack.on("ended", () => { this.toggleScreenshare(); ... })` --
*any* real `'ended'` event on the track this patch hands back is treated
by the app as "the user closed the shared window," which fully stops
sharing and flips `this.screenshare()` to false. This patch's own
cleanup logic (`trackShareRound`'s `'ended'` listener) also depends on
`'ended'` firing to release the Rust capture -- so both sides are relying
on the same signal, but for different reasons, and disagreeing about
when it should fire is exactly what's desynced.

**What's confirmed AND ruled out this session**:
- Live-observed repeatedly: shortly (variably, 1-13s) after a round
  starts, the write path enters a burst of `InvalidStateError: ...
  Stream closed` failures, self-resolving into what looks like a
  provisional -> confirmed handoff (a second `getDisplayMedia` call,
  reported as `readyState: ended` on the prior round -- this repeats on
  *every* round, not just the first, going by thread/log timing, which
  undercuts the "provisional round" theory somewhat).
- Tried and reverted: treating `realVideoTrack.enabled === false` as "the
  round ended" (a `pauseUpstream()`/`resumeUpstream()` false-positive
  theory -- `toggleScreenshare()`'s quality-picker flow does call
  `localTrack.pauseUpstream()`, which was suspected to set `.enabled =
  false`, but removing this check did NOT reliably fix the symptom on
  retest, so either the theory was wrong or it was only ever a partial
  contributor).
- Tried and reverted: `currentWriter.desiredSize === null` as an end
  signal -- same result, didn't reliably fix it either.
- Tried and reverted: gating the `InvalidStateError` end-signal on
  `CONSECUTIVE_FAILURE_THRESHOLD` (5) consecutive frame failures instead
  of the first one, to rule out a single transient failure as the
  trigger -- did NOT fix the symptom on retest either, reverted back to
  the simpler single-failure trigger.
- Currently in place (as of this session's end, committed): (a) `write()`
  rejecting with `InvalidStateError` ends the round on the very first
  such failure (back to this after the consecutive-failures experiment
  above didn't help), and (b) wrapping `console.log` to catch LiveKit's
  own `"unpublishing track"` log line (confirmed this fires reliably for
  the provisional->confirmed transition, but its correlation with the
  actual *user-intended* stop hasn't been independently confirmed). This
  combination was live-confirmed working for one full share/stop/reshare
  cycle, then failed again on a later retest -- genuinely unresolved,
  possibly flaky/multi-causal. Don't trust it as fixed.
- **Not yet investigated**: whether the repeating ~1-13s `getDisplayMedia`
  re-entry is coming from `state.tsx`'s own code at all, or from
  somewhere inside `livekit-client`'s `setScreenShareEnabled()`
  implementation itself (its source wasn't read this session -- only
  `stoatchat/for-web`'s own code was). If that's LiveKit's own retry
  logic (not this app's), the actual fix might be entirely different --
  e.g. finding out *why* LiveKit's internal `setScreenShareEnabled` isn't
  satisfied with the track handed back the first time, rather than
  reacting to the symptom from this patch's side at all.
- **Next concrete step**: clone `livekit-client` (npm, or
  `github.com/livekit/client-sdk-js`) and read `setScreenShareEnabled`'s
  actual implementation -- this session confirmed `stoatchat/for-web`
  only calls it once, so any repeat negotiation is either inside that
  SDK method or is this synthetic track failing some readiness check
  LiveKit performs on it that a real captured track would pass
  trivially (worth checking what, if anything, LiveKit reads from
  `mediaStreamTrack.getSettings()`/`getCapabilities()` right after
  `getDisplayMedia()` resolves -- a `MediaStreamTrackGenerator`'s output
  track returns close to nothing meaningful from either).

## Session update (2026-08-21): allocator + downscale RAM/CPU tuning

Two small, low-risk changes to the per-frame hot path in `src/lib.rs`,
aimed at the RSS-growth-during-a-share behavior noted below (confirmed
"expected allocator behavior, not evidence of a leak" at the time, but
worth tightening up now that this is wired into the real app, not just a
standalone test):

1. **`mimalloc` as the crate's global allocator.** The capture loop
   allocates and frees one multi-megabyte frame buffer every frame (tens
   of times a second) -- exactly the alloc/free-churn pattern glibc's
   malloc tends to hold onto rather than return to the OS, which is what
   RSS climbing-and-not-coming-back-down actually was. mimalloc returns
   freed pages far more eagerly for this pattern. No change to the
   capture/transfer pipeline itself.
2. **Skip the destination buffer's zero-init in `downscale_packed_4bpp`.**
   It was `vec![0u8; size]` (a full memset of the ~8MB 1080p destination
   buffer) immediately before a loop that overwrites every byte of it
   anyway. Now `Vec::with_capacity` + `set_len` (sound here -- the loop's
   coverage is exhaustive, see the comment at the call site).

Investigated and deliberately **not** done: a true reusable buffer pool
(pre-allocate N buffers, hand them back and forth between Rust and JS
instead of allocating fresh each frame). `screenShareCapture.ts` already
hands frame ownership to the main world via a one-way `postMessage`
*transfer* (not a `contextBridge` clone -- that was fixed earlier, see
below), which is zero-copy but also one-way: once a frame's buffer
crosses into the main world it can't come back to Rust for reuse without
a new hand-back protocol (JS explicitly returning a buffer once its
`VideoFrame` has copied out of it). That's real added complexity/surface
for a gain that isn't demonstrated to be needed once the two changes
above are measured -- left as a future option, not pursued here.

## Session update (2026-08-20, later): wired up, working, bottleneck is network

Full Electron integration is done and stable now (`src/world/screenShareCapture.ts`,
`src/world/screenShareAudio.ts`, `src/native/window.ts` all wired). Key bugs found
and fixed along the way, in case any regress:

1. **Sandboxed preload can't load native addons at all** (`sandbox: false` now set
   on both BrowserWindows using this preload -- `src/native/window.ts`).
2. **`process.env` in preload doesn't reliably see WAYLAND_DISPLAY/XDG_SESSION_TYPE**
   -- ask the main process via the existing `getIsWayland` IPC handler instead.
3. **Node's ESM loader can't `import()` a `.node` file** (`ERR_UNKNOWN_FILE_EXTENSION`)
   -- use `createRequire(addonPath)(addonPath)`, not dynamic `import()`.
   `import.meta.url` is *not* usable as createRequire's base in this bundled
   preload (resolves to the page's remote origin, not the real local path) --
   use the already-known absolute `addonPath` itself instead.
4. **contextBridge always clones, never transfers** (confirmed against
   electron/electron#27024) -- frames now cross via a `MessageChannel`
   set up in `screenShareCapture.ts` and requested on-demand by the main
   world (`requestFramePort()`), NOT sent eagerly at preload-load time
   (that raced the main world's listener attaching and silently dropped
   the port -- confirmed live, broke the share button entirely for one
   session).
5. **`MediaStreamTrackGenerator.clone()` shares its writable stream with
   the original** -- stopping a cloned "stale round" track (the
   provisional->confirmed handoff `trackShareRound` already does) closed
   the *original* generator's writer too, silently killing every future
   `write()` after ~220 frames (`InvalidStateError: Stream closed`, only
   found via real `RTCPeerConnection.getStats()` data, not logs). Fixed:
   each round now gets its own independent `MediaStreamTrackGenerator`
   via `createRustVideoTrack()`, all fed by the one ongoing Rust capture
   -- no clone, no shared state, no renegotiation.
6. **Frame rate/resolution tuning**: full native monitor res at 60-80fps
   reliably froze the whole app (contextBridge clone + VideoFrame
   construction cost on the main thread, confirmed via a minimal
   addon-only Electron repro that had zero issue at the same rate --
   isolating the cost to the JS-side pipeline, not the addon). Downscaling
   in Rust (`downscale_packed_4bpp`, integer nearest-neighbor, precomputed
   per-column not per-pixel) to a capped `MAX_FRAME_DIMENSION` fixed it.
   Currently `1920` (1080p) in `src/lib.rs` -- was tried at `1280` (720p)
   too, which reduced lag further (see item 7).
7. **Remaining lag is NOT this addon, NOT Chromium's encoder, NOT CPU --
   it's network bandwidth to the user's self-hosted LiveKit server**
   (behind a WireGuard-tunneled Oracle VPS proxy). Confirmed via real
   `RTCPeerConnection.getStats()` outbound-rtp data pulled live over CDP:
   encode time ~6ms/frame (fast, not the bottleneck), `encoderImplementation:
   "libvpx"` (software -- this AMD GPU's VA-API driver doesn't support VP8
   hardware *encode*, despite `VaapiVideoEncoder` being enabled in
   `src/main.ts`; decode-only support is common on AMD), but actual
   achieved bitrate (~950kbps) far below LiveKit's own requested target
   (~2.5Mbps) with `qualityLimitationReason: "none"` -- classic signature
   of the network path (not the encoder) throttling throughput. Likely
   Oracle's low outbound bandwidth tier and/or WireGuard MTU/overhead if
   media (not just signaling) is routed through that tunnel. Nothing left
   to fix here in this repo; next step is network-side (bandwidth test to
   the VPS, checking whether LiveKit can ICE/TURN direct instead of
   forcing media through the WireGuard hop).

A temporary diagnostic (real WebRTC stats logged to console every 3s,
`[stoat-stats]` prefix, plus `window.__stoatPCs` exposing live
RTCPeerConnection instances for ad-hoc `getStats()` calls) is still in
`screenShareAudio.ts`'s patch script -- harmless (logging only), safe to
strip once the network-side investigation is done.


## Why this exists

On Linux/Wayland, screen-share memory grows ~90-140MB per share and never
comes back down. Investigated live (this repo's regular fixes to
`src/world/screenShareAudio.ts` reduced but did not eliminate it) and
confirmed empirically, via a running debug build with
`--remote-debugging-port` and Chrome DevTools Protocol:

- Not JS heap (`performance.memory` stayed ~30MB the whole time).
- Not a DOM/video/canvas element (zero on the page during/after a share).
- Not a lingering PipeWire object (`pw-dump` showed nothing after a share
  ended -- only our own audio nodes).
- Not reclaimable via `Memory.simulatePressureNotification` (CDP) --
  RSS didn't move.

Conclusion: it's native (GPU/shared-memory) buffer memory private to
Chromium's own renderer process, held by its desktop-capture pipeline
(the portal + PipeWire ScreenCast backend), with no public API -- CDP,
Electron, or otherwise -- able to reclaim it short of killing/restarting
that process. That's a real constraint on this app's users specifically
(a voice/video call must never be interrupted to reclaim memory), so a
reload-based mitigation was ruled out.

## The idea

Stop asking Chromium to do the capture at all. Do the portal negotiation
and PipeWire video capture ourselves, in Rust, the same way
`native/virtualMic.ts` already owns PipeWire *audio* routing via
`node-pipewire`. We control the capture's lifecycle end to end, so we
control when its buffers get freed -- no dependency on Chromium's own
(apparently buggy) cleanup.

Getting a frame from our own capture into something the web app's
existing WebRTC code can actually send requires `MediaStreamTrackGenerator`
(WebCodecs/Insertable Streams) -- feed it `VideoFrame`s from outside,
get a real `MediaStreamTrack` back. Supported in this app's Electron
(Chromium 150 as of the 1.6.0 build).

## Status: phase 1 & 2 spike -- PROVEN

**Phase 1** (raw Rust binary, not part of this crate, discarded after
proving the concept): negotiated `org.freedesktop.portal.ScreenCast`
directly via `ashpd`, connected to the resulting PipeWire node via
`pipewire-rs`, captured one real frame (14,745,600 bytes = exactly a
2560x1440 RGBA frame, 90%+ non-zero sampled bytes). Confirmed this works
with **zero Chromium involvement**.

**Phase 2** (this crate, `native/screen-capture`): wrapped the same
capture logic in a NAPI (`napi-rs`) addon exposing:

```
startCapture(onFrame: (err, FrameData) => void, onError: (err, string) => void): CaptureHandle
CaptureHandle.stop(): void

FrameData { data: Buffer, width: u32, height: u32, stride: u32, format: u32 }
```

Tested directly from a plain Node script (no Electron yet):
- Sustained ~48fps at 2560x1440 for 5s (239 frames), zero drops, via
  `ThreadsafeFunction` -- the callback bridge from the capture thread
  (its own OS thread, running the PipeWire main loop) into JS.
- One full start -> capture -> `stop()` cycle: capture starts fresh,
  and `stop()` synchronously joins the capture thread (blocks until the
  PipeWire stream/core/context/main-loop -- all Rust-owned, torn down via
  `Drop` -- have actually gone away). This is a structural guarantee, not
  a hope: unlike Chromium's internals, we own every object in this chain.
- RSS of the *Node test process* rose ~52MB -> ~157MB across one cycle
  (allocating a fresh `Vec<u8>` per frame, ~14.7MB x ~48fps = real
  allocation churn V8 hasn't fully reclaimed yet at the moment measured
  -- expected GC/allocator behavior, not evidence of a leak, and
  something we can tune later e.g. with a reusable buffer pool). A second
  cycle's delta was not captured live (portal picker dialogs need a real
  human click each time, and that timing didn't line up in this session)
  -- follow up on this before shipping, but it isn't blocking further
  work given the structural ownership guarantee above.

## Not yet done (pick up here)

1. ~~**Format mapping**~~ -- DONE. `FrameData` now carries `pixelFormat:
   Option<String>` (via `spa_format_to_webcodecs()` in `src/lib.rs`),
   mapping only the packed single-plane SPA formats the pixel-copy code
   actually handles correctly (`RGBA`/`RGBx`/`BGRA`/`BGRx`) to their
   `VideoPixelFormat` equivalents; anything else (e.g. `xRGB`/`ARGB` --
   no WebCodecs equivalent -- or `I420`/`NV12`/etc, which the current
   single-plane `datas_mut().first_mut()` read would corrupt) comes back
   `None`, which the consumer must drop the frame for, not guess at. Also
   fixed `stride` to read `chunk.stride()` directly instead of
   approximating via `chunk_size / height` (wrong under row padding).
   Verified live: `pixelFormat: 'BGRA'`, `stride: 10240` (=2560*4, no
   padding on this system) over a fresh capture run, 10/10 frames, format
   id `12` as before.
2. ~~**Electron wiring**~~ -- DONE (pending the live render-test in item 4
   below). `src/world/screenShareCapture.ts` is the preload-side bridge:
   loads this addon and exposes `window.nativeScreenCapture` (raw frames
   only -- see the corrected item 3 below for why). `src/world/screenShareAudio.ts`'s
   existing `getDisplayMedia` patch was extended (not a second, separate
   patch -- two independent `webFrame.executeJavaScript` injections would
   race on which finishes wrapping `getDisplayMedia` first) to call the
   bridge on Wayland instead of the original Chromium capture, build
   `VideoFrame`s from the raw frames and feed a `MediaStreamTrackGenerator`,
   and fall back to Chromium's own capture if the addon isn't available or
   its portal negotiation fails. `src/native/window.ts` gained a
   `screenShareSourcePicked` IPC handler so the "which app's audio" picker
   (previously driven by Chromium's `desktopCapturer` source id prefix)
   still works, now driven by the addon's own `onReady` source-type
   report instead.
3. **Why preload, not main process (corrected)**: frames are large
   (10-20MB each, tens of them per second). Routing them through
   `ipcRenderer`/`ipcMain` to the main process and back would mean
   serializing/copying multi-hundred-MB/s across an OS-level process
   boundary -- a new, self-inflicted bottleneck (or leak). Loading the
   addon in the preload/renderer process instead avoids that. **What
   this spike got wrong**: it isn't "no serialization at all" -- a real
   Electron security advisory (context-isolation bypass when a
   `VideoFrame` crosses `contextBridge`, GHSA-jfqg-hf23-qpw2) plus the
   fact that `MediaStreamTrack` isn't structured-clonable across the
   bridge at all means the `MediaStreamTrackGenerator`/`VideoFrame`
   objects can't be built in preload's isolated world and handed to the
   page as this spike assumed. Only *raw* frame data (a Buffer + plain
   width/height/stride/pixelFormat, all safely clonable) crosses the
   preload -> main-world boundary; `VideoFrame`/`MediaStreamTrackGenerator`
   are built in the main world instead, where `getDisplayMedia`'s patch
   already runs. That's still one real in-process memory copy per frame
   (via `contextBridge`'s structured clone), just not the OS-process IPC
   round trip this reasoning was correctly trying to avoid.
4. ~~**Render-test end to end**~~ -- DONE. Live-tested in a real `pnpm
   start` session: sharing a window renders correctly via the Rust
   capture path (confirmed no second Chromium portal dialog, real video
   showed up). Found and fixed one real bug along the way: Electron's
   `setDisplayMediaRequestHandler` callback throws (`TypeError: audio
   must be a WebFrameMain, "loopback" or "loopbackWithMute"`) on an
   *explicit* `audio: undefined` -- the key must be omitted entirely, not
   present-with-undefined. Two call sites in `src/native/window.ts` had
   this (one pre-existing, in the multi-source picker branch, unrelated
   to this session's changes but the same bug class -- fixed both).
5. **Dead end, don't retry**: tried to make the "which app's audio"
   picker unnecessary by reading the captured window's owning app-id
   directly, instead of asking. On this system (KDE/KWin), a *fully
   unrestricted* `pw-dump` shows the source node's `media.name` as
   `kwin-screencast-<app-id>` (e.g. `kwin-screencast-org.mozilla.firefox`)
   -- looks like a free win. It isn't: confirmed live (via a temporary
   `eprintln!` in the registry's `global` listener, since removed) that
   the *portal-restricted* PipeWire connection our addon actually uses
   (opened via `open_pipe_wire_remote`) exposes a deliberately reduced
   property set for that same node -- `object.serial`, `factory.id`,
   `client.id`, `node.name` ("kwin_wayland", the compositor itself, not
   the captured app), `media.class` -- with `media.name` stripped out
   entirely. This isn't a bug or a timing issue on our end -- it's the
   compositor deliberately keeping the sandboxed connection from
   revealing what it's capturing, the same privacy boundary that's the
   entire reason the audio-app picker exists in the first place (also
   confirmed absent from ashpd's own `Stream` type at the DBus/portal API
   level, checked directly in its source). No known way around this
   without cooperation from the portal/compositor itself -- see
   [flatpak/xdg-desktop-portal#1064](https://github.com/flatpak/xdg-desktop-portal/issues/1064),
   an open feature request for exactly this, unresolved as of this
   session.
6. **Packaging**: this crate currently only builds via plain `cargo
   build` + manually copying the `.so` to `.node`. For real packaging
   into the app (and CI), it needs the same treatment `node-pipewire`
   gets in `forge.config.ts` -- likely `@napi-rs/cli` for proper
   cross-arch `.node` output, plus a CI job (this system needed `rustup`,
   `pipewire-devel`, `clang-libs`, and `glibc-devel`/`gcc` installed from
   scratch -- the GitHub Actions `build-appimage` container will need the
   same).
7. **Multi-monitor / window-switch UX**: this spike only exercises "pick
   one source once." The real feature needs to handle what happens if
   the user shares a *different* window mid-session, resolution changes
   (a monitor's refresh rate/resolution can change while sharing), and
   what the picker UI looks like when it's *our* capture picking the
   source rather than Chromium's `desktopCapturer`.

## Local dev environment notes

This machine had none of the following installed; all were needed to get
`cargo build` working for this crate:

```
rustup (curl https://sh.rustup.rs | sh)
sudo dnf install -y pipewire-devel clang-libs glibc-devel gcc
```

Also needed at build time (bindgen couldn't find libclang's bundled
headers on its own on this system):

```
export BINDGEN_EXTRA_CLANG_ARGS="-I/usr/lib/clang/22/include"
```

(adjust the clang version number to whatever `rpm -q clang-libs` /
`ls /usr/lib/clang/` reports locally.)

To actually exercise the Electron wiring (item 2 above) in a local dev
`pnpm start`, `src/world/screenShareCapture.ts` loads the built addon from
a fixed path -- copy the build output there after every `cargo build`:

```
cargo build
cp target/debug/libscreen_capture.so index.node
```

(run from `native/screen-capture/`; `index.node` is gitignored). This is
dev-only -- see item 5, there's no real packaging yet.
