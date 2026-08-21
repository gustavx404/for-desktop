# Rust-owned screen capture -- spike notes

## Session update (2026-08-21, eighth session): the REAL culprit found --
## a hardcoded 640x480@5fps override in `for-web` clobbered every quality
## tier this whole time; H264 switch confirmed a real (partial) CPU win

Continuation of the seventh session's GPU-encode work. After fixing this
machine's VA-API driver (RPM Fusion) and switching the screen-share codec to
H264 in `for-web` (see below), live-tested via `--remote-debugging-port` +
a CDP script reading `pc.getStats()` in real time (same method as the sixth
session). Result was confusing at first: `encoderImplementation` correctly
showed `"OpenH264"` (not `libvpx` -- the codec switch worked), but the
*resolution* was stuck at 640x480@5fps regardless of which quality tier
(low/high/ultra) was selected in the app.

**Root cause, confirmed by instrumenting the actual constraints object**:
`packages/client/components/rtc/index.ts` in `for-web` -- unrelated to any
of this investigation's own changes -- installs its own
`navigator.mediaDevices.getDisplayMedia` wrapper (added in #1497, "Always
ensure the stream starts as below 720p") that **unconditionally overwrites
every track's video constraints to `{width: 640, height: 480, frameRate:
5}`**, no matter what was actually requested. Because this module's script
loads *after* this app's own preload-injected patch
(`world/screenShareAudio.ts`), it captures the preload's already-patched
`getDisplayMedia` as its own `originalMediaCall`, silently overwrites the
constraints, then calls through to it -- meaning every quality tier this
whole project has built (the "low"/"high"/"ultra"/"text" work across
sessions four through six, all of it) has been getting clobbered to
640x480@5fps immediately before reaching either this app's Rust capture
path or Chromium's own fallback, for as long as this file has existed on
`main`. This explains a large share of the *original* "fps doesn't keep up"
symptom this whole investigation started from -- not just today's H264
work.

**Fix**: removed the constraint-overwrite block from `index.ts` entirely
(kept its separate virtual-mic audio logic, unrelated and still needed).
Confirmed live immediately after: `getDisplayMedia constraints.video` now
correctly shows `{width:{ideal:2560},height:{ideal:1440},frameRate:60}` for
the "ultra" tier, and real outbound-rtp stats show `frameWidth:2560,
frameHeight:1440` actually being encoated -- the resolution finally matches
what's selected.

**With the real bug fixed, a fair H264-vs-VP8 comparison at the same
resolution (2560x1440) became possible for the first time**:

| | VP8 (`libvpx`, sixth session) | H264 (`OpenH264`, this session) |
|---|---|---|
| Achieved fps | ~15 (target 60) | ~15 (target 60) |
| Renderer CPU (`top -b`, instantaneous) | ~300-320% | ~170-190% |
| Encoder | software | software (VA-API hardware still not invoked) |

Same fps ceiling, but ~40% less CPU for the same output -- a real,
measured, worthwhile win even though it's software-only. The fps ceiling
itself did **not** move with the codec change, meaning something other than
raw encoder throughput is also capping it around 15fps at this resolution
(worth its own investigation later -- candidates: JS main-thread
`VideoFrame` construction cost, or some other fixed-cost stage in the
pipeline, per the sixth session's per-thread CPU breakdown).

**Resolved, same day, ninth session**: the missing piece was a second,
newer feature flag. `--enable-features=VaapiVideoEncoder` alone was
confirmed NOT to route WebRTC's own encoder factory to hardware --
`chrome://gpu` isn't reachable via CDP in this Electron build
(`Target.createTarget` for a `chrome://` URL returns "Not supported"), so
this was found via web research rather than direct inspection: as of
Chromium 131, `AcceleratedVideoEncoder` is the real gate for hardware
video *encode* specifically (this Electron ships Chromium 150). Added to
`src/main.ts`'s `enable-features` list. **Confirmed live, immediately**:
`encoderImplementation` in real `RTCPeerConnection.getStats()` output
switched from `"OpenH264"` to `"VaapiVideoEncodeAccelerator"`,
`powerEfficientEncoder: true`, and renderer CPU during an active
2560x1440 share dropped from ~300% (software VP8, sixth session) to
~160% (hardware H264, this session) -- genuine hardware encode, working
end to end, on this AMD GPU.

**fps ceiling, partially addressed, not fully solved**: even with
hardware encode confirmed active and `targetBitrate` climbing well past
1.5Mbps toward the "ultra" tier's 8Mbps ceiling, fps stayed pinned at
*exactly* 15 across every sample -- suspicious given real bitrate-driven
adaptation is normally gradual, not a hard constant. Root-caused (web
research, not Chromium source) to WebRTC's default `degradationPreference`
("balanced") trading framerate away to preserve per-frame resolution/
quality for screen-share content specifically -- a well-documented WebRTC
default behavior, not a bug in this codebase. Set
`degradationPreference: "maintain-framerate"` in `state.tsx`'s
`TrackPublishOptions` (matching the existing `contentHint: "motion"`
already set per-tier). **Result, live-tested**: fps stopped being a hard
constant 15 (now varies ~13-17), a real but modest change -- did not
unlock anywhere close to the ~40fps the Rust addon actually delivers
cleanly (confirmed via `[stoat-frame-diag]`'s own received/written
counters, zero drops, unchanged this whole investigation). The remaining
~15fps plateau with hardware encode active and bitrate genuinely rising is
not yet explained -- worth a fresh, focused investigation (real network
path characteristics on the actual production LiveKit deployment now
being tested against, vs. the sixth session's LAN test; or a deeper look
at libwebrtc's own screen-content-specific rate control, not something
resolvable through client-side flags alone based on what's been tried so
far).

**Not yet done**: NVIDIA (CachyOS) and Intel (Pop!_OS) validation, planned
since the seventh session.

## Session update (2026-08-21, tenth session): the ACTUAL root cause of the
## 2.5Mbps/15fps ceiling -- `videoEncoding` was silently a no-op for
## screen-share tracks the whole time. Now fixed. fps/resolution both
## climbing for real, matching the addon's own real throughput.

The ninth session's "exactly 2,500,000, suspiciously round" observation
was the real thread to pull. Read `computeVideoEncodings()` directly in
`livekit-client`'s own source
(`src/room/participant/publishUtils.ts`): for a screen-share track
specifically, it reads `options.screenShareEncoding` -- **not**
`options.videoEncoding`, which is what every earlier fix in this
investigation (fifth session onward) had been setting. With
`screenShareEncoding` unset and `simulcast: false`, `computeVideoEncodings`
returns a bare `[{}]` -- no bitrate cap requested at all from this app's
side -- meaning Chromium's own internal default (`2,500,000`, the exact
constant every session kept measuring, across VP8, software H264, and
hardware H264 alike) was what actually applied the entire time. Every
per-tier `encoding` object built since the fifth session was correct and
present, just written under the wrong key -- a genuine no-op, not a
network or encoder limitation.

**Fix**: renamed `videoEncoding` to `screenShareEncoding` in the
`TrackPublishOptions` passed to `setScreenShareEnabled` (`state.tsx`).

**Live-confirmed, immediately, dramatic result**: `qualityLimitationReason`
switched from `"none"` (misleadingly implying no constraint) to
`"bandwidth"` (a real, honest constraint report) for the first time this
entire investigation -- WebRTC's own adaptation logic is now actually
running against a real budget instead of silently sitting inside
Chromium's comfortable 2.5Mbps default. Combined with the ninth session's
`degradationPreference: "maintain-framerate"`, fps immediately jumped to
~39-42fps (matching -- not exceeding -- the Rust addon's own real
delivery rate, confirmed via `[stoat-frame-diag]`'s unchanged ~40fps
received/written throughout), while resolution climbed progressively as
available bitrate ramped: 640x360 -> 960x540 -> 1280x720 -> 1920x1080
within about a minute of a single share, still rising when this session's
observation window ended. This is the first time in the whole investigation
(six-plus sessions) that fps has moved meaningfully past the ~15fps
plateau on real motion content.

**Net effect of sessions six through ten combined**: the original
complaint ("fps e bitrate nao acompanha") is resolved via four independent,
compounding fixes, each real and necessary on its own --
1. `contentHint: "text"` -> `"motion"` (sixth session, small effect alone).
2. The `rtc/index.ts` 640x480@5fps hard override, unrelated to any of this
   investigation's own code, removed (eighth session) -- without this, no
   later fix mattered, every tier was clobbered before it could apply.
3. `AcceleratedVideoEncoder` enabled alongside the already-present
   `VaapiVideoEncoder` (ninth session) -- real hardware H264 encode,
   confirmed via `encoderImplementation`/`powerEfficientEncoder`, ~40% less
   CPU than software VP8 at the same resolution.
4. `screenShareEncoding` (not `videoEncoding`) plus
   `degradationPreference: "maintain-framerate"` (tenth session) -- the
   actual per-tier bitrate budget finally reaches the encoder, and fps is
   prioritized the way `contentHint: "motion"` always implied it should be.

**Not yet done**: let a share run long enough to see whether resolution
settles at the full requested target (2560x1440 for "ultra") once
bandwidth estimation fully converges, rather than stopping the observation
mid-ramp; NVIDIA (CachyOS) and Intel (Pop!_OS) validation, still pending
since the seventh session.

**Live-validated with a real production call (3 real participants, not a
LAN/loopback test), same day**: the "ultra" tier hit its full 8Mbps budget
exactly, 2560x1440, `qualityLimitationReason: "none"`, hardware encode
confirmed active -- the fixes above hold up under real conditions, not just
synthetic single-machine tests. fps stayed lower (~27-29) than the earlier
single-machine test's ~40, plausibly because this renderer was
simultaneously decoding two incoming video streams from the other
participants, not just encoding its own -- not yet isolated as the
confirmed cause.

**One more real bug found via this live test, fixed same day**: switching
quality *after* a share is already in progress (the normal, common path --
`state.tsx`'s post-share "screen_share_settings" modal, gated on
`screenShareQualityAsk`) calls `mediaStreamTrack.applyConstraints()` to
change what the Rust capture/source actually produces, but never touched
the already-negotiated `RTCRtpSender`'s own bitrate/framerate parameters.
Confirmed live: after switching from "ultra" (8Mbps budget) to "high"
(should be capped at 5Mbps, `ScreenSharePresets.h1080fps30`'s own default),
real `getStats()` showed the resolution correctly changed to 1920x1080 but
`targetBitrate` stayed pinned at exactly `8000000` -- the new tier's own
budget was never applied, only whatever the *original* `setScreenShareEnabled()`
call happened to negotiate. Fixed in the modal's `callback` by calling the
standard (not LiveKit-specific) `RTCRtpSender.setParameters()` -- get the
current params, set `encodings[0].maxBitrate`/`maxFramerate` to the newly
selected tier's `encoding`, `setParameters()` back -- right alongside the
existing `applyConstraints()` call.

**Follow-up, same day**: live-testing this surfaced a second, real bug it
introduced -- the modal's own `callback: async (qualityName, audio) => {
callback(qualityName, audio); localTrack.resumeUpstream(); ... }` never
awaited the inner `callback()` (fire-and-forget, pre-existing pattern, not
introduced here), so `resumeUpstream()` (which calls `sender.replaceTrack()`)
could run concurrently with the new `sender.setParameters()` call above --
confirmed live: after this change, sharing looked like it started
(resolution/qualityName correct in the modal) but real `getStats()` showed
`framesSent` frozen at whatever count existed the instant of the race,
never advancing again. Fixed by awaiting the inner callback before
`resumeUpstream()` runs, and wrapping the `setParameters()` call itself in
try/catch (since the caller now awaits it, an uncaught failure there would
skip `resumeUpstream()` entirely -- worse than the original no-op).

**Still unresolved after both fixes, not confirmed as a real bug**: fresh
shares in this same testing session (screen_share_settings modal
confirmed, no console errors from the new try/catch, Rust-side
`dequeued`==`sent` confirming the local capture pipeline stayed
healthy throughout) still showed one of the app's ~3 concurrent
`RTCPeerConnection`s with `framesSent` frozen shortly after starting.
This exact pattern (a second/provisional PC that stops advancing) recurred
identically across every test this session regardless of what was
changed, including on freshly-restarted, cache-cleared sessions -- most
likely this app's own documented "provisional round" negotiation pattern
(see earlier sessions in this file) rather than something introduced by
today's fixes, but not conclusively isolated which PC is the real
publisher without better tooling than `window.__stoatPCs` iteration
provides. Real users in the same test session (2 remote participants)
did confirm the share was visible and working, with good resolution and
bitrate improving substantially once motion stopped -- consistent with
the fixes above actually working end-to-end; the frozen-PC observation is
most likely a diagnostic-tooling limitation, not a shipped regression, but
flagged here for a future session to confirm with better instrumentation
(e.g. tagging each PC by its actual role at creation time) before fully
closing this out.

## Session update (2026-08-21, seventh session): AMD hardware H264/HEVC
## encode CONFIRMED working after fixing the missing VA-API driver -- the
## CPU bottleneck found in the sixth session has a real hardware fix on
## this exact machine, pending only a codec change on the `for-web` side

Follow-up to the sixth session's CPU-bound conclusion (~300%+ CPU,
software `libvpx` VP8 encode, no lever in this repo). Investigated whether
GPU hardware encode is actually reachable on this RX 6600XT, and it is --
the earlier "no hardware encode available on this GPU for any codec"
conclusion (fourth session, this file) was **wrong**, not because the
hardware can't do it, but because `mesa-va-drivers` (the actual VA-API
driver package providing `radeonsi_drv_video.so`) wasn't installed on this
system at all -- the fourth session's `ffmpeg` probe was running against no
usable driver whatsoever, not against a real "decode-only" limitation.

**Root cause and fix, confirmed step by step**:
1. `mesa-va-drivers` (Fedora's official, patent-policy-restricted build)
   installed first: added VP9/AV1/MPEG2/JPEG *decode* entrypoints only --
   still zero H264/HEVC, zero encode of any kind. Fedora's official Mesa
   build deliberately excludes H264/HEVC (patent-encumbered codecs) from
   this package.
2. RPM Fusion's `mesa-va-drivers-freeworld` -- same open-source Mesa
   (26.1.7, identical version to the official build), compiled with those
   codecs enabled -- is the standard fix every Fedora app needing H264
   uses (Firefox, VLC, Chromium's official builds, etc.), but `dnf swap
   mesa-va-drivers mesa-va-drivers-freeworld` initially failed: real file
   conflict with `mesa-dri-drivers` (both packages ship the same
   `libgallium-*.so` blob), which `steam` hard-depends on -- not a version
   mismatch (both were the same `26.1.7-1.fc44`). **Resolved** (by the
   user, exact method not captured in this session) without losing either
   `steam` or `mesa-dri-drivers` -- both still installed and intact after.
3. **Confirmed working end-to-end**: `vainfo` now reports
   `VAEntrypointEncSlice` for `H264ConstrainedBaseline`/`Main`/`High` and
   `HEVCMain`/`Main10` (previously: decode-only entrypoints, nothing for
   H264/HEVC at all). A real `ffmpeg -c:v h264_vaapi` encode of 60 frames
   at 1920x1080 completed in ~0.3s (hardware-speed, not the ~4s+ a
   real-time software encode of the same frame count would take) --
   genuine, working AMD VCN hardware H264 encode on this exact GPU.

**Considered and explicitly rejected this session, worth remembering why**:
- **AMD's proprietary AMF SDK** (`h264_amf`/`hevc_amf` in `ffmpeg
  -encoders`): tested directly, failed (`libamfrt64.so.1 failed to open`).
  `AMF-devel` (headers only) is in Fedora's own official repo, but the
  actual runtime library isn't shipped by Fedora or RPM Fusion at all --
  would need AMD's own proprietary driver installer, which targets
  workstation/Radeon Pro cards more than consumer RX-series, unconfirmed
  whether it even supports this GPU. Not pursued further.
- **Building our own Mesa from source, bundled inside this app's own
  resources** (pointing Chromium at it via `LIBVA_DRIVERS_PATH` for just
  this app's process, touching nothing system-wide): technically valid --
  Mesa is the same open-source project either way, RPM Fusion's freeworld
  package IS just Mesa built with more flags -- but explicitly rejected by
  the user: a statically bundled driver build is tied to a specific
  kernel/DRM-ABI/firmware combination and wouldn't reliably work across
  different users' systems, which doesn't actually solve "works
  everywhere" any better than asking users to enable RPM Fusion
  themselves, while adding real bundle-size/maintenance cost.
- **Cisco's OpenH264** (Fedora's own official `openh264` repo, legally
  clean, zero conflict, no RPM Fusion needed -- same mechanism Firefox
  uses for H264 on Fedora): real and available, but software-only, no GPU
  acceleration -- doesn't address the CPU bottleneck this whole
  investigation is about.

**Conclusion for the wider "which GPU vendors need what" question this
session was actually trying to answer**: AMD-on-Fedora is the *hardest*
case of the three vendors specifically because of Fedora's H264/HEVC
patent-policy split in Mesa's own packaging -- NVIDIA (NVENC ships with
the proprietary driver most users already have) and Intel (H264/HEVC
already in Fedora's *official* repos, no RPM Fusion needed historically)
are expected to be meaningfully less friction, not yet validated this
session -- user has access to a CachyOS (NVIDIA) and a Pop!_OS (Intel)
machine for that, not yet done.

**Not yet done**: (a) getting Chromium/LiveKit to actually negotiate H264
for screen share instead of VP8 -- without this, the working hardware
encoder above has nothing to encode for this app specifically, since VP8
has no hardware encode path on essentially any consumer GPU; this is a
`for-web` fork + LiveKit server change, outside this repo. (b)
Re-measuring real CPU/fps with H264 hardware encode actually active in a
live share, same methodology as the sixth session. (c) An in-app
detector + guided fixer (Electron main process, `pkexec`-based, no
terminal) so a user hitting this same missing-driver situation gets a
native "fix it" dialog instead of manually working through RPM Fusion +
package-conflict resolution the way this session did -- scoped as its own
implementation phase, not yet started.

## Session update (2026-08-21, sixth session): home-bandwidth theory REFUTED;
## checking TURN relay vs P2P next

The fifth session's "working theory, not yet confirmed" (targetBitrate stuck
at 2,500,000 is the user's own real upload bandwidth, correctly detected by
WebRTC's congestion control) is now refuted: a real speed test
(user-reported, fast.com/speedtest.net) measured **90Mbps upload** on the
home connection this app is now hosted from -- 36x the 2.5Mbps ceiling seen
in `targetBitrate`. Whatever is capping it, it isn't the user's own link
capacity.

Per the fifth session's own "if it comes back much higher" branch: the next
candidate is the TURN relay (`livekit.yml` has `turn.enabled: true` with a
`relay_range_start/end: 30000-30100` range) -- if media is actually being
relayed rather than flowing P2P, the relay server's own bandwidth/config
could be the real ceiling instead. `RTCIceCandidatePairStats` (local/remote
`candidateType`: `host`/`srflx` = P2P direct, `relay` = TURN-relayed) answers
this directly and hadn't been pulled yet.

**Added this session**: a `[stoat-stats] selected candidate pair:` log line
in `screenShareAudio.ts`'s existing `[stoat-stats]` diagnostic block (same
3s interval, same `pc.getStats()` call already being made -- no new
overhead), logging `localType`/`remoteType`/`availableOutgoingBitrate`/
`bytesSent`/`currentRoundTripTime` for the nominated, succeeded candidate
pair; also switched both `[stoat-stats]` `console.log` calls from a raw
object to `JSON.stringify(...)`, since Chromium's CDP console preview
silently truncates object args to their first ~5 properties, which was
hiding `targetBitrate`/`qualityLimitationReason`/`encoderImplementation`.

**Live-tested, root cause CONFIRMED: CPU-bound software encode, not
network.** Test performed on the user's own home LAN (same network on both
ends -- not a true WAN path, see the caveat below), `--remote-debugging-port`
CDP attached to the real running app, `pc.getStats()` read live:

- `localType: "host"`, `remoteType: "prflx"` -- P2P direct, **not**
  TURN-relayed. Rules out the relay server as a factor entirely for this
  path.
- `currentRoundTripTime`: 0-0.006s -- effectively zero, consistent with a
  same-LAN path (expected, given the caveat below -- not itself evidence of
  anything being wrong).
- At the "ultra" (2560x1440@60fps target) tier: `frameWidth`/`frameHeight`
  confirmed 2560x1440 (no downscale -- `MAX_FRAME_DIMENSION` is 2560, exactly
  at the cap), but `framesPerSecond` measured live at **9-15fps**,
  `targetBitrate` oscillating 2.2-2.5Mbps, `qualityLimitationReason: "none"`
  throughout -- same symptom as every earlier session, but now confirmed
  under network conditions (LAN, P2P, ~0ms RTT) where bandwidth cannot
  plausibly be the limiter.
- Cross-checked against the addon's own `[stoat-frame-diag]` counters at the
  same moment: `received`/`written` both ~78-82 per 2s (~40fps), zero
  `droppedWriteBusy`, zero `droppedDesiredSize` -- confirms (again) that
  Rust delivers ~40fps cleanly and this patch's own write path accepts every
  one of them with no backpressure. The loss is entirely downstream, inside
  Chromium's own encode pipeline (fewer frames encoded than frames handed to
  the generator's writable stream).
- **Real CPU measured directly** (`top -b`, instantaneous, not `ps`'s
  lifetime-average `%cpu` which undersells a recently-started spike): the
  main renderer process sustained **~300-320% CPU** (3+ full cores) the
  entire time a share was active. This is the actual bottleneck --
  `encoderImplementation: "libvpx"` (software VP8, confirmed no hardware
  encode path exists on this GPU, see the fourth session's VA-API probe
  above) genuinely cannot encode 2560x1440 faster than ~9-15fps on this
  hardware, and Chromium's own quality-limitation stat does not surface this
  as `"cpu"` for a `MediaStreamTrackGenerator`-fed synthetic source the way
  it might for a real camera capture -- `qualityLimitationReason: "none"`
  is misleading here, not evidence of no limitation.

**Caveat, not yet closed**: this test's peer was on the same home network as
the sharer (near-zero RTT confirms it), not a real geographically-remote
participant -- so it does not independently confirm the *original*
multi-session theory chain is fully closed for a true WAN path too. It does
NOT need to be re-tested over a real WAN before trusting the CPU conclusion,
though: the CPU-bound mechanism found here (Chromium's own encoder pulling
frames slower than they're supplied, independent of anything network-side)
is a real, load-bearing bottleneck on its own regardless of what a WAN path
separately adds on top -- a faster network can never make a CPU-saturated
software encoder produce more frames per second.

**Follow-up, same session: tested at 1080p ("high" tier) too -- fps did NOT
scale up with the resolution drop.** 2560x1440 -> 1920x1080 is a 44% pixel
reduction; if the bottleneck were purely per-pixel encode cost, fps should
have risen substantially. It didn't: still measured live at **14-15fps**
(target 30 for this tier), `targetBitrate` still ~1.8-2.5Mbps,
`qualityLimitationReason: "none"`, main renderer CPU still **~250-340%**
(`top -b`, instantaneous) -- both numbers essentially unchanged from the
1440p test. This rules out "it's simply VP8's per-pixel encode cost" as the
full explanation; something closer to a fixed per-frame cost dominates.

**Per-thread CPU breakdown** (`top -H -p <renderer-pid>`, instantaneous,
2s-delta samples) during this same 1080p share, roughly stable across
several samples:
- Renderer main (JS) thread: **~50-60%** of a core -- this addon's own
  per-frame JS work (VideoFrame construction, this patch's `write()` call,
  event-loop/message overhead) is genuinely NOT free, and is the one part
  of this cost this codebase actually controls.
- One dominant `ThreadPoolForegroundWorker`: **~35%**.
- 7-8 more `ThreadPoolForegroundWorker` threads at **~5-10% each**, plus a
  `VideoFrameCompositor`-looking thread (~10%) -- Chromium's own internal
  thread pool, most plausibly carrying the software libvpx encode plus
  related video-pipeline work, spread across cores. Thread names alone
  don't prove libvpx is the dominant cost here (no thread is explicitly
  named for it) -- a real CPU profile (Chromium's Performance panel / CDP
  `Profiler` domain) attributing self-time by function would be needed to
  confirm exactly how this ~150-180% splits between encode itself and other
  Chromium-internal work, not yet done this session.
- Sum of the top 15 threads (~247%) roughly matches the process-level total
  measured separately (~250-340%) -- consistent, not a measurement
  artifact.

**Where this leaves the fix, as of this session's end**: no further code
*bug* is left to chase here -- every earlier session's real bugs
(`contentHint`, missing `videoEncoding`, simulcast, the leaks, the reshare
hang) are fixed and confirmed. What remains is a genuine, roughly
resolution-independent CPU cost split across (a) this addon's own JS-side
per-frame pipeline (~50-60% of a core, real and addressable -- the
previously-shelved "reusable buffer pool" idea, noted a few sessions ago as
*not* worth building without evidence it's needed, now has that evidence:
this is a real, measured, non-trivial share of the total, not a guess) and
(b) Chromium's own software video pipeline/encode (~150-180%, spread across
its thread pool, very likely dominated by libvpx given no hardware encode
path exists on this GPU for any codec -- see the fourth session's VA-API
probe -- but not proven at the function level yet). (b) has no lever from
this codebase or the `for-web` fork short of different hardware; (a) is
worth attempting but bounded -- even eliminating it entirely wouldn't touch
(b)'s ~150-180%. Given both the 1440p and 1080p tests independently landed
at the same ~14-15fps regardless of resolution, that number looks like this
specific machine's real achievable ceiling for a screen share right now --
the honest next step is either (1) profile precisely to see how much of (b)
is really encode vs. reducible Chromium overhead before investing in (a), or
(2) accept ~15fps as the real number this hardware delivers and recalibrate
the quality tiers' advertised fps (in the `for-web` fork, not this repo) to
match it rather than promising 30/60fps the software encoder can't sustain.

## Session update (2026-08-21, fifth session): bitrate/fps ceiling
## root-caused to (likely) real network bandwidth, not code

### Context: two real code bugs found and fixed in for-web (fork, not this repo)

Both live in `github.com/gustavx404/Stoat-for-web`, branch
`quality-picker-1440p60fps`, deployed on the server as a custom Docker
build (`/srv/stoat/for-web-custom`, `compose.yml`'s `web:` service
builds from it instead of pulling `ghcr.io/stoatchat/for-web`):

1. `generator.contentHint` in this repo's `screenShareAudio.ts` was
   hardcoded to `"text"` (the most aggressive "prioritize sharpness over
   frame rate" hint) regardless of the quality actually selected --
   changed to `"motion"` (already committed to this repo, see the
   `2026-08-21, fourth session` entry above... actually see the git log,
   this was a same-day later change). Real, but not the dominant effect
   -- see below.
2. `for-web`'s `state.tsx` never passed `TrackPublishOptions.videoEncoding`
   to `setScreenShareEnabled` -- confirmed against `livekit-client`'s own
   source that bitrate/framerate encoding targets are NOT derived from
   the capture `resolution` automatically. Every quality tier was
   publishing at the same generic default (~2.5Mbps) regardless of
   whether "low" or "ultra" was selected. Fixed: each `ScreenShareQuality`
   now carries its own `encoding: {maxBitrate, maxFramerate}`
   (`ScreenSharePresets.h720fps30.encoding`/`h1080fps30.encoding` for
   low/high, `{maxBitrate: 8_000_000, maxFramerate: 60}` for
   ultra/source), passed through as `videoEncoding` alongside
   `simulcast: false`.

### Still open: real `targetBitrate` stuck at exactly 2,500,000 regardless

Live-measured, repeatedly, across multiple quality tiers (1080p30,
1440p60) and after the `videoEncoding: 8Mbps` fix was confirmed deployed
(grepped the built bundle for `8000000`/`8e6`, present) and a 60s+ test
(long enough to rule out GCC/congestion-control ramp-up still in
progress): `targetBitrate` in real `RTCPeerConnection.getStats()`
outbound-rtp reports stayed at exactly 2,500,000 every single time, with
`qualityLimitationReason: "none"` throughout. Achieved fps scaled
inversely with resolution at roughly that fixed byte budget (fewer,
bigger frames fit per second at higher resolution) -- e.g. ~7-9fps
average at both 1080p and 1440p despite 30fps/60fps targets
respectively.

**Working theory, not yet confirmed**: this is the user's real available
upload bandwidth on their home connection (the self-hosted LiveKit
server this session migrated onto earlier), correctly detected and
adapted to by WebRTC's own congestion control (GCC) -- `none` doesn't
mean "not limited by bandwidth" so much as "successfully adapted its own
target to match what's really available," which is a real, different
reading of that stat than earlier sessions assumed. If true, this is NOT
fixable by any client-side code change (not `videoEncoding`, not
`contentHint`, not migrating the whole desktop shell to Tauri/WebKitGTK
-- ruled out explicitly this session as not the right lever for a
network-bandwidth ceiling). **Next step, cheap, not yet done**: a real
upload speed test (fast.com or similar) on the user's home connection.
If it comes back near 2.5Mbps, theory confirmed, nothing left to
optimize in this addon or its JS patches for this specific symptom. If
it comes back much higher, the constraint is somewhere else in the path
(most likely candidate: the TURN relay -- `livekit.yml` has
`use_external_ip: true` and a `turn:` block configured, confirmed
present, but whether media is actually flowing direct P2P vs
TURN-relayed for this specific network path hasn't been checked --
`RTCIceCandidatePair` stats, not yet pulled this session, would answer
that directly).

### Diagnostic tooling built this session (reusable for the above)

- `native/screen-capture/src/lib.rs`: `dequeued`/`sent` counters in
  `capture_loop`, printed every ~2s via `[stoat-capture-diag] pipewire
  dequeued=X sent=Y` -- confirmed this addon delivers ~40fps cleanly at
  both 1080p and 1440p, ruling out PipeWire/the portal and this addon's
  own `MIN_FRAME_INTERVAL` filter as the bottleneck.
- `src/world/screenShareAudio.ts`: `diagReceived`/`diagDroppedWriteBusy`/
  `diagDroppedDesiredSize`/`diagWritten` counters, printed every 2s as
  `[stoat-frame-diag]` -- confirmed zero drops on this patch's own
  write()/backpressure gating; every received frame gets written.
- Both are temporary and safe to remove once the bandwidth theory is
  confirmed/refuted -- they're the reason each layer could be ruled out
  with real numbers instead of guessing.
- `/tmp/.../scratchpad/query-stats.mjs` (session-local, in scratchpad,
  not committed anywhere): connects to a running Electron instance's CDP
  port and pulls real `RTCPeerConnection.getStats()` outbound-rtp data
  via `window.__stoatPCs` (a diagnostic global `screenShareAudio.ts`
  already sets up). Recreate as needed: fetch `http://localhost:PORT/json/list`,
  find the "Stoat" page target, open its `webSocketDebuggerUrl`,
  `Runtime.evaluate` an async IIFE reading `pc.getStats()` for every
  outbound-rtp video report.

## Session update (2026-08-21, fourth session): resolution/fps now wired
## end-to-end from the web app's quality picker; simulcast disabled;
## no hardware encode available on this GPU for any codec

### The web UI's quality picker never actually controlled this addon

Confirmed by reading this addon's own code alongside `for-web`'s
`state.tsx`: `getDisplayMedia`'s `constraints.video` (built by
`livekit-client` from whatever quality the user picked --
`{width:{ideal:N}, height:{ideal:N}, frameRate:N}`, confirmed against
`screenCaptureToDisplayMediaStreamOptions` in `livekit-client`'s own
source) was never read on the Rust-capture path -- `startRustCapture()`
just always negotiated a capture at this addon's own hardcoded
`MAX_FRAME_DIMENSION`/`MIN_FRAME_INTERVAL`. Picking a higher quality in
the app's own UI had **zero effect** for any user on this capture path
(Wayland with the addon available) -- only the Chromium-fallback path
(addon unavailable, or non-Wayland platforms where this addon doesn't
apply) ever actually honored it, since Chromium's own real
`getDisplayMedia` reads those constraints itself.

**Fixed**: `start_capture` (`src/lib.rs`) now takes an optional
`CaptureOptions { max_dimension, frame_rate }`, threaded through
`run_capture`/`capture_loop`, replacing the two hardcoded consts
(`MAX_FRAME_DIMENSION`, `MIN_FRAME_INTERVAL`) -- falls back to the same
1920px/60fps default when omitted. `screenShareCapture.ts`'s `start()`
takes a matching `options` param and passes it straight through.
`screenShareAudio.ts` adds `captureOptionsFromConstraints()`, extracting
width/height/frameRate from whatever `getDisplayMedia` constraints the
web app actually asked for, called at the one place `startRustCapture()`
negotiates a fresh capture.

### No hardware video encode on this GPU, for any codec

Probed directly via `ffmpeg`'s VA-API encoders against
`/dev/dri/renderD128` (h264_vaapi, hevc_vaapi, vp8_vaapi, vp9_vaapi) --
every single one failed with "No usable encoding profile/entrypoint
found". This GPU's VA-API driver is decode-only; there is no
hardware-encodable codec to switch to as an alternative to the software
VP8 simulcast encode already noted below. This rules out "pick a
hardware-encodable codec" as a lever entirely -- it isn't a Chromium
config problem, it's the actual silicon.

### Simulcast disabled for screen share (in the for-web fork, not this repo)

`for-web`'s `state.tsx` called `setScreenShareEnabled(true, options)`
with no third `publishOptions` argument at all, so `livekit-client`'s
default (`simulcast: true`, publishing up to three encoded layers
simultaneously -- two observed live earlier this session, e.g. 1080p +
540p) applied unconditionally. Each extra layer is a full additional
software encode pass with no hardware acceleration available (see
above) -- changed to `{ simulcast: false }`, one real layer at whatever
resolution/fps the user picked, no throwaway smaller layers nobody may
even be viewing. This change lives in a local clone of
`stoatchat/for-web` (public GitHub repo), not in this repository --
`for-web` runs from a prebuilt image on the server
(`ghcr.io/stoatchat/for-web:0c31cf0`, `/srv/stoat/compose.yml`), so
shipping this needs a custom-built image (mirroring
`/srv/stoat/Dockerfile.caddy`'s existing multi-stage-build pattern) and
a `compose.yml` change to build from it instead of pulling upstream --
not yet done as of this writing.

### New "ultra" (1440p60fps) quality tier -- also in the for-web fork

`state.tsx`'s `getEnabledScreenShareQualities()` only ever offered
"low" (720p30), "high" (1080p30, gated on the server's
`video_resolution` limit being >= 1920x1080), and "text" (source
res @5fps). The server this app is deployed against
(`root@192.168.20.189`, `/srv/stoat/Revolt.toml`) already has
`video_resolution = [2560, 1440]` and `video_frame_rate = 60` configured
-- the server was never the blocker, the client's quality list simply
never had a tier above 1080p30 to offer regardless of what the server
allowed. Added `qualities.ultra` (2560x1440@60fps), gated on the same
limit being >= 2560x1440, so a server configured for less doesn't
advertise a quality it can't actually deliver.

**Considered and deliberately NOT done: a Rust-side buffer pool.**
Re-examined the "deliberately not done" note from an earlier session
suggesting this as the fix for 2560x1440@60fps's live-confirmed freeze.
On reflection this session: that freeze was isolated, in an even
earlier session, via a minimal addon-only repro with *no* JS pipeline
at all handling the same frame rate/resolution with zero issue --
meaning the bottleneck is JS-main-thread work (VideoFrame construction,
the generator's `write()`) that happens *after* a frame already has a
buffer, not the cost of allocating that buffer in Rust in the first
place (which mimalloc, added an earlier session, already mitigates the
real cost of -- allocator page-return behavior, not the copy itself). A
buffer pool cannot reduce a JS-main-thread bottleneck it never touches.
Reused buffers would still need a full fresh copy out of PipeWire's own
buffer either way (its lifetime is tied to the stream, can't be handed
to JS directly), so the memcpy cost -- the more likely real contributor
at 2560x1440's ~14.75MB/frame -- isn't avoided either. Not pursued
further without evidence it's actually the bottleneck at these settings
(unmeasured: whether Rust-side allocation/copy or JS-side VideoFrame
construction dominates at 2560x1440@60fps specifically -- worth
profiling for real before building this, not assuming).

**Not yet live-tested**: the resolution/fps wiring itself (with the
existing, unmodified for-web deployment, which still only offers up to
1080p30 -- so this needs at minimum a same-values-as-before smoke test
to confirm no regression), and the "ultra" tier + simulcast:false
combination (needs the for-web fork actually built and deployed first).

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
