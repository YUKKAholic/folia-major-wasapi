// native/wasapi/src/renderer.rs
//
// WASAPI exclusive-mode (bit-perfect) renderer driven from a dedicated COM thread.
//
// The renderer owns one playback thread that performs all WASAPI/COM work (MTA), while the
// public API only touches shared state (ring buffer + stats) so it can be called from any
// napi thread, including Node worker threads. Commands that change device state (open / start /
// stop / close) travel over an mpsc channel and report back through oneshot channels.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient, IAudioClock, IAudioRenderClient, IMMDevice,
    IMMDeviceEnumerator, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

const BUFFER_DURATION_HNS: i64 = 500_000; // 50 ms exclusive buffer
const PERIOD_HNS: i64 = 500_000; // 50 ms event period (must equal buffer in exclusive mode)
const EVENT_WAIT_TIMEOUT_MS: u32 = 100; // poll for commands while idle
const WRITE_BLOCK_TIMEOUT_MS: u64 = 500; // max block per write_pcm call

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RendererState {
    Idle,
    Ready,
    Playing,
    Stopped,
    Closed,
}

#[derive(Clone, Debug)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug)]
pub struct PcmFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub is_float: bool,
}

impl PcmFormat {
    fn bytes_per_sample(self) -> usize {
        if self.is_float {
            4
        } else {
            (self.bits_per_sample as usize + 7) / 8
        }
    }

    fn block_align(self) -> usize {
        self.channels as usize * self.bytes_per_sample()
    }

    fn to_waveformatex(self) -> WAVEFORMATEX {
        let block_align = self.block_align() as u16;
        WAVEFORMATEX {
            wFormatTag: if self.is_float {
                WAVE_FORMAT_IEEE_FLOAT as u16
            } else {
                WAVE_FORMAT_PCM as u16
            },
            nChannels: self.channels,
            nSamplesPerSec: self.sample_rate,
            nAvgBytesPerSec: self.sample_rate * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: if self.is_float {
                32
            } else {
                self.bits_per_sample
            },
            cbSize: 0,
        }
    }
}

// Statistics shared between the playback thread and the JS side.
struct Stats {
    position_frames: AtomicU64,
    frames_written: AtomicU64,
    event_count: AtomicU64,
    sample_rate: AtomicU64,
    block_align: AtomicU64,
    buffer_frames: AtomicU64,
    state: Mutex<RendererState>,
}

impl Default for Stats {
    fn default() -> Self {
        Self {
            position_frames: AtomicU64::new(0),
            frames_written: AtomicU64::new(0),
            event_count: AtomicU64::new(0),
            sample_rate: AtomicU64::new(0),
            block_align: AtomicU64::new(0),
            buffer_frames: AtomicU64::new(0),
            state: Mutex::new(RendererState::Idle),
        }
    }
}

// The ring buffer shared with the playback thread.
struct Ring {
    buf: VecDeque<u8>,
    capacity: usize,
}

impl Ring {
    fn new(capacity: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    fn available(&self) -> usize {
        self.capacity.saturating_sub(self.buf.len())
    }
}

struct Shared {
    ring: Mutex<Ring>,
    ring_cond: Condvar,
    stats: Stats,
}

enum Command {
    Open {
        device_id: String,
        format: PcmFormat,
        resp: Sender<Result<(), String>>,
    },
    Start {
        resp: Sender<Result<(), String>>,
    },
    Stop {
        resp: Sender<Result<(), String>>,
    },
    Close {
        resp: Sender<Result<(), String>>,
    },
}

pub struct WasapiRenderer {
    cmd_tx: Sender<Command>,
    shared: Arc<Shared>,
    handle: Option<JoinHandle<()>>,
}

impl WasapiRenderer {
    pub fn new() -> Result<Self, String> {
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            ring: Mutex::new(Ring::new(1024 * 1024)), // 1 MiB PCM ring
            ring_cond: Condvar::new(),
            stats: Stats::default(),
        });
        let thread_shared = Arc::clone(&shared);
        let handle = std::thread::Builder::new()
            .name("folia-wasapi".into())
            .spawn(move || playback_thread(thread_shared, cmd_rx))
            .map_err(|e| format!("failed to spawn WASAPI thread: {e}"))?;

        Ok(Self {
            cmd_tx,
            shared,
            handle: Some(handle),
        })
    }

    pub fn open_exclusive(&self, device_id: &str, format: PcmFormat) -> Result<(), String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        self.send(Command::Open {
            device_id: device_id.to_string(),
            format,
            resp: resp_tx,
        })?;
        recv_resp(resp_rx)
    }

    pub fn start(&self) -> Result<(), String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        self.send(Command::Start { resp: resp_tx })?;
        recv_resp(resp_rx)
    }

    pub fn stop(&self) -> Result<(), String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        self.send(Command::Stop { resp: resp_tx })?;
        recv_resp(resp_rx)
    }

    pub fn close(&self) -> Result<(), String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        // The thread may have already exited; ignore send failure on a closed channel.
        let _ = self.send(Command::Close { resp: resp_tx });
        let _ = resp_rx.recv_timeout(Duration::from_secs(2));
        Ok(())
    }

    fn send(&self, cmd: Command) -> Result<(), String> {
        self.cmd_tx
            .send(cmd)
            .map_err(|_| "WASAPI renderer thread has stopped".to_string())
    }

    /// Pushes PCM bytes into the ring buffer, blocking (with a timeout) when full.
    /// Returns the number of bytes actually accepted.
    pub fn write_pcm(&self, data: &[u8]) -> usize {
        let mut accepted = 0usize;
        let deadline = Instant::now() + Duration::from_millis(WRITE_BLOCK_TIMEOUT_MS);
        let mut guard = self.shared.ring.lock().unwrap();
        while accepted < data.len() {
            let avail = guard.available();
            if avail > 0 {
                let take = avail.min(data.len() - accepted);
                guard.buf.extend(&data[accepted..accepted + take]);
                accepted += take;
                continue;
            }
            if Instant::now() >= deadline {
                break;
            }
            let (next, _timeout) = self
                .shared
                .ring_cond
                .wait_timeout(guard, Duration::from_millis(50))
                .unwrap();
            guard = next;
        }
        self.shared.ring_cond.notify_all();
        accepted
    }

    pub fn get_position_ms(&self) -> f64 {
        let frames = self.shared.stats.position_frames.load(Ordering::SeqCst);
        let sample_rate = self.shared.stats.sample_rate.load(Ordering::SeqCst);
        if sample_rate == 0 {
            0.0
        } else {
            frames as f64 * 1000.0 / sample_rate as f64
        }
    }

    pub fn get_frames_written(&self) -> u64 {
        self.shared.stats.frames_written.load(Ordering::SeqCst)
    }

    pub fn get_diagnostics(&self) -> (u64, u64) {
        (
            self.shared.stats.event_count.load(Ordering::SeqCst),
            self.shared.stats.buffer_frames.load(Ordering::SeqCst),
        )
    }

    pub fn get_buffered_bytes(&self) -> u64 {
        self.shared.ring.lock().unwrap().buf.len() as u64
    }

    pub fn get_state(&self) -> RendererState {
        *self.shared.stats.state.lock().unwrap()
    }
}

impl Drop for WasapiRenderer {
    fn drop(&mut self) {
        let _ = self.close();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn recv_resp(rx: Receiver<Result<(), String>>) -> Result<(), String> {
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "WASAPI operation timed out".to_string())?
}

// The dedicated COM thread. Owns every WASAPI interface pointer.
fn playback_thread(shared: Arc<Shared>, cmd_rx: Receiver<Command>) {
    // COM must be initialized on this thread for the entire lifetime.
    unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }

    let mut client: Option<IAudioClient> = None;
    let mut render: Option<IAudioRenderClient> = None;
    let mut clock: Option<IAudioClock> = None;
    let mut event_handle: Option<HANDLE> = None;

    // The main loop blocks on commands; "Start" switches into the render loop.
    'outer: loop {
        let cmd = match cmd_rx.recv() {
            Ok(cmd) => cmd,
            Err(_) => break,
        };

        match cmd {
            Command::Open {
                device_id,
                format,
                resp,
            } => {
                let result = open_device(&device_id, format).and_then(
                    |(c, r, clk, evt, buffer_fr)| {
                        // Pre-fill the whole exclusive buffer with silence so the event-driven
                        // stream starts cleanly (Start() on an empty buffer never signals the
                        // render event on some drivers).
                        if let Ok(buf) = unsafe { r.GetBuffer(buffer_fr) } {
                            let bytes = buffer_fr as usize * format.block_align();
                            let dst = unsafe { std::slice::from_raw_parts_mut(buf, bytes) };
                            for b in dst.iter_mut() {
                                *b = 0;
                            }
                            unsafe { let _ = r.ReleaseBuffer(buffer_fr, 0); }
                        }
                        client = Some(c);
                        render = Some(r);
                        clock = Some(clk);
                        event_handle = Some(evt);
                        shared
                            .stats
                            .sample_rate
                            .store(format.sample_rate as u64, Ordering::SeqCst);
                        shared
                            .stats
                            .block_align
                            .store(format.block_align() as u64, Ordering::SeqCst);
                        shared.stats.buffer_frames.store(buffer_fr as u64, Ordering::SeqCst);
                        shared.stats.position_frames.store(0, Ordering::SeqCst);
                        *shared.stats.state.lock().unwrap() = RendererState::Ready;
                        Ok(())
                    },
                );
                let _ = resp.send(result);
            }
            Command::Start { resp } => {
                match (&client, &render, &clock, event_handle) {
                    (Some(c), Some(r), Some(clk), Some(evt)) => {
                        match unsafe { c.Start() } {
                            Ok(()) => {
                                *shared.stats.state.lock().unwrap() = RendererState::Playing;
                                let _ = resp.send(Ok(()));
                                // Block until stop or close is requested.
                                render_loop(c, r, clk, &shared, evt, &cmd_rx);
                            }
                            Err(e) => {
                                let _ = resp.send(Err(e.message()));
                            }
                        }
                    }
                    _ => {
                        let _ = resp.send(Err("WASAPI renderer is not open".to_string()));
                    }
                }
            }
            Command::Stop { resp } => {
                let result = if let Some(c) = client.as_ref() {
                    unsafe { c.Stop().map_err(|e| e.message()) }
                } else {
                    Ok(())
                };
                *shared.stats.state.lock().unwrap() = RendererState::Stopped;
                let _ = resp.send(result);
            }
            Command::Close { resp } => {
                if let Some(c) = client.as_ref() {
                    unsafe { let _ = c.Stop(); }
                }
                *shared.stats.state.lock().unwrap() = RendererState::Closed;
                let _ = resp.send(Ok(()));
                break 'outer;
            }
        }
    }

    // Cleanup: release the event, drop COM objects, uninitialize COM.
    if let Some(evt) = event_handle {
        unsafe { let _ = CloseHandle(evt); }
    }
    drop(clock);
    drop(render);
    drop(client);
    unsafe { CoUninitialize(); }
}

// Opens a device and initializes an exclusive event-driven audio client for the given format.
fn open_device(
    device_id: &str,
    format: PcmFormat,
) -> Result<(IAudioClient, IAudioRenderClient, IAudioClock, HANDLE, u32), String> {
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(
            &windows::Win32::Media::Audio::MMDeviceEnumerator,
            None,
            CLSCTX_ALL,
        )
    }
    .map_err(|e| format!("failed to create MMDeviceEnumerator: {}", e.message()))?;

    let device: IMMDevice = if device_id.is_empty() {
        unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|e| format!("failed to get default audio endpoint: {}", e.message()))?
    } else {
        find_device_by_id(&enumerator, device_id)?
    };

    let client: IAudioClient = unsafe { device.Activate::<IAudioClient>(CLSCTX_ALL, None) }
        .map_err(|e| format!("failed to activate IAudioClient: {}", e.message()))?;

    let wfx = format.to_waveformatex();
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            BUFFER_DURATION_HNS,
            PERIOD_HNS,
            &wfx,
            None,
        )
    }
    .map_err(|e| format!("exclusive initialize failed (format unsupported?): {:#010x}", e.code().0))?;

    let buffer_frames = unsafe { client.GetBufferSize() }
        .map_err(|e| format!("GetBufferSize failed: {}", e.message()))?;

    let render: IAudioRenderClient = unsafe { client.GetService::<IAudioRenderClient>() }
        .map_err(|e| format!("GetService(IAudioRenderClient) failed: {}", e.message()))?;

    let clock: IAudioClock = unsafe { client.GetService::<IAudioClock>() }
        .map_err(|e| format!("GetService(IAudioClock) failed: {}", e.message()))?;

    let event = unsafe { CreateEventW(None, false, false, None) }
        .map_err(|e| format!("CreateEventW failed: {}", e.message()))?;

    unsafe { client.SetEventHandle(event) }
        .map_err(|e| format!("SetEventHandle failed: {}", e.message()))?;

    Ok((client, render, clock, event, buffer_frames))
}

// The render loop: waits on the buffer event and writes the WHOLE buffer each time
// (exclusive event-driven mode uses ping-pong double buffering, so the packet size must
// always equal the buffer size). Mirrors the IAudioClock position back to shared stats.
fn render_loop(
    client: &IAudioClient,
    render: &IAudioRenderClient,
    clock: &IAudioClock,
    shared: &Arc<Shared>,
    event_handle: HANDLE,
    cmd_rx: &Receiver<Command>,
) {
    let buffer_frames = shared.stats.buffer_frames.load(Ordering::SeqCst) as u32;
    let bytes_per_frame = shared.stats.block_align.load(Ordering::SeqCst) as usize;
    let bytes_per_buffer = buffer_frames as usize * bytes_per_frame;

    loop {
        // Process control commands without blocking the audio event.
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                Command::Stop { resp } => {
                    unsafe { let _ = client.Stop(); }
                    *shared.stats.state.lock().unwrap() = RendererState::Stopped;
                    let _ = resp.send(Ok(()));
                    return;
                }
                Command::Close { resp } => {
                    unsafe { let _ = client.Stop(); }
                    *shared.stats.state.lock().unwrap() = RendererState::Closed;
                    let _ = resp.send(Ok(()));
                    return;
                }
                _ => {}
            }
        }

        let wait = unsafe { WaitForSingleObject(event_handle, EVENT_WAIT_TIMEOUT_MS) };
        if wait != WAIT_OBJECT_0 {
            // Timeout or error: just loop so commands keep being processed.
            continue;
        }
        shared.stats.event_count.fetch_add(1, Ordering::SeqCst);

        // Report the playback position from the hardware clock.
        let mut device_pos = 0u64;
        let mut qpc = 0u64;
        if unsafe { clock.GetPosition(&mut device_pos, Some(&mut qpc)) }.is_ok() {
            shared
                .stats
                .position_frames
                .store(device_pos, Ordering::SeqCst);
        }

        // Write the entire buffer (ping-pong: packet size must equal buffer size).
        let buffer = match unsafe { render.GetBuffer(buffer_frames) } {
            Ok(buf) => buf,
            Err(_) => continue,
        };
        let dst: &mut [u8] = unsafe { std::slice::from_raw_parts_mut(buffer, bytes_per_buffer) };

        // Drain the ring buffer; fill any shortfall with silence.
        let written = {
            let mut guard = shared.ring.lock().unwrap();
            let take = guard.buf.len().min(bytes_per_buffer);
            for i in 0..take {
                dst[i] = guard.buf.pop_front().unwrap();
            }
            shared.ring_cond.notify_all();
            take
        };
        if written < bytes_per_buffer {
            for byte in dst.iter_mut().skip(written) {
                *byte = 0;
            }
        }

        unsafe {
            let _ = render.ReleaseBuffer(buffer_frames, 0);
        }
        shared
            .stats
            .frames_written
            .fetch_add(buffer_frames as u64, Ordering::SeqCst);
    }
}

fn find_device_by_id(
    enumerator: &IMMDeviceEnumerator,
    device_id: &str,
) -> Result<IMMDevice, String> {
    let devices = enumerate_devices(enumerator)?;
    devices
        .into_iter()
        .find(|d| d.id == device_id)
        .map(|d| d.device)
        .ok_or_else(|| format!("output device not found: {device_id}"))
}

pub fn list_output_devices() -> Result<Vec<DeviceInfo>, String> {
    unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
    let result = (|| {
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(
                &windows::Win32::Media::Audio::MMDeviceEnumerator,
                None,
                CLSCTX_ALL,
            )
        }
        .map_err(|e| e.message())?;
        let devices = enumerate_devices(&enumerator)?;
        Ok(devices
            .into_iter()
            .map(|d| DeviceInfo {
                id: d.id,
                name: d.name,
            })
            .collect())
    })();
    unsafe { CoUninitialize(); }
    result
}

struct EnumeratedDevice {
    id: String,
    name: String,
    device: IMMDevice,
}

fn enumerate_devices(enumerator: &IMMDeviceEnumerator) -> Result<Vec<EnumeratedDevice>, String> {
    let collection = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }
        .map_err(|e| format!("EnumAudioEndpoints failed: {}", e.message()))?;

    let count = unsafe { collection.GetCount() }.map_err(|e| e.message())?;
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let device = match unsafe { collection.Item(i) } {
            Ok(d) => d,
            Err(_) => continue,
        };
        let id = device_id_string(&device).unwrap_or_default();
        let name = device_friendly_name(&device).unwrap_or_else(|_| id.clone());
        out.push(EnumeratedDevice { id, name, device });
    }
    Ok(out)
}

fn device_id_string(device: &IMMDevice) -> Result<String, String> {
    let pwstr = unsafe { device.GetId() }.map_err(|e| e.message())?;
    let result = unsafe { pwstr.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(pwstr.0 as *const core::ffi::c_void)) };
    Ok(result)
}

fn device_friendly_name(device: &IMMDevice) -> Result<String, String> {
    let store: IPropertyStore = unsafe { device.OpenPropertyStore(STGM_READ) }
        .map_err(|e| e.message())?;
    let mut pv = unsafe { store.GetValue(&PKEY_Device_FriendlyName) }
        .map_err(|e| e.message())?;
    // The friendly name is stored as VT_LPWSTR; read the wide string pointer directly.
    let name = unsafe {
        let pwsz = pv.Anonymous.Anonymous.Anonymous.pwszVal;
        if pwsz.0.is_null() {
            String::new()
        } else {
            pwsz.to_string().unwrap_or_default()
        }
    };
    unsafe { let _ = PropVariantClear(&mut pv); }
    Ok(name)
}
