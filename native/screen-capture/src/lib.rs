//! Screen capture that talks to xdg-desktop-portal's ScreenCast interface
//! and PipeWire directly, bypassing Chromium's own desktop-capture
//! pipeline entirely. See ../SPIKE.md for why this module exists: the
//! Chromium/Wayland portal capture path leaks native GPU/shared-memory
//! buffers across repeated getDisplayMedia() negotiations, with no public
//! API (Electron, CDP, or otherwise) able to reclaim them short of
//! restarting the renderer process. Owning the capture ourselves means we
//! control its lifecycle -- start it once per share, stop it (and free
//! its buffers) exactly when we mean to, the same way native/virtualMic.ts
//! already owns the PipeWire *audio* routing for screen-share audio.
//!
//! Frames are delivered to JS via a ThreadsafeFunction so this can be
//! `require()`d directly from a preload script and consumed in the same
//! process as the page's own JS -- no IPC frame transport, no
//! serialization of multi-megabyte buffers between processes. See
//! src/world/screenShareCapture.ts for the consumer, which wraps each
//! frame into a `VideoFrame` fed to a `MediaStreamTrackGenerator`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use mimalloc::MiMalloc;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use pipewire as pw;

/// Re-applied after live-testing ruled it out as the cause of the
/// catastrophic leak found and fixed in screenShareAudio.ts (VideoFrame
/// never being close()d) -- reverting this made no measurable difference
/// to that bug, confirming it wasn't the allocator. Real, if smaller,
/// value here: the capture loop allocates and frees one multi-megabyte
/// frame buffer per frame, tens of times a second -- glibc's malloc tends
/// to hold onto freed memory of that size/pattern rather than returning
/// it to the OS. mimalloc returns freed pages more eagerly for this
/// pattern.
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[napi(object)]
pub struct FrameData {
    /// Raw pixel data for one frame. Format is whatever the compositor
    /// negotiated -- format/stride/size below describe how to interpret
    /// it. Handed to JS as a Buffer with no extra copy on our side.
    pub data: Buffer,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    /// SPA video format id (spa::param::format::VideoFormat as u32), kept
    /// around for logging/debugging -- `pixel_format` below is what the
    /// consumer should actually use.
    pub format: u32,
    /// `format` mapped to a WebCodecs `VideoPixelFormat` string (e.g.
    /// "BGRA"), or `None` if the compositor negotiated a layout WebCodecs
    /// has no equivalent for. The consumer must reject/drop the frame
    /// (or the whole share) rather than guess when this is `None` --
    /// feeding `VideoFrame` the wrong byte layout silently corrupts
    /// colors instead of erroring.
    pub pixel_format: Option<String>,
}

/// Maps a SPA raw video format to the `VideoPixelFormat` string
/// `VideoFrame`'s constructor expects. SPA and WebCodecs don't share a
/// naming scheme (SPA names byte order high-to-low, e.g. `BGRA` = B is
/// byte 0; WebCodecs' `BGRA`/`RGBA`/etc use the same byte-0-first
/// convention, so the packed 8-bit formats map 1:1). Only packed
/// single-plane formats are mapped: the pixel-copy code below
/// (`process` callback in `capture_loop`) only ever reads
/// `datas_mut().first_mut()`, i.e. one plane -- mapping a multi-planar
/// format like I420/NV12 here would silently hand `VideoFrame` a
/// corrupt/incomplete buffer (only the first plane, no chroma) rather
/// than erroring. Padding-byte-first/alpha-first layouts (`xRGB`/`ARGB`/
/// etc) also have no WebCodecs equivalent. All of these are left
/// unmapped -- the consumer must reject the frame -- rather than guessed
/// at.
fn spa_format_to_webcodecs(format: pw::spa::param::video::VideoFormat) -> Option<&'static str> {
    use pw::spa::param::video::VideoFormat as F;
    match format {
        F::RGBA => Some("RGBA"),
        F::RGBx => Some("RGBX"),
        F::BGRA => Some("BGRA"),
        F::BGRx => Some("BGRX"),
        _ => None,
    }
}

/// Downscales a packed 4-byte-per-pixel frame (nearest-neighbor -- cheap,
/// no new dependency, and screen-share doesn't need photographic
/// resampling quality) so its longer side is at most `max_dimension`,
/// preserving aspect ratio. Returns the source unchanged if it's already
/// within that bound. Cutting resolution at the source is what actually
/// keeps the per-frame cost (the copy into this addon's own buffer, the
/// contextBridge clone into the page's main world, and the VideoFrame
/// construction there -- all real main-thread work with no zero-copy path
/// available today, see SPIKE.md) low enough to sustain 60fps without the
/// full native monitor resolution overwhelming it -- confirmed live that
/// 60fps at full native res reliably freezes the whole Electron app.
fn downscale_packed_4bpp(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    src_stride: u32,
    max_dimension: u32,
) -> (Vec<u8>, u32, u32, u32) {
    let longer_side = src_width.max(src_height);
    if longer_side <= max_dimension || longer_side == 0 {
        return (src.to_vec(), src_width, src_height, src_stride);
    }

    let scale = max_dimension as f32 / longer_side as f32;
    let dst_width = ((src_width as f32 * scale).round() as u32).max(1);
    let dst_height = ((src_height as f32 * scale).round() as u32).max(1);
    let dst_stride = dst_width * 4;

    // Integer nearest-neighbor mapping (x * src / dst), and precomputed
    // once per column rather than recomputed (as a float division) for
    // every one of the ~2M destination pixels a 1080p frame has -- there
    // are only dst_width unique column mappings, reused across every row.
    // This alone took a 2560x1440->1920x1080 downscale from being the
    // bottleneck capping this addon around ~40fps (even in a release
    // build) to no longer being the limiting factor.
    let src_x_for_col: Vec<u32> = (0..dst_width)
        .map(|x| (x * src_width / dst_width).min(src_width - 1))
        .collect();

    // `vec![0u8; ...]` would zero-fill this buffer before the loop below
    // overwrites every single byte of it anyway -- a wasted memset of a
    // multi-megabyte buffer, every frame, for nothing. `with_capacity` +
    // `set_len` skips that. SAFETY: the nested loop below writes
    // `dst[dst_off..dst_off + 4]` for every `x` in `0..dst_width` and
    // every `y` in `0..dst_height`, i.e. the full `dst_stride * dst_height`
    // range (dst_stride == dst_width * 4, no padding), before `dst` is
    // read or returned -- no uninitialized byte is ever observed.
    let dst_len = (dst_stride * dst_height) as usize;
    let mut dst: Vec<u8> = Vec::with_capacity(dst_len);
    unsafe { dst.set_len(dst_len) };
    for y in 0..dst_height {
        let src_y = (y * src_height / dst_height).min(src_height - 1);
        let src_row = (src_y * src_stride) as usize;
        let dst_row = (y * dst_stride) as usize;
        for (x, &src_x) in src_x_for_col.iter().enumerate() {
            let src_off = src_row + (src_x * 4) as usize;
            let dst_off = dst_row + x * 4;
            dst[dst_off..dst_off + 4].copy_from_slice(&src[src_off..src_off + 4]);
        }
    }
    (dst, dst_width, dst_height, dst_stride)
}

/// Maps ashpd's per-stream `SourceType` (what the portal reports the user
/// actually picked) to a plain string the JS side can switch on without
/// needing the addon's types. `None` covers both "portal didn't report
/// one" and any future variant this addon doesn't know about yet.
fn source_type_to_str(source_type: ashpd::desktop::screencast::SourceType) -> Option<&'static str> {
    use ashpd::desktop::screencast::SourceType as S;
    match source_type {
        S::Monitor => Some("monitor"),
        S::Window => Some("window"),
        S::Virtual => Some("virtual"),
    }
}

#[napi]
pub struct CaptureHandle {
    stop_flag: Arc<AtomicBool>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

#[napi]
impl CaptureHandle {
    /// Stop the capture: signals the capture thread to tear down its
    /// PipeWire stream and portal session, then blocks until it has
    /// actually done so, so the caller can rely on native resources being
    /// released the moment this returns rather than racing a background
    /// thread's own cleanup.
    #[napi]
    pub fn stop(&mut self) {
        eprintln!("[stoat-capture-diag] stop() called");
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
        eprintln!("[stoat-capture-diag] stop() joined, thread gone");
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        // Diagnostic only: if this fires with join_handle still Some, the
        // JS side dropped its reference to this handle without ever
        // calling stop() -- the capture thread below has no other way to
        // learn it should exit, and JoinHandle::drop() does NOT stop or
        // join a thread, it just detaches it, so an orphaned capture
        // would otherwise run forever in the background with no visible
        // trace on the JS side at all.
        if self.join_handle.is_some() {
            eprintln!(
                "[stoat-capture-diag] CaptureHandle dropped WITHOUT stop() ever being called -- capture thread is now orphaned and will run forever"
            );
        }
    }
}

/// Requested capture quality, threaded down from the web app's own
/// screen-share quality picker (`getEnabledScreenShareQualities()` in
/// `for-web`'s `state.tsx`) via `getDisplayMedia`'s `constraints.video`
/// -- previously this addon ignored that entirely and always used the
/// hardcoded defaults below, so picking e.g. "1440p 60FPS" in the app's
/// own UI had no effect on what this addon actually captured. Both
/// fields optional: `None` falls back to the same default this addon
/// always used (1920px longer side, 60fps) -- e.g. for the
/// Chromium-fallback path's own constraints format not being present,
/// or any caller that predates this option existing.
#[napi(object)]
pub struct CaptureOptions {
    pub max_dimension: Option<u32>,
    pub frame_rate: Option<u32>,
}

/// Starts a screen/window capture session. `on_ready` is called once,
/// right after the portal negotiation succeeds and before any frames are
/// delivered, with the source type (`"monitor"`/`"window"`/`"virtual"`,
/// or `null` if the portal didn't report one) the user actually picked --
/// this is what lets the caller decide whether to show a "which app's
/// audio" picker for a window share, the same decision this app used to
/// make from Chromium's `desktopCapturer` source id prefix. `on_frame` is
/// called once per captured frame; `on_error` once if the portal
/// negotiation or PipeWire stream setup fails (the capture thread exits
/// after that, nothing further will be called). Returns a handle to stop
/// the capture.
#[napi]
pub fn start_capture(
    on_ready: ThreadsafeFunction<Option<String>, ErrorStrategy::CalleeHandled>,
    on_frame: ThreadsafeFunction<FrameData, ErrorStrategy::CalleeHandled>,
    on_error: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
    options: Option<CaptureOptions>,
) -> Result<CaptureHandle> {
    eprintln!("[stoat-capture-diag] start_capture() called, spawning capture thread");
    let max_dimension = options.as_ref().and_then(|o| o.max_dimension).unwrap_or(1920);
    let frame_rate = options.as_ref().and_then(|o| o.frame_rate).unwrap_or(60);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = stop_flag.clone();

    let join_handle = std::thread::spawn(move || {
        if let Err(err) = run_capture(thread_stop_flag, on_ready, on_frame, max_dimension, frame_rate)
        {
            on_error.call(Ok(err.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
        }
        eprintln!("[stoat-capture-diag] capture thread function returned");
    });

    Ok(CaptureHandle {
        stop_flag,
        join_handle: Some(join_handle),
    })
}

/// Shared, process-lifetime Tokio runtime -- deliberately NOT one fresh
/// `Runtime::new()` per capture (that was the actual root cause of the
/// "shares once, then hangs forever on the next share" bug, found this
/// session): `ashpd`'s own `Proxy::connection()`
/// (ashpd-0.13.13/src/proxy.rs) caches the D-Bus session connection in a
/// process-wide `static SESSION: OnceLock<zbus::Connection>` -- created
/// once, on whatever Tokio runtime happens to be active the *first* time
/// any portal call is made, and reused (via the OnceLock, never
/// recreated) by every later call regardless of which runtime asks for
/// it. A fresh `Runtime::new()` per `run_capture()` call, dropped at the
/// end of that same function, tears down that runtime's I/O driver and
/// aborts every task spawned on it -- including zbus's own background
/// task that actually reads/writes the connection's socket. The
/// `zbus::Connection` *handle* itself survives (it's cached in ashpd's
/// static, not owned by our dropped runtime), so it looks alive, but
/// nothing is left running to ever complete a pending call on it. The
/// second `negotiate_portal()` call -- from a brand new runtime -- reused
/// that now-orphaned connection and hung forever on its very first
/// await, confirmed live via per-stage `eprintln!`s in `negotiate_portal`
/// (hung inside `Screencast::new()`, before even `create_session()`).
/// One runtime for the whole process's lifetime keeps that connection's
/// driver running for as long as anything might still use it.
static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();

fn run_capture(
    stop_flag: Arc<AtomicBool>,
    on_ready: ThreadsafeFunction<Option<String>, ErrorStrategy::CalleeHandled>,
    on_frame: ThreadsafeFunction<FrameData, ErrorStrategy::CalleeHandled>,
    max_dimension: u32,
    frame_rate: u32,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let rt = RUNTIME.get_or_init(|| tokio::runtime::Runtime::new().expect("tokio runtime init"));
    let (fd, node_id, source_type) = rt.block_on(negotiate_portal())?;
    on_ready.call(
        Ok(source_type.map(str::to_string)),
        ThreadsafeFunctionCallMode::NonBlocking,
    );
    capture_loop(fd, node_id, stop_flag, on_frame, max_dimension, frame_rate)
}

/// The portal's screencast permission token, saved from one negotiation and
/// reused by the next. Process-lifetime only (an in-memory static, not
/// persisted to disk) -- deliberately scoped to `PersistMode::Application`
/// ("persist while the application is running"), not `ExplicitlyRevoked`
/// ("persist until explicitly revoked" -- would survive app restarts,
/// which is a real user-expectation/security surprise this app hasn't
/// opted into). Exists because of a real, live-diagnosed bug: with
/// `PersistMode::DoNot` (the previous, simpler setting), *every*
/// negotiation -- including the second one in the same app session, e.g.
/// stop-then-reshare -- opened a brand-new interactive portal picker
/// dialog and blocked waiting for it. Confirmed live via
/// `[stoat-capture-diag]` output: `start_capture()` was called for the
/// second round, then nothing further (no on_ready, no on_error) for over
/// 10s, matching LiveKit's own "waiting for pending publication promise
/// timed out" on the JS side at almost exactly that delay -- consistent
/// with a second picker dialog sitting unanswered (easy to miss: nothing
/// in this app's own UI indicates a *system* dialog, not an app one,
/// appeared). A restore token lets the portal skip that dialog entirely
/// on any negotiation within the same run of this app, once the user has
/// granted it once.
static RESTORE_TOKEN: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

async fn negotiate_portal() -> std::result::Result<
    (std::os::fd::OwnedFd, u32, Option<&'static str>),
    Box<dyn std::error::Error>,
> {
    use ashpd::desktop::screencast::{
        CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType,
        StartCastOptions,
    };
    use ashpd::desktop::PersistMode;
    use ashpd::enumflags2::BitFlags;

    let proxy = Screencast::new().await?;
    let session = proxy.create_session(Default::default()).await?;

    let restore_token = RESTORE_TOKEN.lock().unwrap().clone();
    let mut select_options = SelectSourcesOptions::default()
        .set_cursor_mode(CursorMode::Hidden)
        .set_sources(BitFlags::from(SourceType::Monitor) | SourceType::Window)
        .set_multiple(false)
        .set_persist_mode(PersistMode::Application);
    if let Some(token) = &restore_token {
        select_options = select_options.set_restore_token(token.as_str());
    }
    proxy
        .select_sources(&session, select_options)
        .await?
        .response()?;

    let response = proxy
        .start(&session, None, StartCastOptions::default())
        .await?
        .response()?;

    // Save whatever token the portal hands back for the *next*
    // negotiation, whether or not one was sent this time -- confirmed
    // against ashpd's own docs that the portal can rotate/reissue a new
    // token on any successful start(), not just the very first one.
    if let Some(token) = response.restore_token() {
        *RESTORE_TOKEN.lock().unwrap() = Some(token.to_string());
    }

    let stream = response
        .streams()
        .first()
        .ok_or("portal returned no streams")?;
    let node_id = stream.pipe_wire_node_id();
    let source_type = stream.source_type().and_then(source_type_to_str);

    let fd = proxy
        .open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default())
        .await?;
    Ok((fd, node_id, source_type))
}

fn capture_loop(
    fd: std::os::fd::OwnedFd,
    node_id: u32,
    stop_flag: Arc<AtomicBool>,
    on_frame: ThreadsafeFunction<FrameData, ErrorStrategy::CalleeHandled>,
    max_dimension: u32,
    frame_rate: u32,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    pw::init();

    let main_loop = pw::main_loop::MainLoopRc::new(None)?;
    let context = pw::context::ContextRc::new(&main_loop, None)?;
    let core = context.connect_fd_rc(fd, None)?;

    let stream = pw::stream::StreamBox::new(
        &core,
        "stoat-screen-capture",
        pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )?;

    // Current negotiated frame geometry, filled in by param_changed
    // before the first frame ever arrives (PipeWire always sends the
    // format before data).
    let format = Arc::new(std::sync::Mutex::new(None::<pw::spa::param::video::VideoInfoRaw>));
    let format_for_param_changed = format.clone();

    // The portal delivers frames as fast as the compositor produces them --
    // observed ~80fps for a 2560x1440 monitor on this system, uncapped by
    // anything resembling a sane screen-share rate. At that rate each
    // frame (a multi-megabyte copy here, then a JS Buffer clone across
    // contextBridge, then a VideoFrame construction on the consumer side)
    // arrives faster than the JS side can plausibly keep up with, which is
    // exactly what a real deadlock/freeze in the Electron app traced back
    // to -- confirmed by a minimal Electron+addon-only repro (no JS video
    // pipeline at all) handling this same frame rate with zero issue,
    // isolating the problem to the volume of data hitting the JS side, not
    // this addon or PipeWire itself. Capping delivery well below any
    // plausible consumer's rate fixes that at the source rather than
    // hoping every future consumer gets its own backpressure exactly
    // right. The skipped buffer is still dequeued (and drops back to
    // PipeWire's pool when this scope ends) -- only the expensive copy +
    // JS callback are skipped, so the stream itself never stalls.
    // 60fps at full native monitor resolution reliably froze the whole
    // Electron app (confirmed live, no error) -- downscale_packed_4bpp
    // above cuts the per-frame byte volume (and so the contextBridge
    // clone + VideoFrame construction cost on the main thread) enough to
    // make 60fps *deliverable* again; MAX_FRAME_DIMENSION is what actually
    // enforces the size cap, this interval is the rate cap. Lowered from
    // 16ms (~60fps) after live-diagnosing a separate, worse memory
    // explosion (RSS 279MB -> 2GB in ~19s, confirmed via CDP that every
    // VideoFrame *was* being closed correctly -- see the fix in
    // screenShareAudio.ts -- yet native/off-heap memory still grew
    // linearly with frame count, ~2MB retained per frame). That's
    // Chromium's own internal encode/send pipeline backlogging: SPIKE.md
    // already measured this app's real achievable throughput to this
    // user's self-hosted LiveKit server at ~950kbps, and its own
    // simulcast layers topping out at 13-15fps regardless of how many
    // frames we hand it -- so 60fps of input was always mostly wasted
    // work, and turns out to actively grow an unbounded native queue
    // rather than just being dropped harmlessly. ~15fps matches what the
    // pipeline can actually drain.
    // Lowered again (15fps -> 10fps) chasing a hard RAM budget (500MB
    // during tests) for this whole feature -- the encode/send pipeline
    // was already only draining ~13-15fps per the simulcast stats noted
    // below, so 10fps costs little real quality and further shrinks how
    // much can pile up in that pipeline before it's actually sent.
    //
    // Both now caller-supplied (`CaptureOptions`, from the web app's own
    // screen-share quality picker via `getDisplayMedia`'s constraints --
    // see `start_capture`'s doc comment) instead of hardcoded. Full
    // history of why 1920/60fps became this addon's defaults, and the
    // live-confirmed freeze at 2560x1440@60fps (real main-thread
    // saturation from per-frame VideoFrame construction cost, NOT a
    // network or encode-side limit -- isolated via a minimal addon-only
    // repro with zero JS pipeline, which had no issue at the same rate)
    // is in SPIKE.md, not repeated here now that it's no longer a fixed
    // constant. Callers requesting resolutions above 1920 (e.g. the
    // "ultra" 1440p60fps quality) are knowingly re-entering that
    // previously-froze territory -- worth a fresh live test with real
    // RSS/CPU numbers before trusting it, same as any other value here.
    let min_frame_interval = std::time::Duration::from_millis(1000 / frame_rate.max(1) as u64);
    let last_frame_at = Arc::new(std::sync::Mutex::new(None::<std::time::Instant>));

    let _listener = stream
        .add_local_listener::<()>()
        .param_changed(move |_, _, id, param| {
            let Some(param) = param else { return };
            if id != pw::spa::param::ParamType::Format.as_raw() {
                return;
            }
            let mut info = pw::spa::param::video::VideoInfoRaw::new();
            if info.parse(param).is_ok() {
                *format_for_param_changed.lock().unwrap() = Some(info);
            }
        })
        .process(move |stream, _| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };

            let now = std::time::Instant::now();
            {
                let mut last = last_frame_at.lock().unwrap();
                if let Some(prev) = *last {
                    if now.duration_since(prev) < min_frame_interval {
                        return;
                    }
                }
                *last = Some(now);
            }

            let Some(info) = format.lock().unwrap().clone() else {
                return;
            };
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else {
                return;
            };
            let chunk_size = data.chunk().size() as usize;
            if chunk_size == 0 {
                return;
            }
            // PipeWire reports the real (possibly padded) row stride
            // per-buffer via the chunk itself -- deriving it from
            // chunk_size / height instead would be wrong for any
            // format/compositor that pads rows. Read before data.data()
            // below: that call borrows `data` mutably, and this chunk
            // accessor can't be called again while that borrow is live.
            let src_stride = data.chunk().stride() as u32;
            let Some(slice) = data.data() else {
                return;
            };
            let bytes = &slice[..chunk_size.min(slice.len())];
            let pixel_format = spa_format_to_webcodecs(info.format());

            // Only downscale formats downscale_packed_4bpp actually knows
            // how to walk (the same packed 4-bytes-per-pixel set
            // spa_format_to_webcodecs recognizes) -- anything else gets
            // dropped on the JS side regardless (pixel_format is None),
            // so there's no reason to risk an out-of-bounds read assuming
            // 4bpp on a format that might not be.
            let (data_vec, width, height, stride) = if pixel_format.is_some() {
                downscale_packed_4bpp(
                    bytes,
                    info.size().width,
                    info.size().height,
                    src_stride,
                    max_dimension,
                )
            } else {
                (bytes.to_vec(), info.size().width, info.size().height, src_stride)
            };

            let frame = FrameData {
                data: data_vec.into(),
                width,
                height,
                stride,
                format: info.format().as_raw(),
                pixel_format: pixel_format.map(str::to_string),
            };
            on_frame.call(Ok(frame), ThreadsafeFunctionCallMode::NonBlocking);
        })
        .register()?;

    let obj = pw::spa::pod::object!(
        pw::spa::utils::SpaTypes::ObjectParamFormat,
        pw::spa::param::ParamType::EnumFormat,
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaType,
            Id,
            pw::spa::param::format::MediaType::Video
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaSubtype,
            Id,
            pw::spa::param::format::MediaSubtype::Raw
        ),
    );
    let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(obj),
    )?
    .0
    .into_inner();
    let mut params = [pw::spa::pod::Pod::from_bytes(&values).unwrap()];

    stream.connect(
        pw::spa::utils::Direction::Input,
        Some(node_id),
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    )?;

    // The pipewire main loop has no built-in "check an external flag"
    // hook, so a short-interval timer is what lets `stop()` (called from
    // the Node/Electron side, on a different thread) actually break the
    // loop in a bounded amount of time instead of blocking forever.
    let poll_loop = main_loop.clone();
    let timer = main_loop.loop_().add_timer(move |_| {
        if stop_flag.load(Ordering::SeqCst) {
            poll_loop.quit();
        }
    });
    timer
        .update_timer(
            Some(std::time::Duration::from_millis(100)),
            Some(std::time::Duration::from_millis(100)),
        )
        .into_result()?;

    main_loop.run();
    Ok(())
}
