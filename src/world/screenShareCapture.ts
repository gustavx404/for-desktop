import { createRequire } from "node:module";
import { join } from "node:path";

import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload-side bridge to native/screen-capture (see its SPIKE.md): a Rust
 * NAPI addon that captures Wayland screen/window frames directly via the
 * portal + PipeWire, bypassing Chromium's own desktop-capture pipeline --
 * the pipeline diagnosed as the source of screen-share's native memory
 * leak. This file only relays *raw* frame data (a Buffer + plain
 * width/height/stride/pixelFormat) to whichever main-world script asks
 * for it (see world/screenShareAudio.ts) -- it deliberately does not
 * construct `VideoFrame`/`MediaStreamTrackGenerator` itself. Those are
 * Web Platform objects, and Electron's contextBridge cannot safely carry
 * them: `MediaStreamTrack` isn't structured-clonable across the bridge at
 * all, and passing a `VideoFrame` across it is a known context-isolation
 * bypass (see GHSA-jfqg-hf23-qpw2). Plain data (Buffer + numbers/strings)
 * has none of that risk, so that's all that crosses here -- the actual
 * WebCodecs objects get built in the main world, where they're consumed.
 *
 * Frames themselves don't cross via contextBridge at all, though --
 * confirmed against electron/electron#27024 (an Electron maintainer's own
 * answer), contextBridge always structurally *clones* its arguments, with
 * no way to opt into a real transfer. At 1920x1080 BGRA and tens of
 * frames a second, cloning every frame is itself a multi-hundred-MB/s
 * main-thread cost -- exactly what was making the whole app freeze once
 * frames actually started flowing for real. `window.postMessage` (a
 * plain DOM API, usable directly between the preload's isolated world
 * and the main world, entirely separate from contextBridge) *does*
 * support a genuine zero-copy ArrayBuffer transfer, same as
 * `Worker.postMessage`. A `MessageChannel` set up once below, with one
 * port hand off to the main world via `window.postMessage`, is what
 * frames actually travel over -- see world/screenShareAudio.ts for the
 * receiving end.
 */

interface NativeFrame {
  data: Buffer;
  width: number;
  height: number;
  stride: number;
  format: number;
  pixelFormat: string | null;
}

interface NativeCaptureHandle {
  stop(): void;
}

interface NativeCaptureOptions {
  maxDimension?: number;
  frameRate?: number;
}

interface ScreenCaptureAddon {
  startCapture(
    onReady: (err: Error | null, sourceType: string | null) => void,
    onFrame: (err: Error | null, frame: NativeFrame) => void,
    onError: (err: Error | null, message: string) => void,
    options?: NativeCaptureOptions,
  ): NativeCaptureHandle;
}

let addon: ScreenCaptureAddon | null = null;

async function loadAddon() {
  // process.env in a preload script does not reliably reflect the
  // launching shell's environment (confirmed empirically: WAYLAND_DISPLAY/
  // XDG_SESSION_TYPE read as unset here even in a real Wayland session) --
  // asking the main process, which does see the real environment, is the
  // same workaround world/window.ts's own isWayland() already uses for
  // exactly this reason.
  const isWayland = await ipcRenderer.invoke("getIsWayland");
  if (!isWayland) return;
  try {
    // Dev-only: built via `cargo build` in native/screen-capture and
    // copied to index.node -- see SPIKE.md "Local dev environment notes".
    // Real packaging (napi-rs CLI, cross-arch builds, a Rust toolchain in
    // CI) doesn't exist yet, so this deliberately only works in a local
    // dev checkout for now; failing to load here just means screen share
    // falls back to Chromium's own (leaky, but working) capture path.
    //
    // Node's ESM loader has no handler for the `.node` extension --
    // `import()` throws `ERR_UNKNOWN_FILE_EXTENSION` for it (confirmed
    // live). Only the CJS `require()` loader understands native addons;
    // `createRequire` is the standard way to get one from ESM.
    const addonPath = join(process.cwd(), "native/screen-capture/index.node");
    // import.meta.url is unusable as createRequire's base here -- in this
    // bundled preload script it resolves to the *page's* remote origin
    // (e.g. "https://.../preload.js"), not this script's real local path,
    // so createRequire() rejects it outright. addonPath itself is already
    // an absolute filesystem path, which createRequire accepts directly
    // as a base with no resolution needed for the require() call below
    // (also absolute).
    const require = createRequire(addonPath);
    addon = require(addonPath) as ScreenCaptureAddon;
  } catch (err) {
    console.log(
      "[stoat] native screen-capture addon failed to load -- screen share will use Chromium's own (leakier) capture:",
      err,
    );
  }
}

const handles = new Map<number, NativeCaptureHandle>();
let nextHandleId = 1;

const loaded = loadAddon();

// One MessageChannel for the whole life of this preload script -- handed
// to the main world once, up front, rather than per-capture, since
// setting it up doesn't depend on a capture actually being active.
// `window.postMessage(..., [port])` is what actually transfers the port
// itself into the main world; the main-world end (world/screenShareAudio.ts)
// listens for this exact message once to pick it up. The transfer itself
// only happens on demand (requestFramePort below), not eagerly at preload
// load time -- window.postMessage delivers to whatever's listening *right
// then*, with no queueing for a listener that attaches later, and the
// main world doesn't start listening until its own (async-gated) patch
// script has run. Sending eagerly here raced that and regularly lost the
// port entirely, silently breaking every screen share (confirmed live).
// Letting the main world ask for it once it's actually listening removes
// the race by construction.
const { port1: framePort, port2: mainWorldPort } = new MessageChannel();

contextBridge.exposeInMainWorld("nativeScreenCapture", {
  isAvailable: () => loaded.then(() => !!addon),

  requestFramePort: () => {
    window.postMessage("stoat-screen-capture-port", "*", [mainWorldPort]);
  },

  // No onFrame callback here anymore -- frames go over framePort instead
  // (see above), transferred rather than cloned. onReady/onError stay on
  // the contextBridge proxy since they're small, infrequent, and don't
  // need transfer semantics.
  //
  // `options` (maxDimension/frameRate) is threaded straight through to
  // the addon's own `CaptureOptions` -- previously this addon ignored
  // whatever resolution/fps the web app's own screen-share quality
  // picker requested and always used its own hardcoded default, so
  // picking a higher quality in that UI had no effect here at all.
  start(
    onReady: (sourceType: string | null) => void,
    onError: (message: string) => void,
    options?: { maxDimension?: number; frameRate?: number },
  ): Promise<number | null> {
    return loaded.then(() => {
      if (!addon) return null;
      const id = nextHandleId++;
      const handle = addon.startCapture(
        (err, sourceType) => {
          if (!err) onReady(sourceType);
        },
        (err, frame) => {
          if (err) return;
          // frame.data (a Buffer/Uint8Array) is reconstructed as an
          // equivalent view around the transferred ArrayBuffer on the
          // receiving end -- structured clone handles typed arrays this
          // way automatically, no manual byteOffset/byteLength bookkeeping
          // needed here. Only frame.data.buffer needs to be in the
          // transfer list; everything else in the message (numbers,
          // strings) clones trivially, that's not the expensive part.
          framePort.postMessage(frame, [frame.data.buffer]);
        },
        (_err, message) => onError(message),
        options
          ? { maxDimension: options.maxDimension, frameRate: options.frameRate }
          : undefined,
      );
      handles.set(id, handle);
      return id;
    });
  },

  stop(id: number) {
    const handle = handles.get(id);
    if (!handle) return;
    handles.delete(id);
    handle.stop();
  },
});
