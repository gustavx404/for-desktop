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

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

#[napi(object)]
pub struct FrameData {
    /// Raw pixel data for one frame. Format is whatever the compositor
    /// negotiated -- format/stride/size below describe how to interpret
    /// it. Handed to JS as a Buffer with no extra copy on our side.
    pub data: Buffer,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    /// SPA video format id (spa::param::format::VideoFormat as u32) --
    /// the consumer maps this to a WebCodecs VideoPixelFormat string.
    pub format: u32,
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
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

/// Starts a screen/window capture session. `on_frame` is called once per
/// captured frame; `on_error` once if the portal negotiation or PipeWire
/// stream setup fails (the capture thread exits after that, nothing
/// further will be called). Returns a handle to stop the capture.
#[napi]
pub fn start_capture(
    on_frame: ThreadsafeFunction<FrameData, ErrorStrategy::CalleeHandled>,
    on_error: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
) -> Result<CaptureHandle> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = stop_flag.clone();

    let join_handle = std::thread::spawn(move || {
        if let Err(err) = run_capture(thread_stop_flag, on_frame) {
            on_error.call(Ok(err.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
        }
    });

    Ok(CaptureHandle {
        stop_flag,
        join_handle: Some(join_handle),
    })
}

fn run_capture(
    stop_flag: Arc<AtomicBool>,
    on_frame: ThreadsafeFunction<FrameData, ErrorStrategy::CalleeHandled>,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let rt = tokio::runtime::Runtime::new()?;
    let (fd, node_id) = rt.block_on(negotiate_portal())?;
    capture_loop(fd, node_id, stop_flag, on_frame)
}

async fn negotiate_portal(
) -> std::result::Result<(std::os::fd::OwnedFd, u32), Box<dyn std::error::Error>> {
    use ashpd::desktop::screencast::{
        CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType,
        StartCastOptions,
    };
    use ashpd::desktop::PersistMode;
    use ashpd::enumflags2::BitFlags;

    let proxy = Screencast::new().await?;
    let session = proxy.create_session(Default::default()).await?;

    let select_options = SelectSourcesOptions::default()
        .set_cursor_mode(CursorMode::Hidden)
        .set_sources(BitFlags::from(SourceType::Monitor) | SourceType::Window)
        .set_multiple(false)
        .set_persist_mode(PersistMode::DoNot);
    proxy
        .select_sources(&session, select_options)
        .await?
        .response()?;

    let response = proxy
        .start(&session, None, StartCastOptions::default())
        .await?
        .response()?;

    let stream = response
        .streams()
        .first()
        .ok_or("portal returned no streams")?;
    let node_id = stream.pipe_wire_node_id();

    let fd = proxy
        .open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default())
        .await?;
    Ok((fd, node_id))
}

fn capture_loop(
    fd: std::os::fd::OwnedFd,
    node_id: u32,
    stop_flag: Arc<AtomicBool>,
    on_frame: ThreadsafeFunction<FrameData, ErrorStrategy::CalleeHandled>,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    use pipewire as pw;

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
            let Some(slice) = data.data() else {
                return;
            };
            let bytes = &slice[..chunk_size.min(slice.len())];

            let frame = FrameData {
                data: bytes.to_vec().into(),
                width: info.size().width,
                height: info.size().height,
                stride: (chunk_size as u32) / info.size().height.max(1),
                format: info.format().as_raw(),
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
