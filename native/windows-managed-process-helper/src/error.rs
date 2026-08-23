use std::fmt::{Display, Formatter};

#[derive(Debug, Clone)]
pub struct HelperError {
    pub subcode: &'static str,
    pub win32_code: u32,
}

impl HelperError {
    pub const fn protocol(subcode: &'static str) -> Self {
        Self {
            subcode,
            win32_code: 0,
        }
    }

    pub const fn win32(subcode: &'static str, win32_code: u32) -> Self {
        Self {
            subcode,
            win32_code,
        }
    }
}

impl Display for HelperError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} ({})", self.subcode, self.win32_code)
    }
}

impl std::error::Error for HelperError {}

pub type Result<T> = std::result::Result<T, HelperError>;
