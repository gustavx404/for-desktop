/* eslint-disable @typescript-eslint/no-explicit-any */
// Disable any checks because node-pipewire doesn't have types for our submodule
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

export async function initVirtualMic() {
  // Only available on Wayland
  if (!isWayland) return;

  try {
    const {
      createPwThread,
      createSink,
      createSource,
      getNodes,
      getLinks,
      linkNodesNameToId,
      destroyObject,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-ignore This module may not be found on non-linux builds.
    } = await import("node-pipewire"); //eslint-disable-line

    pw = { getNodes, getLinks, linkNodesNameToId, createSink, destroyObject };

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

    const appName = app.getName();

    nodes = getNodes();
    sourceNode = nodes.filter((node: any) => node.name === sourceName)[0];
    sinkNode = nodes.filter((node: any) => node.name === sinkName)[0];

    linkNodesNameToId(sinkNode.name, sourceNode.id, false);

    setInterval(() => {
      // Skip the tick entirely -- no native calls at all -- whenever
      // there's nothing to route: while a sink swap is in flight (see
      // the comment on modeSwitchInFlight for why linking against a
      // stale sinkNode.id is unsafe), and whenever capture mode is
      // "none" (the default once nothing is being shared -- see
      // screenShareEnded()). This is the common case for most of a
      // session, so skipping getNodes()/getLinks() here rather than
      // running them unconditionally every second for the app's entire
      // lifetime is a real, ongoing saving, not just a micro-optimisation.
      if (!sinkNode || modeSwitchInFlight || audioCaptureMode.type === "none")
        return;

      // Defensive: node-pipewire's calls run on the addon's own
      // background thread, and any failure there (however unlikely)
      // would otherwise take the whole feature down silently for the
      // rest of the process's life with no visible error. A thrown
      // exception here at least surfaces in the console instead.
      try {
        // every app currently outputting audio, minus our own
        const audioNodes = getNodes()
          .filter(
            (node: any) => node.props["media.class"] === "Stream/Output/Audio",
          )
          .filter((node: any) => node.props["application.name"] !== appName);

        // of those, which ones the current capture mode wants included
        const desired = audioNodes.filter((node: any) => {
          if (audioCaptureMode.type === "app") {
            return node.props["application.name"] === audioCaptureMode.appName;
          }
          return true;
        });

        // Which desired nodes are *actually* linked into the sink right
        // now, checked fresh every tick rather than assumed from a
        // "linked once, so it's still linked" cache -- PipeWire links
        // can and do get torn down by things outside our control (portal
        // renegotiation, driver hiccups, a node briefly dropping out of
        // enumeration), and a cache has no way to notice that happened.
        // Re-deriving ground truth from getLinks() every tick means a
        // silently-dropped link gets caught and re-established within
        // one second instead of staying broken indefinitely.
        const linkedNodeIds = new Set(
          getLinks()
            .filter(
              (link: any) =>
                Number(link.props["link.input.node"]) === sinkNode.id,
            )
            .map((link: any) => Number(link.props["link.output.node"])),
        );

        for (const node of desired) {
          const idAsNum = Number(node.id);
          if (!linkedNodeIds.has(idAsNum)) {
            linkNodesNameToId(node.name, sinkNode.id, false);
          }
        }
      } catch (err) {
        console.error("[stoat] screen-share audio linking tick failed:", err);
      }
    }, 1000);
  } catch {
    console.log(
      "node-pipewire failed to load. Screen share audio will not work on linux wayland.",
    );
  }
}
