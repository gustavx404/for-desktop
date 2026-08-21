//! Event-driven PipeWire registry watcher, used by src/native/virtualMic.ts
//! in place of the `setInterval(..., 1000)` poll it used to run for the
//! entire lifetime of the process. That loop called `node-pipewire`'s
//! `getNodes()`/`getLinks()` every second -- unconditionally, whether or
//! not anything about the PipeWire graph had actually changed -- purely
//! because `node-pipewire`'s own NAPI surface (see
//! node_modules/node-pipewire/src/lib.rs) is pull-only: it has no way to
//! subscribe to registry changes from JS, even though its own Rust
//! internals (node_modules/node-pipewire/src/pipewire_thread.rs) already
//! listen for exactly those changes via
//! `registry.add_listener_local().global(...).global_remove(...)` to keep
//! its *own* internal node/port/link cache fresh.
//!
//! This crate exposes that same kind of registry listener to JS via a
//! `ThreadsafeFunction` callback bridge -- same shape as
//! native/screen-capture (`start_capture`/`CaptureHandle`): a background
//! OS thread runs PipeWire's own (synchronous, callback-driven) main
//! loop, and `.stop()` signals it to exit and blocks until it has,
//! rather than leaving it orphaned. No `ashpd` (no portal involved here,
//! this crate only watches the existing PipeWire graph) and no `tokio`
//! (nothing here is async -- `pipewire`'s own APIs used below are all
//! synchronous, same as node-pipewire's internal thread).
//!
//! This crate deliberately does NOT reimplement any of node-pipewire's
//! own node/link enumeration or linking logic -- it only tells JS
//! *when* something in the graph relevant to audio routing (a node or a
//! link appearing/disappearing) may have changed. virtualMic.ts still
//! uses node-pipewire's own `getNodes()`/`getLinks()`/
//! `linkNodesNameToId()` to decide *what* to do about it, re-deriving
//! ground truth at the moment an event fires rather than trusting this
//! crate's event payload as authoritative link state (a link can be torn
//! down by things outside either crate's control -- see virtualMic.ts's
//! own comment on this for why that check has to stay live).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use pipewire as pw;

/// One PipeWire registry global (a node or a link -- see `run_watch` for
/// why only those two types are ever forwarded). Field names/shape
/// mirror node-pipewire's own `PipewireNode`/`PipewireLink` JS objects
/// closely enough (`id` + a string-keyed `props` map) that virtualMic.ts's
/// existing filtering logic (`props["media.class"]`,
/// `props["application.name"]`, `props["link.input.node"]`, ...) needs no
/// changes to also work against events from this crate.
#[napi(object)]
pub struct PwGlobal {
    pub id: u32,
    /// "Node" or "Link" (see `run_watch` -- no other type is ever sent).
    pub object_type: String,
    pub props: HashMap<String, String>,
}

fn object_type_name(t: &pw::types::ObjectType) -> &'static str {
    use pw::types::ObjectType as T;
    match t {
        T::Node => "Node",
        T::Link => "Link",
        T::Port => "Port",
        T::Client => "Client",
        _ => "Other",
    }
}

#[napi]
pub struct RegistryWatchHandle {
    stop_flag: Arc<AtomicBool>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

#[napi]
impl RegistryWatchHandle {
    /// Stop watching: signals the watcher thread to tear down its
    /// PipeWire registry listener and main loop, then blocks until it
    /// has actually done so -- same synchronous-join shape as
    /// `CaptureHandle::stop()` in native/screen-capture, and for the same
    /// reason: the caller can rely on the thread being gone the moment
    /// this returns, rather than racing its background cleanup.
    #[napi]
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for RegistryWatchHandle {
    fn drop(&mut self) {
        // Diagnostic only, mirroring CaptureHandle's own Drop: if this
        // fires with join_handle still Some, the JS side dropped its
        // reference without ever calling stop() -- JoinHandle::drop()
        // does not stop or join a thread, it only detaches it, so the
        // watcher thread below would otherwise run forever in the
        // background with no visible trace on the JS side at all.
        if self.join_handle.is_some() {
            eprintln!(
                "[stoat-virtual-mic-diag] RegistryWatchHandle dropped WITHOUT stop() ever being called -- watcher thread is now orphaned and will run forever"
            );
        }
    }
}

/// Starts watching the PipeWire registry for node/link globals appearing
/// or disappearing. `on_global_added` is called once per matching global
/// already present at watch-start (PipeWire always replays the current
/// registry state to a fresh listener) and again every time one is
/// added afterwards; `on_global_removed` is called with just the id (all
/// PipeWire's own `global_remove` event gives us) when one of those same
/// globals goes away. `on_error` is called once if the PipeWire
/// connection itself fails to come up; the watcher thread exits after
/// that, nothing further will be called. Returns a handle to stop
/// watching.
#[napi]
pub fn watch_registry(
    on_global_added: ThreadsafeFunction<PwGlobal, ErrorStrategy::CalleeHandled>,
    on_global_removed: ThreadsafeFunction<u32, ErrorStrategy::CalleeHandled>,
    on_error: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
) -> Result<RegistryWatchHandle> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = stop_flag.clone();

    let join_handle = std::thread::spawn(move || {
        // Cloned (cheap -- Arc-backed, see ThreadsafeFunction::clone) so
        // run_watch can also call it directly if the PipeWire *core*
        // reports a connection error/disconnect after setup already
        // succeeded (see the core error listener in run_watch) -- setup
        // failures still propagate here via `?` and get reported through
        // this original handle, same as before.
        let on_error_for_setup = on_error.clone();
        if let Err(err) = run_watch(thread_stop_flag, on_global_added, on_global_removed, on_error) {
            on_error_for_setup.call(Ok(err.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
        }
    });

    Ok(RegistryWatchHandle {
        stop_flag,
        join_handle: Some(join_handle),
    })
}

fn run_watch(
    stop_flag: Arc<AtomicBool>,
    on_global_added: ThreadsafeFunction<PwGlobal, ErrorStrategy::CalleeHandled>,
    on_global_removed: ThreadsafeFunction<u32, ErrorStrategy::CalleeHandled>,
    on_error: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    pw::init();

    let main_loop = pw::main_loop::MainLoopRc::new(None)?;
    let context = pw::context::ContextRc::new(&main_loop, None)?;
    // Connects to the default PipeWire socket, same as node-pipewire's
    // own thread (pipewire_thread.rs: `context.connect_rc(None)`) -- no
    // portal/fd handoff needed here, unlike screen-capture, since this
    // crate watches the graph that's already there rather than
    // negotiating a new capture stream into it.
    let core = context.connect_rc(None)?;
    let registry = core.get_registry_rc()?;

    // Detects the PipeWire daemon restarting or the socket dropping
    // *after* the connection above already succeeded and the main loop
    // is running -- without this, that failure mode is invisible: PipeWire
    // C API guarantees a `pw_core` error/disconnect fires this same
    // `error` event (`pw_core_events.error`, which the `pipewire` crate's
    // `Core::add_listener_local().error(...)` wraps 1:1), but nothing here
    // was listening for it, so `main_loop.run()` would just silently stop
    // delivering real registry events for the rest of the process's life
    // -- on_error never firing, virtualMic.ts's polling fallback never
    // kicking in. `id == PW_ID_CORE` (0) marks a core-level (not some
    // individual proxy's) error -- the whole connection is dead, not just
    // one object -- which is the case this is meant to catch; other ids
    // reaching here would mean some other object's error event happened to
    // route through the core listener, which observed PipeWire behavior
    // doesn't do, but the message is reported either way since any core
    // 'error' event firing at all means this watcher's registry listener
    // can no longer be trusted to still be receiving live updates.
    let core_error_loop = main_loop.clone();
    let _core_error_listener = core
        .add_listener_local()
        .error(move |id, seq, res, message| {
            eprintln!(
                "[stoat-virtual-mic-diag] pipewire core error (id={id} seq={seq:?} res={res}): {message} -- watcher can no longer trust registry events, stopping"
            );
            on_error.call(
                Ok(format!(
                    "pipewire core error (id={id} res={res}): {message}"
                )),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
            core_error_loop.quit();
        })
        .register();

    // PipeWire's `global_remove` event hands back only the id of
    // whatever was removed, with no type info (it's gone, there's
    // nothing left to inspect) -- mirroring node-pipewire's own
    // `proxies` cache in pipewire_thread.rs, which exists for the same
    // reason, this tracks which ids were ever forwarded via
    // `on_global_added` (i.e. were a Node or a Link) so `global_remove`
    // can filter its own noise (port/client removals, etc) down to the
    // same set, without needing to ask PipeWire anything about an id
    // that no longer exists.
    let watched_ids: Rc<RefCell<HashSet<u32>>> = Rc::new(RefCell::new(HashSet::new()));
    let watched_ids_for_remove = watched_ids.clone();

    let _listener = registry
        .add_listener_local()
        .global(move |global| {
            // Only Node and Link globals matter to virtualMic.ts's
            // linking decision (Stream/Output/Audio nodes to notice and
            // link, and the sink's existing links to notice when one
            // drops) -- Port/Client/etc churn is real and frequent
            // (every node has several ports) but irrelevant here, so
            // it's filtered out at the source rather than forwarded for
            // JS to filter on every call.
            if !matches!(global.type_, pw::types::ObjectType::Node | pw::types::ObjectType::Link) {
                return;
            }

            watched_ids.borrow_mut().insert(global.id);

            let mut props = HashMap::new();
            if let Some(dict) = global.props {
                for (key, value) in dict.iter() {
                    props.insert(key.to_string(), value.to_string());
                }
            }

            let payload = PwGlobal {
                id: global.id,
                object_type: object_type_name(&global.type_).to_string(),
                props,
            };
            on_global_added.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
        })
        .global_remove(move |id| {
            if watched_ids_for_remove.borrow_mut().remove(&id) {
                on_global_removed.call(Ok(id), ThreadsafeFunctionCallMode::NonBlocking);
            }
        })
        .register();

    // Same reason as native/screen-capture's own capture_loop: PipeWire's
    // main loop has no built-in "check an external flag" hook, so a
    // short-interval timer is what lets `stop()` (called from the
    // Node/Electron side, on a different thread) actually break the loop
    // in a bounded amount of time instead of blocking forever.
    let poll_loop = main_loop.clone();
    let timer = main_loop.loop_().add_timer(move |_| {
        if stop_flag.load(Ordering::SeqCst) {
            poll_loop.quit();
        }
    });
    timer
        .update_timer(
            Some(Duration::from_millis(100)),
            Some(Duration::from_millis(100)),
        )
        .into_result()?;

    main_loop.run();
    Ok(())
}
