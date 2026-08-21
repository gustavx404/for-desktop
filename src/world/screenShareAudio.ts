import { ipcRenderer, webFrame } from "electron";

import { sourceName } from "../constants";

/**
 * Electron's `setDisplayMediaRequestHandler` only supports `audio:
 * "loopback"` on Windows -- on Linux it's silently a no-op, so the
 * screen-share stream the page gets back from `getDisplayMedia()` never
 * has an audio track no matter how correctly the virtual PipeWire sink
 * (see `native/virtualMic.ts`) is wired up on the main-process side.
 *
 * The fix mirrors what Vesktop/venmic do: capture the virtual source as
 * a regular microphone via `getUserMedia()` and staple that track onto
 * the video-only stream. This has to run in the page's own JS context
 * (the "main world"), not this preload script's isolated world --
 * contextIsolation gives each its own `navigator`, so patching the one
 * in here wouldn't affect what the actual web app calls. `executeJavaScript`
 * is the one Electron API that reaches into the main world.
 */
function buildPatchScript(isWayland: boolean) {
  return /* js */ `
(() => {
  const SOURCE_NAME = ${JSON.stringify(sourceName)};
  // Only Wayland's portal/PipeWire capture path is known to leak native
  // buffers across repeated getDisplayMedia() negotiations -- Windows
  // and macOS use an entirely different, non-portal capture backend
  // that isn't affected, so the video-reuse path below only activates
  // here rather than changing behaviour anywhere it isn't needed.
  const IS_WAYLAND = ${JSON.stringify(isWayland)};
  const md = navigator.mediaDevices;
  if (!md || md.__stoatAudioPatched) return;
  md.__stoatAudioPatched = true;

  // Temporary diagnostic: logs real WebRTC outbound-video encoder stats
  // every few seconds for every RTCPeerConnection the page creates.
  // qualityLimitationReason ("cpu" vs "bandwidth" vs "none") and
  // encoderImplementation (a software codec name vs a hardware/VAAPI
  // one) answer "why is it laggy" directly instead of guessing at it
  // from the capture side, which -- as of this session -- is no longer
  // where the bottleneck has been shown to be. Safe to remove once
  // that's answered; doesn't change any behavior, only logs.
  if (window.RTCPeerConnection && !window.RTCPeerConnection.__stoatStatsPatched) {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    window.__stoatPCs = [];
    function StoatRTCPeerConnection(...args) {
      const pc = new OriginalRTCPeerConnection(...args);
      window.__stoatPCs.push(pc);
      const interval = setInterval(() => {
        if (pc.connectionState === "closed") {
          clearInterval(interval);
          return;
        }
        pc.getStats().then((stats) => {
          stats.forEach((report) => {
            if (report.type === "outbound-rtp" && report.kind === "video") {
              console.log("[stoat-stats] outbound video:", {
                frameWidth: report.frameWidth,
                frameHeight: report.frameHeight,
                framesPerSecond: report.framesPerSecond,
                framesSent: report.framesSent,
                framesEncoded: report.framesEncoded,
                qualityLimitationReason: report.qualityLimitationReason,
                bytesSent: report.bytesSent,
                targetBitrate: report.targetBitrate,
                encoderImplementation: report.encoderImplementation,
                powerEfficientEncoder: report.powerEfficientEncoder,
              });
            }
          });
        });
      }, 3000);
      return pc;
    }
    StoatRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
    StoatRTCPeerConnection.__stoatStatsPatched = true;
    window.RTCPeerConnection = StoatRTCPeerConnection;
  }

  const originalGetDisplayMedia = md.getDisplayMedia.bind(md);

  // Only one of these captures should ever be open at a time.
  // MediaStreamTrack.stop() is never automatic -- nothing about "the
  // page stopped using this stream" tears down the underlying capture,
  // and the calling web app has no way to know this extra track even
  // exists (it was stapled on from outside its own getDisplayMedia
  // call), so it can never be relied on to clean it up itself. Left
  // running, a stale capture from an earlier share keeps forwarding
  // whatever the virtual sink *currently* carries -- audio from
  // whatever app is linked in now, not what was chosen when that older
  // share started -- which is exactly what leaks other apps' audio (or
  // doubles up into an echo) into a share that picked one specific app.
  let activeMicStream = null;
  let activeMicDeviceId = null;
  let activeOutputTrack = null;
  // The WebAudio graph nodes stitched together for the current capture
  // (see below). Web Audio nodes that are part of a connected, active
  // graph are kept alive by the AudioContext's own audio-rendering
  // thread regardless of whether any JS variable still references them
  // -- letting a local variable just go out of scope does *not* free
  // them the way it would a plain object. Explicit .disconnect() in
  // stopActiveCapture() below is what actually releases each one;
  // without it, every capture opened over a long session (many shares,
  // many re-shares) leaves its old source/gain/destination nodes
  // permanently attached to the graph.
  let activeAudioNodes = null;

  // Handle id for the current Rust-owned capture (world/screenShareCapture.ts),
  // or null when the current share is using Chromium's own capture (the
  // addon wasn't available, or its portal negotiation failed -- see
  // startRustCapture below). Only ever set for the *original* negotiated
  // round, never a cloned later round -- see getDisplayMedia below.
  let activeCaptureHandleId = null;

  // Reused across captures rather than recreated -- a page is only
  // allowed a bounded number of live AudioContexts, and this one lives
  // for as long as the patch itself does.
  let audioCtx = null;

  // A fixed, constant boost instead of getUserMedia's autoGainControl.
  // AGC continuously re-targets its output loudness as the signal
  // changes, which for music/game audio (highly variable already, unlike
  // a voice mic AGC is tuned for) means the level it picks keeps
  // drifting on its own -- from the listening end that looked like the
  // volume jumping around independent of their own volume slider. A
  // flat multiplier has no such adaptive behaviour: whatever gain is
  // set here is exactly what goes out, every time.
  const FIXED_GAIN = 2.0;

  function stopActiveCapture() {
    if (!activeMicStream) return;
    for (const track of activeMicStream.getTracks()) track.stop();
    if (activeOutputTrack) activeOutputTrack.stop();
    if (activeAudioNodes) {
      for (const node of activeAudioNodes) node.disconnect();
    }
    activeMicStream = null;
    activeMicDeviceId = null;
    activeOutputTrack = null;
    activeAudioNodes = null;
  }

  // The web app does two getDisplayMedia() calls per share (a
  // provisional one, then a "confirmed" one once its own settings modal
  // closes) -- both ends of that pair get their own video track. Every
  // live video track (audio requested or not) is tracked here so the
  // *first* one ending (the provisional round being torn down as the
  // confirmed one starts) doesn't look like the share itself stopping.
  // Only once every round's video track has ended -- the set is empty --
  // do we know the user actually stopped sharing: that's when the mic
  // capture (if any) is released and the main process is told, so it
  // can stop routing audio into the now-unused virtual sink instead of
  // polling PipeWire for a share that no longer exists.
  const liveRounds = new Set();

  // The current round's video track for the share currently in progress
  // (updated every round when it's our own Rust capture, since each
  // round gets its own independent generator -- see createRustVideoTrack
  // above; only ever the *original* negotiated track for the Chromium
  // fallback path, where later rounds reuse a .clone() of it instead).
  // Kept around so the "all rounds ended" path can positively stop it
  // even if the web app itself only ever stopped a different round's
  // track, and so a later round can tell whether the still-live capture
  // it's about to reuse is ours or Chromium's.
  let realVideoTrack = null;
  let usingRustCapture = false;
  // When the *current* round's capture last (re)started -- used to bound
  // how long getDisplayMedia's reuse branch below trusts
  // realVideoTrack.readyState === "live". That check assumes our track
  // reliably flips to "ended" once the app is done with this round, but
  // confirmed live that it doesn't always: LiveKit's own unpublish (e.g.
  // from the user clicking "stop sharing") can silently stop consuming a
  // track without ever closing/erroring its writable stream on our end,
  // so readyState stays "live" forever with nothing left to notice. A
  // *deliberate new* share click after that looks identical to the
  // reuse-branch as the legitimate provisional -> confirmed handoff this
  // branch exists for -- the only real difference is timing: that handoff
  // is driven by the app's own code and, live, has always followed within
  // a couple seconds of the round it's replacing. A getDisplayMedia call
  // arriving well after that window is far more likely a genuinely new,
  // deliberate share -- treat it as one (force a fresh negotiation, which
  // also stops the old capture -- see startRustCapture) rather than
  // silently handing back a capture the app may have already abandoned.
  let lastCaptureStartedAt = 0;
  const REUSE_WINDOW_MS = 10000;

  // The real, definitive signal that the user stopped sharing: confirmed
  // live that our own track's 'ended' event and writable-stream failures
  // (both tried above/below) don't reliably fire when LiveKit unpublishes
  // -- it can stop consuming a track without ever closing or erroring the
  // stream on our end. What LiveKit's client library *does* do reliably,
  // confirmed live, is log "unpublishing track" (via its own internal
  // logger, livekit-client.esm.mjs) the moment the app tells it to stop
  // sending a track -- that's a real, synchronous, third-party signal
  // (not this app's own bundled/obfuscated code, so far less likely to
  // silently change shape) that this round is genuinely over. Wrapping
  // console.log to catch it and end our own track on cue turned out to be
  // the only reliable way found to know the app's own "share" button
  // ever becomes clickable again -- confirmed live that without this, it
  // never re-enters the getDisplayMedia patch at all on a second share
  // attempt (the app's own UI state depends on our track's 'ended' event
  // the same way this patch's cleanup does).
  const originalConsoleLog = console.log;
  console.log = function (...args) {
    if (args[0] === "unpublishing track" && realVideoTrack && realVideoTrack.readyState === "live") {
      realVideoTrack.stop();
    }
    return originalConsoleLog.apply(console, args);
  };

  function trackShareRound(stream) {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    // The provisional round's track is never stopped by anyone: the web
    // app just drops its reference once the confirmed round replaces
    // it, and MediaStreamTrack.stop() is never automatic -- a track
    // nobody calls .stop() on keeps its native capture (the actual
    // screen-grab session, with all the GPU/shared-memory frame buffers
    // backing it) running indefinitely, invisible to JS heap stats
    // since none of that lives on the V8 heap. Left alone this
    // compounds on every single share (each one abandons its own
    // provisional round the same way), which is exactly what showed up
    // as memory that kept climbing further with every share and never
    // came back down. Explicitly stopping any round still marked live
    // the moment a fresh one starts -- rather than waiting on an
    // "ended" event that this specific track will never fire --closes
    // that gap without depending on the web app's own cleanup.
    for (const oldTrack of liveRounds) {
      if (oldTrack !== videoTrack) oldTrack.stop();
    }
    liveRounds.clear();

    liveRounds.add(videoTrack);
    videoTrack.addEventListener(
      "ended",
      () => {
        liveRounds.delete(videoTrack);
        if (liveRounds.size > 0) return;
        // Belt-and-braces: whatever the app actually stopped (the
        // original or a clone of it), make sure the real underlying
        // capture is stopped too rather than assuming it already was.
        if (realVideoTrack) {
          realVideoTrack.stop();
          realVideoTrack = null;
        }
        if (activeCaptureHandleId != null) {
          window.nativeScreenCapture.stop(activeCaptureHandleId);
          activeCaptureHandleId = null;
        }
        usingRustCapture = false;
        currentWriter = null;
        stopActiveCapture();
        window.native.screenShareEnded();
      },
      { once: true },
    );
  }

  // Builds a video track from world/screenShareCapture.ts's Rust-owned
  // capture instead of asking Chromium to negotiate one -- the whole
  // point of this addon (see native/screen-capture/SPIKE.md): Chromium's
  // own desktop-capture pipeline is what leaks native GPU/shared-memory
  // buffers across repeated getDisplayMedia() calls, with no public API
  // able to reclaim them short of restarting the renderer process. Frames
  // arrive here as plain data (a Buffer + width/height/stride/pixelFormat)
  // -- never a VideoFrame or MediaStreamTrack -- because Electron's
  // contextBridge can't safely carry either of those (MediaStreamTrack
  // isn't structured-clonable at all; bridging a VideoFrame is a known
  // context-isolation bypass, GHSA-jfqg-hf23-qpw2). Building the actual
  // WebCodecs objects here, in the same world that consumes them, avoids
  // both problems entirely.
  //
  // Resolves null (never rejects) if the addon isn't available or its
  // portal negotiation fails, signalling the caller to fall back to
  // Chromium's own (leakier, but working) capture -- a screen share
  // should never just break because this addon isn't built for this
  // platform/arch yet.
  // world/screenShareCapture.ts hands this world a MessagePort once, up
  // front, via window.postMessage -- listened for here, once, rather than
  // inside startRustCapture, since the port itself doesn't depend on a
  // capture being active. Frames travel over this port (transferred, not
  // cloned -- contextBridge itself has no transfer support, confirmed
  // against electron/electron#27024) rather than through a
  // contextBridge-proxied callback.
  let framePort = null;
  const framePortReady = new Promise((resolve) => {
    window.addEventListener("message", function onPortMessage(event) {
      if (event.data !== "stoat-screen-capture-port" || !event.ports[0]) {
        return;
      }
      window.removeEventListener("message", onPortMessage);
      framePort = event.ports[0];
      resolve();
    });
    // Only ask for the port once this listener is actually registered --
    // window.postMessage delivers to whoever's listening at that exact
    // moment, nothing queues it for a listener that attaches later.
    if (window.nativeScreenCapture) window.nativeScreenCapture.requestFramePort();
  });

  // Frames always go to whichever round's track is the current one from
  // the web app's perspective -- NOT necessarily the one created first.
  // createRustVideoTrack() (below) repoints this on every round, fresh
  // and reused alike; framePort.onmessage (set up once, right after the
  // port itself is ready) always writes to whatever it currently points
  // to. This used to be handled by MediaStreamTrackGenerator's own
  // .clone() for reused rounds instead -- confirmed live that was wrong:
  // clones apparently share their writable stream with the original, so
  // stopping an old round's clone (trackShareRound's own cleanup, above)
  // closed the *original* generator's writer too, silently breaking every
  // future write ("InvalidStateError: ... Stream closed") for the rest of
  // the share. A fresh, independent generator per round -- all fed by the
  // same ongoing Rust capture, no reason to renegotiate anything -- has
  // no such shared state to break.
  let currentWriter = null;
  let writeBusy = false;
  let loggedUnsupportedFormat = false;
  // Used to give each VideoFrame a real duration (below) instead of
  // leaving it unset -- LiveKit/WebRTC's own frame-rate detection and
  // pacing use it, same as any other video source's actual frame timing
  // would. Reset per-round (createRustVideoTrack) since a duration
  // spanning a track swap wouldn't mean anything.
  let lastTimestampUs = null;

  framePortReady.then(() => {
    framePort.onmessage = (event) => {
      const frame = event.data;
      if (!currentWriter) return;
      // NOTE: deliberately NOT treating realVideoTrack.enabled === false as
      // "this round ended" (an earlier version of this check did, and it
      // was wrong). Read stoat-web's own source (packages/client/components/
      // rtc/state.tsx, toggleScreenshare()): the app calls
      // localTrack.pauseUpstream() right after starting a share, while its
      // quality-picker UI is up, then resumeUpstream() once the user
      // confirms -- a normal, temporary pause, not an end. Also, critically:
      // that same code attaches an "ended" listener that calls
      // toggleScreenshare(), meaning *any* real 'ended' this
      // patch fires on realVideoTrack is treated by the app as "the user
      // closed the shared window" and fully stops the share. Confirmed live
      // that the .enabled-based check above was firing during that normal
      // pause, incorrectly ending the round and desyncing the app's own
      // "am I sharing" state from LiveKit's actual published-track state --
      // which is exactly what made a *second*, genuinely new share attempt
      // silently do nothing afterwards. Only end the round on signals that
      // really do mean "the stream is gone" -- the checks above (write
      // failure, desiredSize null) -- never on ambiguous ones.
      if (!frame.pixelFormat) {
        if (!loggedUnsupportedFormat) {
          loggedUnsupportedFormat = true;
          console.error(
            "[stoat] screen capture: compositor negotiated a pixel format with no WebCodecs equivalent, dropping frames:",
            frame.format,
          );
        }
        return;
      }
      if (writeBusy) return;
      // currentWriter.write()'s returned promise resolves as soon as the
      // frame is handed to Chromium's own internal media pipeline, NOT
      // when it's actually been encoded and sent -- confirmed live: with
      // every VideoFrame correctly close()d (see below) and capture
      // throttled to ~15fps, native/off-heap memory still climbed
      // continuously during a share (RSS 540MB -> 1.5GB in ~43s) with no
      // matching growth in the JS heap, meaning Chromium's own
      // encode/send queue was still backlogging faster than this app's
      // self-hosted LiveKit server can actually drain it (SPIKE.md
      // separately measured that real path at ~950kbps). desiredSize is
      // the actual WHATWG Streams backpressure signal for this writer --
      // <= 0 means its internal queue is already full, i.e. the pipeline
      // genuinely can't take more right now, regardless of whether the
      // last write()'s promise has resolved yet. Skipping the frame
      // here (same as the writeBusy/pixelFormat drops above) means it's
      // simply never constructed -- nothing to leak.
      if ((currentWriter.desiredSize ?? 1) <= 0) return;
      writeBusy = true;
      const timestamp = Math.round(performance.now() * 1000);
      const vf = new VideoFrame(frame.data, {
        format: frame.pixelFormat,
        codedWidth: frame.width,
        codedHeight: frame.height,
        timestamp,
        // How long the *previous* frame was actually on screen for --
        // the only real duration available at the moment a frame
        // arrives is how long the last one lasted, not this one's
        // (which isn't known yet). Left unset (undefined) for the
        // first frame, since there's no prior interval to report.
        duration: lastTimestampUs == null ? undefined : timestamp - lastTimestampUs,
        layout: [{ offset: 0, stride: frame.stride }],
      });
      lastTimestampUs = timestamp;
      // write() does NOT take ownership of vf or close it -- confirmed
      // live via CDP instrumentation (wrapped VideoFrame counting
      // constructs vs .close() calls): with no explicit close() here,
      // every single frame written stayed alive forever (0 closes across
      // hundreds of live frames), which is exactly what was showing up as
      // RAM climbing during a share and never coming back down, fast
      // enough to swap/freeze the whole system within seconds. Same
      // ownership rule as WebCodecs' VideoEncoder.encode(): the caller
      // must close() every frame it constructs once done with it,
      // regardless of what a write()/encode() call does with it
      // internally. Closing after write() settles (rather than
      // immediately after the write() call) makes sure the sink has
      // actually consumed it first; calling close() on an
      // already-closed frame is a documented no-op, so this is safe even
      // if some future browser version *does* close it internally too.
      currentWriter
        .write(vf)
        .catch((err) => {
          console.error(
            "[stoat] screen capture: failed to write frame",
            err && err.name,
            err && err.message,
          );
          // The writable stream being closed means this round's track is
          // already dead on the consuming end (e.g. LiveKit unpublished
          // it) -- confirmed live that this can happen *without* the
          // track's own 'ended' event ever firing (LiveKit's unpublish
          // doesn't always call the underlying MediaStreamTrack's own
          // stop()), which otherwise left the Rust capture thread running
          // forever, producing frames nobody could ever write again.
          // Calling stop() here on the track WE own is always safe (a
          // no-op if already ended) and, since it's a real MediaStreamTrack,
          // synchronously fires the 'ended' listener trackShareRound
          // already set up -- reusing its existing cleanup (stopping the
          // Rust capture, releasing mic audio, notifying the main
          // process) rather than duplicating any of that logic here.
          if (err && err.name === "InvalidStateError" && realVideoTrack) {
            realVideoTrack.stop();
          }
        })
        .finally(() => {
          vf.close();
          writeBusy = false;
        });
    };
  });

  // Creates a fresh, independent video track for the current round,
  // pointed at whatever the ongoing Rust capture is currently producing
  // -- used both for the very first round of a share and for every
  // later round reusing that same capture (see the "shared writable"
  // comment above for why a plain .clone() doesn't work for reuse here).
  function createRustVideoTrack() {
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    // Without this, the WebRTC encoder has no signal that this is screen
    // content (sharp text/UI, mostly static) rather than a camera feed
    // (motion-heavy, blur-tolerant) -- it defaults to encoding settings
    // tuned for the latter, which is exactly what reads as "low bitrate,
    // blurry/blocky" on the viewing end even though nothing about the
    // capture itself changed. Chromium's own desktopCapturer-backed
    // tracks get this hint automatically; a MediaStreamTrackGenerator
    // does not, so it has to be set explicitly here.
    generator.contentHint = "text";
    currentWriter = generator.writable.getWriter();
    writeBusy = false;
    lastTimestampUs = null;
    return generator;
  }

  // Negotiates the Rust capture once (via world/screenShareCapture.ts's
  // addon bridge) -- does not itself create a video track, see
  // createRustVideoTrack() above for that. Resolves null (never rejects)
  // if the addon isn't available or its portal negotiation fails,
  // signalling the caller to fall back to Chromium's own (leakier, but
  // working) capture -- a screen share should never just break because
  // this addon isn't built for this platform/arch yet.
  async function startRustCapture() {
    if (!window.nativeScreenCapture) return null;
    if (!(await window.nativeScreenCapture.isAvailable())) return null;
    await framePortReady;

    // Safety net: getDisplayMedia's reuse branch above (checking
    // realVideoTrack.readyState === "live") is *supposed* to mean this
    // only ever runs once per share -- but confirmed live that it can
    // still fire again on the same share (the web app retrying after a
    // write failure, or some other path this reuse check doesn't catch),
    // and every time it does, activeCaptureHandleId below is
    // overwritten with nothing left pointing at the *previous* handle to
    // ever stop() it. That orphaned capture's thread (and the whole
    // tokio runtime backing it) then runs forever, continuing to
    // producer frames that race the new one for the same currentWriter
    // -- confirmed live via a leaked-thread counter (66 -> 220+ threads
    // across a handful of rounds) and a flood of "failed to write frame"
    // DOMExceptions once enough orphaned writers were racing each other.
    // Explicitly stopping any still-active previous handle here, right
    // before negotiating a new one, closes that leak regardless of why
    // the reuse check above didn't catch it this time.
    if (activeCaptureHandleId != null) {
      window.nativeScreenCapture.stop(activeCaptureHandleId);
      activeCaptureHandleId = null;
    }
    lastCaptureStartedAt = Date.now();

    return new Promise((resolve) => {
      let settled = false;

      window.nativeScreenCapture
        .start(
          (sourceType) => {
            if (settled) return;
            settled = true;
            resolve({ sourceType });
          },
          (message) => {
            console.error("[stoat] native screen capture error:", message);
            if (!settled) {
              settled = true;
              resolve(null);
            } else if (realVideoTrack) {
              // Fatal error after the capture had already started -- end
              // the current round's track so the existing "ended" cleanup
              // path (trackShareRound below) takes over.
              realVideoTrack.stop();
            }
          },
        )
        .then((handleId) => {
          if (handleId == null) {
            if (!settled) {
              settled = true;
              resolve(null);
            }
            return;
          }
          activeCaptureHandleId = handleId;
        });
    });
  }

  md.getDisplayMedia = async function (constraints) {
    let stream;
    let rustSourceType = null;

    if (
      IS_WAYLAND &&
      usingRustCapture &&
      realVideoTrack &&
      realVideoTrack.readyState === "live" &&
      Date.now() - lastCaptureStartedAt < REUSE_WINDOW_MS
    ) {
      // A later round of the share still in progress (most commonly the
      // web app's own provisional -> confirmed handoff), still backed by
      // our own still-running Rust capture: createRustVideoTrack() gives
      // this round its own independent generator (see its own comment
      // for why a plain .clone() doesn't work for this) fed by that same
      // capture -- no second portal negotiation, same as the plain-clone
      // path below was already trying to achieve for the Chromium
      // fallback case. Audio routing was already decided (see
      // pickScreenShareAudio below) when the original round negotiated
      // -- it only ever runs once per share, not on every round.
      stream = new MediaStream([createRustVideoTrack()]);
      realVideoTrack = stream.getVideoTracks()[0];
    } else if (IS_WAYLAND && realVideoTrack && realVideoTrack.readyState === "live") {
      // Same situation, but for the Chromium fallback path (addon
      // unavailable or its negotiation failed for this share): a plain
      // .clone() has its own independent stop(), so the app is free to
      // stop() what it thinks is the stale round without affecting this
      // one -- and no second negotiation ever happens for it to leak
      // from. realVideoTrack deliberately stays pointed at the original
      // here (not the clone), see its own comment above.
      stream = new MediaStream([realVideoTrack.clone()]);
    } else {
      const rustCapture = IS_WAYLAND ? await startRustCapture() : null;
      usingRustCapture = !!rustCapture;
      if (rustCapture) {
        stream = new MediaStream([createRustVideoTrack()]);
        rustSourceType = rustCapture.sourceType;
      } else {
        stream = await originalGetDisplayMedia(constraints);
      }
      realVideoTrack = stream.getVideoTracks()[0] || null;

      // Only when this round's video came from our own capture: the
      // main process needs to know whether it's a window (to decide
      // whether to show the "which app's audio" picker) since it can no
      // longer derive that itself from Chromium's desktopCapturer id --
      // our own portal negotiation picked the source this time, not
      // Chromium's. When the fallback path above was used instead, the
      // main process already resolved this as part of producing the
      // response originalGetDisplayMedia() just resolved from, so no
      // extra round trip is needed there.
      if (rustCapture && constraints && constraints.audio) {
        await window.native.pickScreenShareAudio({
          isWindow: rustSourceType === "window",
        });
      }
    }

    trackShareRound(stream);

    if (!constraints || !constraints.audio) return stream;

    try {
      const devices = await md.enumerateDevices();
      const virtualMic = devices.find(
        (d) => d.kind === "audioinput" && d.label.includes(SOURCE_NAME),
      );
      if (!virtualMic) return stream;

      // Chromium's PipeWire-backed audio capture graph isn't fully
      // reliable across rapid open/close cycles on this platform -- a
      // fresh getUserMedia() can come back reporting a "live" track
      // that silently carries no audio, only fixable by a full page
      // reload. Reusing the still-live capture from moments ago when
      // it's for the same device sidesteps that churn instead of
      // triggering it twice per share.
      const rawTrack = activeMicStream?.getAudioTracks()[0];
      const reusable =
        activeMicDeviceId === virtualMic.deviceId &&
        rawTrack?.readyState === "live" &&
        activeOutputTrack?.readyState === "live";

      if (reusable) {
        stream.addTrack(activeOutputTrack);
      } else {
        stopActiveCapture();
        const micStream = await md.getUserMedia({
          audio: {
            deviceId: { exact: virtualMic.deviceId },
            // this is other apps' audio, not a real mic input -- echo/
            // noise/gain processing meant for speech mangles music/game
            // audio (autoGainControl in particular keeps re-targeting
            // its output level as the signal changes, which reads as the
            // volume drifting on its own). The fixed WebAudio gain stage
            // below handles loudness instead, with a constant multiplier.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        activeMicStream = micStream;
        activeMicDeviceId = virtualMic.deviceId;

        const audioTrack = micStream.getAudioTracks()[0];
        if (audioTrack) {
          if (!audioCtx) audioCtx = new AudioContext();
          if (audioCtx.state === "suspended") await audioCtx.resume();

          const source = audioCtx.createMediaStreamSource(
            new MediaStream([audioTrack]),
          );
          const gainNode = audioCtx.createGain();
          gainNode.gain.value = FIXED_GAIN;
          const destination = audioCtx.createMediaStreamDestination();
          source.connect(gainNode).connect(destination);
          activeAudioNodes = [source, gainNode, destination];

          activeOutputTrack = destination.stream.getAudioTracks()[0];
          stream.addTrack(activeOutputTrack);
        }
      }
    } catch (err) {
      console.error("[stoat] failed to attach screen-share audio:", err);
    }

    return stream;
  };
})();
`;
}

// process.env in a preload script does not reliably reflect the launching
// shell's environment (confirmed empirically: WAYLAND_DISPLAY/
// XDG_SESSION_TYPE read as unset here even in a real Wayland session) --
// asking the main process, which does see the real environment, is the
// same workaround world/window.ts's own isWayland() already uses for
// exactly this reason. This runs unconditionally: on platforms/sessions
// where the virtual source was never created (Windows, macOS, X11),
// enumerateDevices() simply won't find a matching label and
// getDisplayMedia falls back to video-only, so this is a safe no-op there.
ipcRenderer
  .invoke("getIsWayland")
  .then((isWayland: boolean) =>
    webFrame.executeJavaScript(buildPatchScript(isWayland)),
  )
  .catch((err) => {
    console.error("[stoat] failed to install screen-share audio patch:", err);
  });
