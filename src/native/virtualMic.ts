/* eslint-disable @typescript-eslint/no-explicit-any */
// Disable any checks because node-pipewire doesn't have types for our submodule
import { createRequire } from "node:module";
import { join } from "node:path";

import { app, ipcMain } from "electron";

import { sinkName, sourceName } from "../constants";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const isWayland =
  process.platform === "linux" &&
  (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);

ipcMain.handle("getIsWayland", () => isWayland);

/**
 * What should be routed into the virtual sink used for screen-share audio:
 * every app's audio (default, used when sharing the entire screen), a
 * single chosen app's audio (used when sharing a specific window, since
 * the Wayland screen-capture portal doesn't tell us which window that is
 * -- the user picks the matching app for us instead), or nothing.
 */
export type AudioCaptureMode =
  | { type: "all" }
  | { type: "app"; appName: string }
  | { type: "none" };

function sameMode(a: AudioCaptureMode, b: AudioCaptureMode) {
  if (a.type !== b.type) return false;
  return a.type === "app" && b.type === "app" ? a.appName === b.appName : true;
}

// Starts as "none", not "all": nothing should be linked into the sink
// (and the periodic loop below should be doing no work at all) until an
// actual screen share picks a mode, not from the moment the app boots.
let audioCaptureMode: AudioCaptureMode = { type: "none" };

// Node names this app has already warned about being unsafe to link (see
// the unsafeNames check in runLinkingTick() below) -- kept across ticks so
// the same collision doesn't spam the console once a second for as long
// as the offending app stays open.
const warnedUnsafeNames = new Set<string>();

// Guards the periodic linking loop below against the async destroy+
// recreate sequence in setAudioCaptureMode(): for the ~300ms that takes,
// `sinkNode` briefly refers to an already-destroyed node (or hasn't been
// reassigned to the new one yet). If the loop's tick lands in that
// window and calls into the native module with that stale id, it panics
// the addon's background PipeWire thread -- which then silently stops
// responding to *any* future call (getNodes, linkNodesNameToId, ...)
// for the rest of the process's life, with no crash and no error any of
// this code would see: screen-share audio just quietly stops working
// until the app is fully restarted. The loop skips its tick entirely
// while a mode switch is in flight rather than risk that.
let modeSwitchInFlight = false;

// node-pipewire bindings + live state, populated once initVirtualMic() has
// loaded the native module, so other exported functions (the app picker,
// mode switching) can use them without their own dynamic import
let pw: {
  getNodes: () => any[];
  getLinks: () => any[];
  getClients: () => any[];
  linkNodesNameToId: (name: string, id: number, permanent: boolean) => void;
  createSink: (name: string, channels: string[], monitor: boolean) => void;
  destroyObject: (id: number) => void;
} | null = null;
let sinkNode: any = null;
let sourceNode: any = null;

/**
 * Switch what gets captured into the screen-share virtual sink. Rather
 * than unlinking the streams that no longer belong (node-pipewire's
 * unlink call crashes the whole process if the underlying link has
 * already gone away, which happens often enough in practice to be
 * unusable), the sink is destroyed and recreated -- that drops every
 * existing link as a side effect, giving a clean slate to link only
 * what the new mode wants.
 */
export async function setAudioCaptureMode(mode: AudioCaptureMode) {
  if (sameMode(mode, audioCaptureMode)) return;
  audioCaptureMode = mode;

  if (!pw || !sinkNode || !sourceNode) return;

  modeSwitchInFlight = true;
  try {
    pw.destroyObject(sinkNode.id);

    await delay(150);

    pw.createSink(sinkName, ["FL", "FR"], false);

    await delay(150);

    const nodes = pw.getNodes();
    const newSink = nodes.find((node: any) => node.name === sinkName);
    if (!newSink) return;

    sinkNode = newSink;
    pw.linkNodesNameToId(sinkNode.name, sourceNode.id, false);
  } finally {
    modeSwitchInFlight = false;
  }
}

// Sent by the renderer's screen-share audio patch once every round of a
// share (see world/screenShareAudio.ts) has released its hold on the
// capture -- i.e. the user actually stopped sharing, not just the
// provisional-to-confirmed round transition every share goes through.
// Resetting to "none" here is what lets the periodic linking loop below
// skip its per-second native calls for the (common) rest of a session
// where nothing is being shared.
ipcMain.on("screenShareEnded", () => setAudioCaptureMode({ type: "none" }));

/**
 * Names of apps (other than this one) currently outputting audio, for
 * building a "which app's audio should I include?" picker when sharing a
 * single window.
 */
export function getActiveAudioApps(): string[] {
  if (!pw) return [];

  const appName = app.getName();
  const names = new Set<string>();

  for (const node of pw.getNodes()) {
    if (node.props?.["media.class"] !== "Stream/Output/Audio") continue;
    const name = node.props?.["application.name"];
    if (name && name !== appName) names.add(name);
  }

  return [...names];
}

/**
 * PipeWire client IDs belonging to this app's own OS processes. Matching
 * only the main process's pid isn't enough: Chromium runs its Audio
 * Service (and GPU process, etc.) out-of-process, so the PipeWire client
 * that actually owns this app's own audio-output node is commonly a
 * *subprocess*, not the main process -- confirmed live against a running
 * instance of this app, where the audio-output node's
 * application.process.id was the AudioService utility process's pid, not
 * process.pid. app.getAppMetrics() returns every OS process this
 * Electron app owns (browser, gpu, utility, renderers), so matching
 * against that whole set instead of a single pid covers this case.
 * Re-derived fresh on every call, same reasoning as linkedNodeIds in
 * runLinkingTick() below: this app's own process set (and PipeWire's
 * client list) can change over the life of the app, so a permanent cache
 * risks going stale.
 */
function getOwnClientIds(): Set<number> {
  if (!pw) return new Set();

  const ownPids = new Set(app.getAppMetrics().map((p) => p.pid));
  const ownName = app.getName();
  const ids = new Set<number>();

  for (const client of pw.getClients()) {
    if (ownPids.has(client.pid) || client.application_name === ownName) {
      ids.add(client.id);
    }
  }

  return ids;
}

/**
 * Re-derives which apps should be linked into the screen-share sink and
 * links any that aren't already. This used to be the body of a
 * `setInterval(..., 1000)` fired unconditionally for the app's whole
 * lifetime; it's now triggered instead (see startRegistryWatcher() below)
 * by native/virtual-mic's push events -- but the function itself is
 * otherwise unchanged, including the "skip entirely" guard and the
 * reasoning below for why it re-derives from getNodes()/getLinks() every
 * time it runs rather than trusting any cache of its own.
 */
function runLinkingTick() {
  // Skip entirely -- no native calls at all -- whenever there's nothing
  // to route: while a sink swap is in flight (see the comment on
  // modeSwitchInFlight for why linking against a stale sinkNode.id is
  // unsafe), and whenever capture mode is "none" (the default once
  // nothing is being shared -- see screenShareEnded()).
  if (
    !pw ||
    !sinkNode ||
    modeSwitchInFlight ||
    audioCaptureMode.type === "none"
  )
    return;

  // Defensive: node-pipewire's calls run on the addon's own background
  // thread, and any failure there (however unlikely) would otherwise
  // take the whole feature down silently for the rest of the process's
  // life with no visible error. A thrown exception here at least
  // surfaces in the console instead.
  try {
    // every app currently outputting audio, minus our own
    const ownClientIds = getOwnClientIds();

    const audioNodes = pw
      .getNodes()
      .filter(
        (node: any) => node.props["media.class"] === "Stream/Output/Audio",
      )
      .filter((node: any) => {
        const name = node.props["application.name"];
        // A node PipeWire hasn't finished tagging yet (application.name not
        // populated -- happens briefly right after the node is first
        // announced, before this app's own properties have propagated) is
        // treated as "possibly ours, don't link it yet" rather than "not
        // ours, safe to link": the loop below only ever adds links, never
        // removes ones that turn out to be wrong once props settle (see its
        // own comment above), so linking an unresolved node now could make
        // a race-condition self-link permanent for the rest of the share.
        if (!name) return false;
        // Exclude this app's own audio by application name (existing check).
        if (name === app.getName()) return false;
        // Exclude by PipeWire client ID when available -- catches cases
        // where application.name is missing, different, or the app's
        // audio is produced by a subprocess with a different name.
        if (ownClientIds.has(Number(node.props["client.id"]))) return false;
        return true;
      });

    // of those, which ones the current capture mode wants included
    const desired = audioNodes.filter((node: any) => {
      if (audioCaptureMode.type === "app") {
        return node.props["application.name"] === audioCaptureMode.appName;
      }
      return true;
    });

    // linkNodesNameToId() links by exact node.name match against *every*
    // node currently on the graph with that name, not just the specific
    // id it was resolved from -- confirmed against node-pipewire's own
    // pipewire_thread.rs. Some apps register more than one node under the
    // identical name for different roles: TeamSpeak, for one, has both a
    // "TeamSpeak" playback node (Stream/Output/Audio, what desired above
    // means to link) and a "TeamSpeak" capture-monitor node
    // (Stream/Input/Audio, mirroring back whatever TeamSpeak's mic input
    // is currently picking up). Linking the first by name silently links
    // the second too, and if that mic input happens to be a monitor of
    // the system's default output (a real TeamSpeak config seen in
    // practice), the capture-monitor node re-injects a remote call
    // participant's own voice -- already played locally through this
    // app's own audio -- straight back into the screen-share "system
    // audio" sink, i.e. that participant hears themselves echoed back.
    // Building this map from *all* graph nodes (not just audioNodes,
    // which already dropped every Stream/Input/Audio node) is what makes
    // the collision visible at all.
    const nodesByName = new Map<string, any[]>();
    for (const node of pw.getNodes()) {
      const list = nodesByName.get(node.name);
      if (list) list.push(node);
      else nodesByName.set(node.name, [node]);
    }
    const unsafeNames = new Set<string>();
    for (const [name, nodesWithName] of nodesByName) {
      if (
        nodesWithName.some(
          (n: any) => n.props["media.class"] !== "Stream/Output/Audio",
        )
      ) {
        unsafeNames.add(name);
      }
    }

    // Which desired nodes are *actually* linked into the sink right now,
    // checked fresh every time rather than assumed from a "linked once,
    // so it's still linked" cache -- PipeWire links can and do get torn
    // down by things outside our control (portal renegotiation, driver
    // hiccups, a node briefly dropping out of enumeration), and a cache
    // has no way to notice that happened. Re-deriving ground truth from
    // getLinks() every time this runs means a silently-dropped link gets
    // caught and re-established (on the next relevant registry event, or
    // within one second if the polling fallback below is active) instead
    // of staying broken indefinitely.
    const linkedNodeIds = new Set(
      pw
        .getLinks()
        .filter(
          (link: any) => Number(link.props["link.input.node"]) === sinkNode.id,
        )
        .map((link: any) => Number(link.props["link.output.node"])),
    );

    for (const node of desired) {
      const idAsNum = Number(node.id);
      if (linkedNodeIds.has(idAsNum)) continue;

      if (unsafeNames.has(node.name)) {
        if (!warnedUnsafeNames.has(node.name)) {
          warnedUnsafeNames.add(node.name);
          console.warn(
            `[stoat] skipping screen-share audio link for "${node.name}": another PipeWire node shares this exact name but isn't a plain audio-output stream, and linkNodesNameToId links every node with that name at once -- linking would pull the other one in too.`,
          );
        }
        continue;
      }

      pw.linkNodesNameToId(node.name, sinkNode.id, false);
    }
  } catch (err) {
    console.error("[stoat] screen-share audio linking tick failed:", err);
  }
}

/** One PipeWire registry global (a node or a link), as reported by
 * native/virtual-mic's watchRegistry() -- see that crate's PwGlobal for
 * the authoritative shape. Only used here to cheaply pre-filter which
 * events are worth reacting to; the actual linking decision always goes
 * back through node-pipewire's own getNodes()/getLinks() in
 * runLinkingTick() above, never this payload, for the same
 * don't-trust-a-cache reason documented there.
 */
interface PwGlobalEvent {
  id: number;
  objectType: string;
  props: Record<string, string>;
}

interface VirtualMicWatchHandle {
  stop(): void;
}

interface VirtualMicAddon {
  watchRegistry(
    onGlobalAdded: (err: Error | null, global: PwGlobalEvent) => void,
    onGlobalRemoved: (err: Error | null, id: number) => void,
    onError: (err: Error | null, message: string) => void,
  ): VirtualMicWatchHandle;
}

// Module state, same as pw/sinkNode/sourceNode above: kept as an
// addressable value (rather than a function-local throwaway discarded
// right after watchRegistry() returns it) so it's at least retrievable
// and .stop()-able. native/virtual-mic's own RegistryWatchHandle Drop
// impl warns (via an eprintln, mirroring native/screen-capture's
// CaptureHandle) that a handle dropped without .stop() ever being called
// leaves its watcher thread orphaned/undetected -- discarding the return
// value of watchRegistry() entirely, as this used to, guarantees exactly
// that on every reload of this module. This app has no general
// subsystem-teardown path today (pre-existing, not introduced here), so
// nothing currently calls .stop() on this during normal operation --
// but the handle is at least reachable for that if a teardown path is
// ever added, instead of being unreachable the moment startRegistryWatcher()
// returns. Underscore-prefixed (matching this repo's eslint
// no-unused-vars convention, see .eslintrc.json's varsIgnorePattern) since
// nothing reads it back today -- it's assigned for future reachability,
// not consumed yet.
let _registryWatchHandle: VirtualMicWatchHandle | null = null;

let intervalFallbackHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Falls back to the original unconditional per-second poll. Used both
 * when native/virtual-mic fails to load at all (e.g. a dev checkout that
 * hasn't `cargo build`ed it yet -- like native/screen-capture, this addon
 * has no real packaging/CI build today either, see its own crate docs)
 * and if its watcher thread reports an error after already having
 * started (see the on_error handler in startRegistryWatcher() below).
 * Losing live registry events partway through a session should degrade
 * to "back to polling", not "screen-share audio silently stops updating
 * for the rest of the process's life" -- the same silent-failure risk
 * modeSwitchInFlight and the try/catch in runLinkingTick() above already
 * guard against elsewhere in this file.
 */
function startIntervalFallback() {
  if (intervalFallbackHandle) return;
  console.log(
    "[stoat] native/virtual-mic unavailable -- falling back to polling for screen-share audio linking",
  );
  intervalFallbackHandle = setInterval(runLinkingTick, 1000);
}

// Throttles runLinkingTick() invocations to at most once per ~1000ms
// (matching the cadence of the flat setInterval(runLinkingTick, 1000)
// this file used to run unconditionally), while still guaranteeing a
// trailing call reflecting the latest state once a burst of events
// settles. This coalesces a startup burst (PipeWire replays every
// global already in the registry to a *newly-registered* listener --
// see native/virtual-mic's own doc comment on this) same as before, but
// also caps *continuous* churn (an app repeatedly opening/closing audio
// streams during an active share): a plain re-entrancy guard with a
// fixed window (the previous version of this function, a 50ms window
// that did not reset/extend on each new event) could start a fresh
// window immediately after the previous one fired under continuous
// churn, allowing up to ~20 runLinkingTick() calls/sec -- each doing
// native getNodes()+getLinks() calls -- worse than the flat 1-second
// interval it replaced. A plain debounce (reset a fixed delay on every
// event) was considered and rejected too: under continuous churn it
// would never fire at all for as long as churn continues, starving real
// linking updates for the whole busy period -- worse than the bug it
// would fix.
//
// lastRunAt tracks when runLinkingTick() actually last ran. A new event
// either runs immediately (system has been quiet for >=1000ms -- low
// latency response when idle) or schedules exactly one trailing call for
// whenever the remainder of that 1000ms window elapses (if one is
// already pending, this does nothing further) -- so a burst of events
// during an active throttle window always eventually produces exactly
// one fresh tick reflecting the latest state, and continuous churn is
// capped at ~1 real tick/sec no matter how many events arrive.
let lastRunAt = 0;
let trailingCallScheduled = false;
function scheduleLinkingTick() {
  if (trailingCallScheduled) return;

  const elapsed = Date.now() - lastRunAt;
  if (elapsed >= 1000) {
    lastRunAt = Date.now();
    runLinkingTick();
    return;
  }

  trailingCallScheduled = true;
  setTimeout(() => {
    trailingCallScheduled = false;
    lastRunAt = Date.now();
    runLinkingTick();
  }, 1000 - elapsed);
}

/**
 * Loads native/virtual-mic (see its own crate docs) and starts an
 * event-driven registry watch, replacing the unconditional per-second
 * poll this file used to run for its entire lifetime. Returns whether
 * the watcher actually started -- the caller falls back to polling
 * (startIntervalFallback()) if not, same as node-pipewire's own
 * addon-load failure path below falls back to "screen share audio
 * doesn't work" rather than crashing the app.
 */
async function startRegistryWatcher(): Promise<boolean> {
  try {
    // Dev-only, same as native/screen-capture: built via `cargo build`
    // in native/virtual-mic and copied to index.node, no real packaging
    // yet. Node's ESM loader can't load a raw `.node` file directly
    // (`ERR_UNKNOWN_FILE_EXTENSION`) -- only the CJS require() loader
    // understands native addons, so createRequire() is used to get one
    // here even though this file otherwise runs as (effectively) CJS in
    // the main process; addonPath itself is an absolute path, which
    // createRequire() accepts directly as its own base, no resolution
    // relative to this file needed for the require() call below either.
    const addonPath = join(process.cwd(), "native/virtual-mic/index.node");
    const require = createRequire(addonPath);
    const addon = require(addonPath) as VirtualMicAddon;

    _registryWatchHandle = addon.watchRegistry(
      (_err, global) => {
        // Cheap pre-filter, not a correctness gate: a new Link is always
        // worth reacting to (that's exactly how a re-established link
        // would show up), and a new Node only matters here if it's an
        // audio output stream -- the same check runLinkingTick() itself
        // applies. Anything else (a new video stream, a port, ...) can't
        // change what this function decides, so there's no reason to
        // schedule a recompute for it.
        const relevant =
          global.objectType === "Link" ||
          (global.objectType === "Node" &&
            global.props["media.class"] === "Stream/Output/Audio");
        if (relevant) scheduleLinkingTick();
      },
      () => {
        // global_remove only ever fires here for a node or link this
        // watcher already told us about (native/virtual-mic filters to
        // just those two types), and losing either one -- especially a
        // link, torn down by something outside this app's control -- is
        // exactly the case worth re-checking for, so no further
        // filtering here.
        scheduleLinkingTick();
      },
      (_err, message) => {
        console.error(
          "[stoat] native/virtual-mic watcher failed, falling back to polling for screen-share audio linking:",
          message,
        );
        startIntervalFallback();
      },
    );

    return true;
  } catch (err) {
    console.log("[stoat] native/virtual-mic failed to load:", err);
    return false;
  }
}

export async function initVirtualMic() {
  // Screen-share audio routing needs a virtual PipeWire sink -- this is
  // independent of which video-capture path is active (Wayland portal vs
  // Chromium's own X11 capture). Electron's setDisplayMediaRequestHandler
  // only supports audio: "loopback" on Windows (see
  // world/screenShareAudio.ts's own comment on this), so this workaround
  // is needed on Linux generally, not just Wayland sessions. Gating on
  // isWayland here previously left X11+PipeWire users -- a common
  // configuration, PipeWire isn't Wayland-exclusive -- with no
  // screen-share audio at all, even though nothing about this routing
  // depends on Wayland specifically. world/screenShareAudio.ts's own
  // IS_WAYLAND checks are unaffected by this: those gate the *video*
  // capture path only, and its audio-staple logic already runs
  // unconditionally, naturally no-opping when this virtual device was
  // never created (see its own comment there).
  if (process.platform !== "linux") return;

  try {
    const {
      createPwThread,
      createSink,
      createSource,
      getNodes,
      getLinks,
      getClients,
      linkNodesNameToId,
      destroyObject,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-ignore This module may not be found on non-linux builds.
    } = await import("node-pipewire"); //eslint-disable-line

    pw = {
      getNodes,
      getLinks,
      getClients,
      linkNodesNameToId,
      createSink,
      destroyObject,
    };

    createPwThread();

    // Wait for pipewire thread to start and gather neccessary data
    await delay(100);

    let nodes: any[] = getNodes();

    let sinkFound = false;
    let sourceFound = false;
    for (const node of nodes) {
      if (node.name === sinkName) {
        sinkFound = true;
      }
      if (node.name === sourceName) {
        sourceFound = true;
      }
    }

    if (!sinkFound) {
      createSink(sinkName, ["FL", "FR"], false);
    }

    if (!sourceFound) {
      createSource(sourceName, ["FL", "FR"], false);
    }

    // Wait for source and sink to save
    await delay(100);

    nodes = getNodes();
    sourceNode = nodes.filter((node: any) => node.name === sourceName)[0];
    sinkNode = nodes.filter((node: any) => node.name === sinkName)[0];

    linkNodesNameToId(sinkNode.name, sourceNode.id, false);

    // Event-driven by default (see startRegistryWatcher() above); falls
    // back to the original per-second poll if native/virtual-mic isn't
    // available or its watcher thread errors out later.
    const watching = await startRegistryWatcher();
    if (!watching) startIntervalFallback();
  } catch {
    console.log(
      "node-pipewire failed to load. Screen share audio will not work on linux wayland.",
    );
  }
}
