use crate::error::{HelperError, Result};
use std::io::{ErrorKind, Read, Write};

pub const PROTOCOL_VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 16;
pub const MAX_CONTROL_BYTES: usize = 128 * 1024;
pub const MAX_BOOTSTRAP_BYTES: usize = 512 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

pub const HOST_BOOTSTRAP: u16 = 1;
pub const HOST_COMMIT: u16 = 2;
pub const HOST_STDIN: u16 = 3;
pub const HOST_CLOSE_STDIN: u16 = 4;
pub const HOST_STOP: u16 = 5;
pub const HOST_PING: u16 = 6;
pub const HOST_SHUTDOWN: u16 = 7;
pub const HOST_REAP: u16 = 8;
pub const HOST_SECURE_JOURNAL_DIRECTORY: u16 = 9;

pub const HELPER_HELLO: u16 = 0x100;
pub const HELPER_PREPARED: u16 = 0x101;
pub const HELPER_STARTED: u16 = 0x102;
pub const HELPER_STDOUT: u16 = 0x103;
pub const HELPER_STDERR: u16 = 0x104;
pub const HELPER_OUTPUT_DROPPED: u16 = 0x105;
pub const HELPER_STDIN_CLOSED: u16 = 0x106;
pub const HELPER_STOPPING: u16 = 0x107;
pub const HELPER_ACTIVE_ZERO: u16 = 0x108;
pub const HELPER_EXIT: u16 = 0x109;
pub const HELPER_ERROR: u16 = 0x10a;
pub const HELPER_PONG: u16 = 0x10b;
pub const HELPER_REAP_OUTCOME: u16 = 0x10c;
pub const HELPER_JOURNAL_DIRECTORY_SECURED: u16 = 0x10d;

#[derive(Debug, Clone)]
pub struct Frame {
    pub kind: u16,
    pub payload: Vec<u8>,
}

fn payload_limit(kind: u16) -> Option<usize> {
    match kind {
        HOST_BOOTSTRAP => Some(MAX_BOOTSTRAP_BYTES),
        HOST_COMMIT
        | HOST_STDIN
        | HOST_CLOSE_STDIN
        | HOST_STOP
        | HOST_PING
        | HOST_SHUTDOWN
        | HOST_REAP
        | HOST_SECURE_JOURNAL_DIRECTORY => Some(MAX_CONTROL_BYTES),
        _ => None,
    }
}

pub struct FrameReader<R> {
    input: R,
    expected_sequence: u32,
}

impl<R: Read> FrameReader<R> {
    pub const fn new(input: R) -> Self {
        Self {
            input,
            expected_sequence: 1,
        }
    }

    pub fn read(&mut self) -> Result<Option<Frame>> {
        let mut header = [0_u8; HEADER_BYTES];
        let mut offset = 0;
        while offset < header.len() {
            match self.input.read(&mut header[offset..]) {
                Ok(0) if offset == 0 => return Ok(None),
                Ok(0) => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
                Ok(read) => offset += read,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(_) => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
            }
        }
        if &header[0..4] != b"PIMP" {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        let version = u16::from_le_bytes([header[4], header[5]]);
        if version != PROTOCOL_VERSION {
            return Err(HelperError::protocol("HELPER_PROTOCOL_MISMATCH"));
        }
        let kind = u16::from_le_bytes([header[6], header[7]]);
        let length = u32::from_le_bytes([header[8], header[9], header[10], header[11]]) as usize;
        let sequence = u32::from_le_bytes([header[12], header[13], header[14], header[15]]);
        if sequence != self.expected_sequence {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        self.expected_sequence = self
            .expected_sequence
            .checked_add(1)
            .ok_or_else(|| HelperError::protocol("HELPER_INVALID_FRAME"))?;
        let limit =
            payload_limit(kind).ok_or_else(|| HelperError::protocol("HELPER_INVALID_FRAME"))?;
        if length > limit {
            return Err(HelperError::protocol(if kind == HOST_BOOTSTRAP {
                "HELPER_BOOTSTRAP_TOO_LARGE"
            } else {
                "HELPER_INVALID_FRAME"
            }));
        }
        let mut payload = vec![0_u8; length];
        self.input
            .read_exact(&mut payload)
            .map_err(|_| HelperError::protocol("HELPER_INVALID_FRAME"))?;
        Ok(Some(Frame { kind, payload }))
    }
}

pub struct FrameWriter<W> {
    output: W,
    next_sequence: u32,
}

impl<W: Write> FrameWriter<W> {
    pub const fn new(output: W) -> Self {
        Self {
            output,
            next_sequence: 1,
        }
    }

    pub fn write(&mut self, kind: u16, payload: &[u8]) -> Result<()> {
        let max = if matches!(kind, HELPER_STDOUT | HELPER_STDERR) {
            MAX_OUTPUT_BYTES
        } else {
            MAX_CONTROL_BYTES
        };
        if payload.len() > max {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        let length = u32::try_from(payload.len())
            .map_err(|_| HelperError::protocol("HELPER_INVALID_FRAME"))?;
        let mut header = [0_u8; HEADER_BYTES];
        header[0..4].copy_from_slice(b"PIMP");
        header[4..6].copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
        header[6..8].copy_from_slice(&kind.to_le_bytes());
        header[8..12].copy_from_slice(&length.to_le_bytes());
        header[12..16].copy_from_slice(&self.next_sequence.to_le_bytes());
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| HelperError::protocol("HELPER_INVALID_FRAME"))?;
        self.output
            .write_all(&header)
            .and_then(|()| self.output.write_all(payload))
            .and_then(|()| self.output.flush())
            .map_err(|_| HelperError::protocol("HELPER_PARENT_UNAVAILABLE"))
    }
}

pub fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            value if value <= '\u{1f}' => {
                use std::fmt::Write as _;
                let _ = write!(escaped, "\\u{:04x}", u32::from(value));
            }
            value => escaped.push(value),
        }
    }
    escaped.push('"');
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_round_trip_and_fragmented_read() {
        let mut bytes = Vec::new();
        FrameWriter::new(&mut bytes)
            .write(HELPER_STDOUT, b"hello\nworld")
            .unwrap();
        let mut reader = Cursor::new(bytes);
        let mut header = [0_u8; HEADER_BYTES];
        reader.read_exact(&mut header).unwrap();
        assert_eq!(&header[0..4], b"PIMP");
        assert_eq!(u16::from_le_bytes([header[6], header[7]]), HELPER_STDOUT);
        assert_eq!(u32::from_le_bytes(header[12..16].try_into().unwrap()), 1);
    }

    #[test]
    fn rejects_oversized_bootstrap_before_allocating() {
        let mut bytes = Vec::from(*b"PIMP\x01\x00\x01\x00");
        bytes.extend_from_slice(&((MAX_BOOTSTRAP_BYTES as u32) + 1).to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        let error = FrameReader::new(Cursor::new(bytes)).read().unwrap_err();
        assert_eq!(error.subcode, "HELPER_BOOTSTRAP_TOO_LARGE");
    }

    #[test]
    fn escapes_control_and_unicode_text() {
        assert_eq!(json_escape("a\n\"中"), "\"a\\n\\\"中\"");
    }

    #[test]
    fn bounded_random_frame_corpus_never_panics_or_overallocates() {
        let mut seed = 0x7069_6d70_6466_757a_u64;
        for index in 0..10_000_usize {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let length = (seed as usize) & 0x7ff;
            let mut bytes = vec![0_u8; length];
            for byte in &mut bytes {
                seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                *byte = (seed >> 32) as u8;
            }
            if index % 4 == 0 && bytes.len() >= HEADER_BYTES {
                bytes[0..4].copy_from_slice(b"PIMP");
                bytes[4..6].copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
                bytes[6..8].copy_from_slice(&HOST_REAP.to_le_bytes());
                let body = bytes.len() - HEADER_BYTES;
                bytes[8..12].copy_from_slice(&(body as u32).to_le_bytes());
                bytes[12..16].copy_from_slice(&1_u32.to_le_bytes());
            }
            let _ = FrameReader::new(Cursor::new(bytes)).read();
        }
    }
}
