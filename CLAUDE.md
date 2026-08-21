# Project direction

This repo (`stoat-desktop`) started as an Electron client for the Stoat
chat platform (itself a Revolt fork), and is deliberately moving away from
being "a fork with patches" toward being its own platform: **prefer
native Rust over Chromium/Electron JS whenever a feature can reasonably
be owned natively**, not just patched around the browser's limitations.

`native/screen-capture` is the reference pattern for this: it bypasses
Chromium's own desktop-capture pipeline entirely (portal + PipeWire
directly in Rust) instead of working around Chromium's leaks/limits from
JS. New work in a similar space (audio, other capture/media paths,
performance-sensitive pipelines) should default to the same shape --
own it in Rust, expose the minimum surface to the Electron/web side --
rather than another JS-side patch layered on top of Chromium's behavior.

This doesn't mean rewriting everything in Rust immediately or ripping out
Electron -- it's a bias for new/rearchitected work, not a mandate to
migrate working JS code without a real reason. When proposing how to
build something new in this repo, weigh a native-Rust-owned approach
first before defaulting to another Electron/Chromium-side patch.
