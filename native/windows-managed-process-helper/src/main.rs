#![cfg_attr(not(windows), allow(dead_code))]

mod error;
mod json;
mod protocol;
mod state;
#[cfg(windows)]
mod win32;

#[cfg(windows)]
mod windows_main {
    use super::error::{HelperError, Result};
    use super::json::{self, Value};
    use super::protocol::{
        Frame, FrameReader, FrameWriter, HELPER_ACTIVE_ZERO, HELPER_ERROR, HELPER_EXIT,
        HELPER_HELLO, HELPER_JOURNAL_DIRECTORY_SECURED, HELPER_OUTPUT_DROPPED, HELPER_PONG,
        HELPER_PREPARED, HELPER_REAP_OUTCOME, HELPER_STARTED, HELPER_STDERR, HELPER_STDIN_CLOSED,
        HELPER_STDOUT, HELPER_STOPPING, HOST_BOOTSTRAP, HOST_CLOSE_STDIN, HOST_COMMIT, HOST_PING,
        HOST_REAP, HOST_SECURE_JOURNAL_DIRECTORY, HOST_SHUTDOWN, HOST_STDIN, HOST_STOP,
        PROTOCOL_VERSION,
    };
    use super::state::{
        Bootstrap, Commit, ReapRequest, SecureJournalDirectoryRequest, Stdin, Stop, StopMode,
    };
    use super::win32::{self, Job, Target};
    use std::io::{Read, Write};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc::{
        self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError,
    };
    use std::time::{Duration, Instant};

    const BUILD_ID: &str = match option_env!("PIMPD_BUILD_ID") {
        Some(value) => value,
        None => "pimpd-0.1.0-p1-dev",
    };
    const PROVENANCE: &str = match option_env!("PIMPD_PROVENANCE") {
        Some(value) => value,
        None => "source-dev",
    };

    #[derive(Debug)]
    struct Packet {
        kind: u16,
        payload: Vec<u8>,
    }

    #[derive(Clone)]
    struct EventSink {
        control: SyncSender<Packet>,
        output: SyncSender<Packet>,
        dropped_bytes: Arc<AtomicU64>,
        dropped_chunks: Arc<AtomicU64>,
    }

    impl EventSink {
        fn start() -> Self {
            let (control_tx, control_rx) = mpsc::sync_channel::<Packet>(64);
            let (output_tx, output_rx) = mpsc::sync_channel::<Packet>(256);
            std::thread::spawn(move || writer_loop(control_rx, output_rx));
            Self {
                control: control_tx,
                output: output_tx,
                dropped_bytes: Arc::new(AtomicU64::new(0)),
                dropped_chunks: Arc::new(AtomicU64::new(0)),
            }
        }

        fn send_control(&self, kind: u16, payload: Vec<u8>) -> Result<()> {
            self.flush_dropped()?;
            self.control
                .send(Packet { kind, payload })
                .map_err(|_| HelperError::protocol("HELPER_PARENT_UNAVAILABLE"))
        }

        fn send_json(&self, kind: u16, payload: String) -> Result<()> {
            self.send_control(kind, payload.into_bytes())
        }

        fn send_output(&self, kind: u16, payload: Vec<u8>) {
            let bytes = payload.len() as u64;
            match self.output.try_send(Packet { kind, payload }) {
                Ok(()) => {}
                Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                    self.dropped_bytes.fetch_add(bytes, Ordering::Relaxed);
                    self.dropped_chunks.fetch_add(1, Ordering::Relaxed);
                }
            }
        }

        fn flush_dropped(&self) -> Result<()> {
            let bytes = self.dropped_bytes.swap(0, Ordering::AcqRel);
            let chunks = self.dropped_chunks.swap(0, Ordering::AcqRel);
            if bytes == 0 && chunks == 0 {
                return Ok(());
            }
            let payload = format!(r#"{{"bytes":{bytes},"chunks":{chunks}}}"#).into_bytes();
            self.control
                .send(Packet {
                    kind: HELPER_OUTPUT_DROPPED,
                    payload,
                })
                .map_err(|_| HelperError::protocol("HELPER_PARENT_UNAVAILABLE"))
        }
    }

    fn writer_loop(control: Receiver<Packet>, output: Receiver<Packet>) {
        let mut writer = FrameWriter::new(std::io::stdout());
        loop {
            match control.try_recv() {
                Ok(packet) => {
                    if writer.write(packet.kind, &packet.payload).is_err() {
                        break;
                    }
                    continue;
                }
                Err(TryRecvError::Disconnected) => break,
                Err(TryRecvError::Empty) => {}
            }
            match output.recv_timeout(Duration::from_millis(20)) {
                Ok(packet) => {
                    if writer.write(packet.kind, &packet.payload).is_err() {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    match control.recv_timeout(Duration::from_millis(20)) {
                        Ok(packet) => {
                            if writer.write(packet.kind, &packet.payload).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    }

    enum ControlMessage {
        Frame(Frame),
        Eof,
        Error(HelperError),
    }

    fn start_control_reader() -> Receiver<ControlMessage> {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = FrameReader::new(std::io::stdin());
            loop {
                match reader.read() {
                    Ok(Some(frame)) => {
                        if sender.send(ControlMessage::Frame(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = sender.send(ControlMessage::Eof);
                        break;
                    }
                    Err(error) => {
                        let _ = sender.send(ControlMessage::Error(error));
                        break;
                    }
                }
            }
        });
        receiver
    }

    fn hello() -> String {
        format!(
            r#"{{"protocolVersion":{},"buildId":{},"arch":"x64","provenance":{},"capabilities":["job","two-phase","owner-watchdog","reaper"]}}"#,
            PROTOCOL_VERSION,
            super::protocol::json_escape(BUILD_ID),
            super::protocol::json_escape(PROVENANCE),
        )
    }

    fn error_json(error: &HelperError) -> String {
        format!(
            r#"{{"subcode":{},"win32Code":{}}}"#,
            super::protocol::json_escape(error.subcode),
            error.win32_code
        )
    }

    fn control_with_timeout(
        receiver: &Receiver<ControlMessage>,
        timeout: Duration,
    ) -> Result<Frame> {
        match receiver.recv_timeout(timeout) {
            Ok(ControlMessage::Frame(frame)) => Ok(frame),
            Ok(ControlMessage::Eof) => Err(HelperError::protocol("HELPER_PARENT_UNAVAILABLE")),
            Ok(ControlMessage::Error(error)) => Err(error),
            Err(_) => Err(HelperError::protocol("HELPER_PARENT_UNAVAILABLE")),
        }
    }

    fn drain(mut input: std::fs::File, kind: u16, sink: EventSink) {
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => sink.send_output(kind, buffer[..read].to_vec()),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    }

    fn parse_ping(bytes: &[u8]) -> Result<u64> {
        let mut object = json::parse(bytes)?.object()?;
        let value = match object.remove("sequence") {
            Some(Value::Integer(value)) if value >= 0 => value as u64,
            _ => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
        };
        if !object.is_empty() {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        Ok(value)
    }

    fn stop_job(
        job: &Job,
        process_group_id: u32,
        mode: StopMode,
        sink: &EventSink,
    ) -> Result<&'static str> {
        if mode == StopMode::Graceful {
            sink.send_json(HELPER_STOPPING, r#"{"phase":"interrupt"}"#.into())?;
            let _ = win32::send_ctrl_c();
            if job.wait_empty(Duration::from_secs(2))? {
                return Ok("CTRL_C_EVENT");
            }
            sink.send_json(HELPER_STOPPING, r#"{"phase":"terminate"}"#.into())?;
            let _ = win32::send_ctrl_break(process_group_id);
            if job.wait_empty(Duration::from_secs(3))? {
                return Ok("CTRL_BREAK_EVENT");
            }
        }
        sink.send_json(HELPER_STOPPING, r#"{"phase":"force"}"#.into())?;
        job.terminate()?;
        if !job.wait_empty(Duration::from_millis(1_500))? {
            return Err(HelperError::protocol("JOB_TERMINATE_FAILED"));
        }
        Ok("JOB_TERMINATE")
    }

    fn owner_mode(sink: &EventSink) -> Result<()> {
        let receiver = start_control_reader();
        let frame = control_with_timeout(&receiver, Duration::from_secs(10))?;
        if frame.kind != HOST_BOOTSTRAP {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        let bootstrap = Bootstrap::parse(&frame.payload)?;
        let owners = win32::open_owner_handles(&bootstrap)?;
        let job = Arc::new(Job::create(&bootstrap.job_name)?);
        let mut target = Target::prepare(&bootstrap, &job)?;
        let helper_fingerprint = win32::current_process_fingerprint(BUILD_ID)?;
        sink.send_json(
            HELPER_PREPARED,
            format!(
                r#"{{"helperPid":{},"helperStartFingerprint":{},"jobName":{},"helperBuildId":{},"nonce":{},"hostInstanceId":{}}}"#,
                std::process::id(),
                super::protocol::json_escape(&helper_fingerprint),
                super::protocol::json_escape(&bootstrap.job_name),
                super::protocol::json_escape(BUILD_ID),
                super::protocol::json_escape(&bootstrap.nonce),
                super::protocol::json_escape(&bootstrap.host_instance_id),
            ),
        )?;
        let commit_frame = control_with_timeout(&receiver, Duration::from_secs(5))?;
        if commit_frame.kind != HOST_COMMIT {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        let commit = Commit::parse(&commit_frame.payload)?;
        if commit.nonce != bootstrap.nonce {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        target.resume()?;
        let pipes = target.take_pipes()?;
        let mut target_stdin = Some(pipes.stdin);
        let stdout_sink = sink.clone();
        std::thread::spawn(move || drain(pipes.stdout, HELPER_STDOUT, stdout_sink));
        let stderr_sink = sink.clone();
        std::thread::spawn(move || drain(pipes.stderr, HELPER_STDERR, stderr_sink));
        let owner_lost = Arc::new(AtomicBool::new(false));
        let watchdog_lost = Arc::clone(&owner_lost);
        let watchdog_job = Arc::clone(&job);
        std::thread::spawn(move || {
            if win32::wait_for_owner_loss(owners).is_ok() {
                watchdog_lost.store(true, Ordering::Release);
                let _ = watchdog_job.terminate();
            }
        });
        sink.send_json(
            HELPER_STARTED,
            format!(
                r#"{{"hostInstanceId":{},"journalRevision":{}}}"#,
                super::protocol::json_escape(&bootstrap.host_instance_id),
                commit.journal_revision,
            ),
        )?;

        let mut stopped: Option<(String, &'static str)> = None;
        let mut root_exit_at: Option<Instant> = None;
        let mut root_code: Option<u32> = None;
        loop {
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(ControlMessage::Frame(frame)) => match frame.kind {
                    HOST_STDIN => {
                        let input = Stdin::parse(&frame.payload)?;
                        if let Some(stdin) = target_stdin.as_mut() {
                            let written = stdin.write_all(input.text.as_bytes()).and_then(|()| {
                                if input.append_newline {
                                    stdin.write_all(b"\n")
                                } else {
                                    Ok(())
                                }
                            });
                            if written.is_err() {
                                target_stdin = None;
                                sink.send_json(HELPER_STDIN_CLOSED, "{}".into())?;
                            }
                        } else {
                            sink.send_json(HELPER_STDIN_CLOSED, "{}".into())?;
                        }
                    }
                    HOST_CLOSE_STDIN => {
                        target_stdin = None;
                        sink.send_json(HELPER_STDIN_CLOSED, "{}".into())?;
                    }
                    HOST_STOP | HOST_SHUTDOWN => {
                        let stop = if frame.kind == HOST_STOP {
                            Stop::parse(&frame.payload)?
                        } else {
                            Stop {
                                mode: StopMode::Graceful,
                                source: "host".into(),
                            }
                        };
                        let signal = stop_job(&job, target.process_id, stop.mode, sink)?;
                        stopped = Some((stop.source, signal));
                    }
                    HOST_PING => {
                        let sequence = parse_ping(&frame.payload)?;
                        sink.send_json(HELPER_PONG, format!(r#"{{"sequence":{sequence}}}"#))?;
                    }
                    _ => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
                },
                Ok(ControlMessage::Eof) => {
                    owner_lost.store(true, Ordering::Release);
                    job.terminate()?;
                }
                Ok(ControlMessage::Error(error)) => return Err(error),
                Err(RecvTimeoutError::Disconnected) => {
                    owner_lost.store(true, Ordering::Release);
                    job.terminate()?;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }

            if root_code.is_none() {
                root_code = target.exit_code()?;
                if root_code.is_some() {
                    root_exit_at = Some(Instant::now());
                }
            }
            let active = job.active_processes()?;
            if active == 0 {
                sink.send_json(HELPER_ACTIVE_ZERO, "{}".into())?;
                let exit = if let Some((source, signal)) = stopped {
                    format!(
                        r#"{{"code":null,"signal":{},"reason":"stopped","source":{}}}"#,
                        super::protocol::json_escape(signal),
                        super::protocol::json_escape(&source)
                    )
                } else if owner_lost.load(Ordering::Acquire) {
                    r#"{"code":null,"reason":"host-failure"}"#.into()
                } else {
                    format!(
                        r#"{{"code":{},"reason":"exit"}}"#,
                        root_code.map_or_else(|| "null".into(), |value| value.to_string())
                    )
                };
                sink.send_json(HELPER_EXIT, exit)?;
                std::thread::sleep(Duration::from_millis(100));
                return Ok(());
            }
            if stopped.is_some() {
                return Err(HelperError::protocol("JOB_TERMINATE_FAILED"));
            }
            if root_exit_at.is_some_and(|started| started.elapsed() >= Duration::from_secs(1)) {
                let _ = stop_job(&job, target.process_id, StopMode::Force, sink)?;
                stopped = Some(("host".into(), "JOB_TERMINATE"));
            }
        }
    }

    fn reaper_mode(sink: &EventSink) -> Result<()> {
        let receiver = start_control_reader();
        let frame = control_with_timeout(&receiver, Duration::from_secs(5))?;
        if frame.kind == HOST_SECURE_JOURNAL_DIRECTORY {
            let request = SecureJournalDirectoryRequest::parse(&frame.payload)?;
            win32::secure_journal_directory(&request.path)?;
            sink.send_json(
                HELPER_JOURNAL_DIRECTORY_SECURED,
                r#"{"secured":true}"#.into(),
            )?;
            std::thread::sleep(Duration::from_millis(100));
            return Ok(());
        }
        if frame.kind != HOST_REAP {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        let request = ReapRequest::parse(&frame.payload)?;
        let Some(job) = Job::open_for_reap(&request.job_name)? else {
            sink.send_json(HELPER_REAP_OUTCOME, r#"{"outcome":"already-empty"}"#.into())?;
            std::thread::sleep(Duration::from_millis(100));
            return Ok(());
        };
        let Some(owner) = win32::open_reap_owner(
            request.helper_pid,
            &request.helper_start_fingerprint,
            &request.helper_build_id,
        )?
        else {
            sink.send_json(
                HELPER_REAP_OUTCOME,
                r#"{"outcome":"identity-uncertain"}"#.into(),
            )?;
            std::thread::sleep(Duration::from_millis(100));
            return Ok(());
        };
        if job.active_processes()? > 0 {
            job.terminate()?;
        }
        if !job.wait_empty(Duration::from_millis(1_500))? {
            return Err(HelperError::protocol("JOB_TERMINATE_FAILED"));
        }
        win32::terminate_reap_owner(&owner)?;
        sink.send_json(HELPER_REAP_OUTCOME, r#"{"outcome":"removed"}"#.into())?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    fn version_mode() {
        println!(
            r#"{{"protocolVersion":{},"buildId":{},"arch":"x64","provenance":{}}}"#,
            PROTOCOL_VERSION,
            super::protocol::json_escape(BUILD_ID),
            super::protocol::json_escape(PROVENANCE),
        );
    }

    fn self_test_mode() -> Result<()> {
        let job_name = format!(
            r"Local\PiDesktop.Managed.SelfTest.{:08x}",
            std::process::id()
        );
        let job = Job::create(&job_name)?;
        if job.active_processes()? != 0 {
            return Err(HelperError::protocol("JOB_QUERY_FAILED"));
        }
        println!(
            r#"{{"ok":true,"protocolVersion":{},"buildId":{},"arch":"x64","checks":["job-dacl","kill-on-close","completion-port","accounting"]}}"#,
            PROTOCOL_VERSION,
            super::protocol::json_escape(BUILD_ID),
        );
        Ok(())
    }

    pub fn run() -> i32 {
        let mode = std::env::args().nth(1);
        let _executable_lock = if matches!(
            mode.as_deref(),
            Some("--owner-stdio-v1") | Some("--reap-stdio-v1")
        ) {
            match win32::lock_current_executable() {
                Ok(lock) => Some(lock),
                Err(_) => return 2,
            }
        } else {
            None
        };
        if mode.as_deref() == Some("--version-json-v1") {
            version_mode();
            return 0;
        }
        if mode.as_deref() == Some("--self-test-json-v1") {
            return match self_test_mode() {
                Ok(()) => 0,
                Err(_) => 2,
            };
        }
        let sink = EventSink::start();
        if sink.send_json(HELPER_HELLO, hello()).is_err() {
            return 2;
        }
        let result = match mode.as_deref() {
            Some("--owner-stdio-v1") => owner_mode(&sink),
            Some("--reap-stdio-v1") => reaper_mode(&sink),
            _ => Err(HelperError::protocol("HELPER_PROTOCOL_MISMATCH")),
        };
        match result {
            Ok(()) => 0,
            Err(error) => {
                let _ = sink.send_json(HELPER_ERROR, error_json(&error));
                // Give the dedicated writer a bounded chance to emit the fixed
                // diagnostic before process teardown closes the Job handle.
                std::thread::sleep(Duration::from_millis(200));
                2
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    std::process::exit(windows_main::run());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("pi-windows-managed-process-helper only runs on Windows x64");
    std::process::exit(2);
}
