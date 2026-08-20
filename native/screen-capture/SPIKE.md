# Rust-owned screen capture -- spike notes

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

1. **Format mapping**: `FrameData.format` is the raw SPA video format id
   (currently observed as `12` on this system/compositor -- map the full
   enum, e.g. via `libspa::param::video::VideoFormat`, to the
   `VideoPixelFormat` strings `VideoFrame`'s constructor expects
   (`BGRX`/`BGRA`/`RGBX`/`RGBA`/etc -- SPA and WebCodecs don't use the same
   names, some formats have no WebCodecs equivalent and need a manual
   swizzle or a fallback rejection).
2. **Electron wiring**: a new `src/world/screenShareCapture.ts` (sibling
   to the existing `screenShareAudio.ts`) that:
   - `require()`s this addon directly in the preload/world context (NOT
     via IPC to the main process -- see below for why).
   - On the patched `getDisplayMedia()`, calls `startCapture()`, wraps
     each `FrameData` into a `VideoFrame` fed to a
     `MediaStreamTrackGenerator`'s writer, and returns a `MediaStream`
     built from the generator's `.track` instead of whatever Chromium's
     own `getDisplayMedia()` would have produced.
   - Calls `.stop()` on the capture handle when the share truly ends
     (same `liveRounds`-empty signal `screenShareAudio.ts` already uses).
3. **Why preload, not main process**: frames are large (10-20MB each,
   tens of them per second). Routing that through Electron IPC to the
   main process and back would mean serializing/copying multi-hundred-
   MB/s through `ipcRenderer`/`ipcMain` -- a new, self-inflicted
   bottleneck (or leak). Loading the addon straight in the preload script
   keeps capture and consumption (`MediaStreamTrackGenerator`) in the
   *same* process, frames handed over as plain in-process JS callback
   arguments, no serialization at all.
4. **Render-test end to end**: confirm a `<video>` fed from the resulting
   `MediaStreamTrack` actually shows a live, correct image inside the
   real app (not just a synthetic Node script) before touching the real
   `getDisplayMedia()` override in `src/world/screenShareAudio.ts`.
5. **Packaging**: this crate currently only builds via plain `cargo
   build` + manually copying the `.so` to `.node`. For real packaging
   into the app (and CI), it needs the same treatment `node-pipewire`
   gets in `forge.config.ts` -- likely `@napi-rs/cli` for proper
   cross-arch `.node` output, plus a CI job (this system needed `rustup`,
   `pipewire-devel`, `clang-libs`, and `glibc-devel`/`gcc` installed from
   scratch -- the GitHub Actions `build-appimage` container will need the
   same).
6. **Multi-monitor / window-switch UX**: this spike only exercises "pick
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
