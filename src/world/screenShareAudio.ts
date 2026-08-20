import { webFrame } from "electron";

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
// Same platform check virtualMic.ts uses on the main-process side --
// duplicated here (rather than imported) because that module also pulls
// in "electron"'s ipcMain/app, which only exist in the main process and
// would throw if evaluated from this preload/renderer-world file.
const isWayland =
  process.platform === "linux" &&
  (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);

const patchScript = /* js */ `
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

  // The one genuinely negotiated video track for the share currently in
  // progress (as opposed to a clone handed out for a later round -- see
  // getDisplayMedia below). Kept around so the "all rounds ended" path
  // can positively stop it even if the web app itself only ever stopped
  // clones it was handed, never this original.
  let realVideoTrack = null;

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
        stopActiveCapture();
        window.native.screenShareEnded();
      },
      { once: true },
    );
  }

  md.getDisplayMedia = async function (constraints) {
    let stream;

    if (IS_WAYLAND && realVideoTrack && realVideoTrack.readyState === "live") {
      // A later round of the share still in progress -- most commonly
      // the web app's own provisional -> confirmed handoff. Handing
      // back a *clone* of the still-running capture, instead of asking
      // Chromium to negotiate a brand new portal/PipeWire session,
      // avoids the leak above at its source rather than just cleaning
      // up after it: a clone shares the same underlying capture but has
      // its own independent stop(), so the app is free to stop() what
      // it thinks is the stale round without affecting this one -- and
      // no second negotiation ever happens for it to leak from. This
      // can only trigger while a share is still actively in progress
      // (realVideoTrack is cleared the moment every round has ended, in
      // the "ended" handler above), so a genuinely new, later share
      // always still gets its own fresh, real negotiation.
      stream = new MediaStream([realVideoTrack.clone()]);
    } else {
      stream = await originalGetDisplayMedia(constraints);
      realVideoTrack = stream.getVideoTracks()[0] || null;
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

// Runs unconditionally: on platforms/sessions where the virtual source
// was never created (Windows, macOS, X11), enumerateDevices() simply
// won't find a matching label and getDisplayMedia falls back to
// video-only, so this is a safe no-op there.
webFrame.executeJavaScript(patchScript).catch((err) => {
  console.error("[stoat] failed to install screen-share audio patch:", err);
});
