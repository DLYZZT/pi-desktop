use crate::error::{HelperError, Result};
use std::collections::BTreeMap;

const MAX_DEPTH: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    Integer(i64),
    String(String),
    Array(Vec<Self>),
    Object(BTreeMap<String, Self>),
}

impl Value {
    pub fn object(self) -> Result<BTreeMap<String, Self>> {
        match self {
            Self::Object(value) => Ok(value),
            _ => Err(HelperError::protocol("HELPER_INVALID_FRAME")),
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Parser<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn parse(mut self) -> Result<Value> {
        let value = self.value(0)?;
        self.space();
        if self.offset != self.bytes.len() {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        Ok(value)
    }

    fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > MAX_DEPTH {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        self.space();
        match self.peek() {
            Some(b'n') => {
                self.literal(b"null")?;
                Ok(Value::Null)
            }
            Some(b't') => {
                self.literal(b"true")?;
                Ok(Value::Bool(true))
            }
            Some(b'f') => {
                self.literal(b"false")?;
                Ok(Value::Bool(false))
            }
            Some(b'"') => self.string().map(Value::String),
            Some(b'[') => self.array(depth + 1),
            Some(b'{') => self.object(depth + 1),
            Some(b'-' | b'0'..=b'9') => self.integer().map(Value::Integer),
            _ => Err(HelperError::protocol("HELPER_INVALID_FRAME")),
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value> {
        self.expect(b'[')?;
        self.space();
        let mut values = Vec::new();
        if self.consume(b']') {
            return Ok(Value::Array(values));
        }
        loop {
            values.push(self.value(depth)?);
            self.space();
            if self.consume(b']') {
                break;
            }
            self.expect(b',')?;
        }
        Ok(Value::Array(values))
    }

    fn object(&mut self, depth: usize) -> Result<Value> {
        self.expect(b'{')?;
        self.space();
        let mut values = BTreeMap::new();
        if self.consume(b'}') {
            return Ok(Value::Object(values));
        }
        loop {
            self.space();
            let key = self.string()?;
            self.space();
            self.expect(b':')?;
            let value = self.value(depth)?;
            if values.insert(key, value).is_some() {
                return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
            }
            self.space();
            if self.consume(b'}') {
                break;
            }
            self.expect(b',')?;
        }
        Ok(Value::Object(values))
    }

    fn integer(&mut self) -> Result<i64> {
        let start = self.offset;
        self.consume(b'-');
        match self.peek() {
            Some(b'0') => {
                self.offset += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
                }
            }
            Some(b'1'..=b'9') => {
                self.offset += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.offset += 1;
                }
            }
            _ => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E' | b'+')) {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        let value = std::str::from_utf8(&self.bytes[start..self.offset])
            .map_err(|_| HelperError::protocol("HELPER_INVALID_FRAME"))?;
        value
            .parse::<i64>()
            .map_err(|_| HelperError::protocol("HELPER_INVALID_FRAME"))
    }

    fn string(&mut self) -> Result<String> {
        self.expect(b'"')?;
        let mut value = String::new();
        let mut segment_start = self.offset;
        loop {
            let byte = self
                .bytes
                .get(self.offset)
                .copied()
                .ok_or_else(|| HelperError::protocol("HELPER_INVALID_FRAME"))?;
            if byte == b'"' {
                value.push_str(
                    std::str::from_utf8(&self.bytes[segment_start..self.offset])
                        .map_err(|_| HelperError::protocol("HELPER_INVALID_FRAME"))?,
                );
                self.offset += 1;
                return Ok(value);
            }
            if byte < 0x20 {
                return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
            }
            if byte != b'\\' {
                self.offset += 1;
                continue;
            }
            value.push_str(
                std::str::from_utf8(&self.bytes[segment_start..self.offset])
                    .map_err(|_| HelperError::protocol("HELPER_INVALID_FRAME"))?,
            );
            self.offset += 1;
            let escaped = self
                .bytes
                .get(self.offset)
                .copied()
                .ok_or_else(|| HelperError::protocol("HELPER_INVALID_FRAME"))?;
            self.offset += 1;
            match escaped {
                b'"' => value.push('"'),
                b'\\' => value.push('\\'),
                b'/' => value.push('/'),
                b'b' => value.push('\u{08}'),
                b'f' => value.push('\u{0c}'),
                b'n' => value.push('\n'),
                b'r' => value.push('\r'),
                b't' => value.push('\t'),
                b'u' => {
                    let first = self.hex4()?;
                    let scalar = if (0xd800..=0xdbff).contains(&first) {
                        if self.bytes.get(self.offset..self.offset + 2) != Some(b"\\u") {
                            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
                        }
                        self.offset += 2;
                        let second = self.hex4()?;
                        if !(0xdc00..=0xdfff).contains(&second) {
                            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
                        }
                        0x1_0000 + ((first - 0xd800) << 10) + (second - 0xdc00)
                    } else if (0xdc00..=0xdfff).contains(&first) {
                        return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
                    } else {
                        first
                    };
                    value.push(
                        char::from_u32(scalar)
                            .ok_or_else(|| HelperError::protocol("HELPER_INVALID_FRAME"))?,
                    );
                }
                _ => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
            }
            segment_start = self.offset;
        }
    }

    fn hex4(&mut self) -> Result<u32> {
        let bytes = self
            .bytes
            .get(self.offset..self.offset + 4)
            .ok_or_else(|| HelperError::protocol("HELPER_INVALID_FRAME"))?;
        self.offset += 4;
        bytes.iter().try_fold(0_u32, |value, byte| {
            let digit = match byte {
                b'0'..=b'9' => u32::from(*byte - b'0'),
                b'a'..=b'f' => u32::from(*byte - b'a' + 10),
                b'A'..=b'F' => u32::from(*byte - b'A' + 10),
                _ => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
            };
            Ok((value << 4) | digit)
        })
    }

    fn literal(&mut self, expected: &[u8]) -> Result<()> {
        if self.bytes.get(self.offset..self.offset + expected.len()) != Some(expected) {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        self.offset += expected.len();
        Ok(())
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.offset += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.offset).copied()
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.peek() != Some(expected) {
            return false;
        }
        self.offset += 1;
        true
    }

    fn expect(&mut self, expected: u8) -> Result<()> {
        if self.consume(expected) {
            Ok(())
        } else {
            Err(HelperError::protocol("HELPER_INVALID_FRAME"))
        }
    }
}

pub fn parse(bytes: &[u8]) -> Result<Value> {
    std::str::from_utf8(bytes).map_err(|_| HelperError::protocol("HELPER_INVALID_FRAME"))?;
    Parser::new(bytes).parse()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unicode_surrogates_and_exact_objects() {
        let value = parse(br#"{"text":"x\ud83d\ude80","items":[1,true,null]}"#).unwrap();
        let object = value.object().unwrap();
        assert_eq!(object.get("text"), Some(&Value::String("x🚀".into())));
    }

    #[test]
    fn rejects_duplicate_keys_floats_and_lone_surrogates() {
        for value in [
            br#"{"x":1,"x":2}"#.as_slice(),
            br#"{"x":1.2}"#,
            br#"{"x":"\ud800"}"#,
        ] {
            assert!(parse(value).is_err());
        }
    }

    #[test]
    fn bounded_random_json_corpus_never_panics() {
        let mut seed = 0x7069_6a73_6f6e_667a_u64;
        for _ in 0..10_000 {
            seed = seed
                .wrapping_mul(2_862_933_555_777_941_757)
                .wrapping_add(3_037_000_493);
            let length = (seed as usize) & 0x7ff;
            let mut bytes = vec![0_u8; length];
            for byte in &mut bytes {
                seed = seed
                    .wrapping_mul(2_862_933_555_777_941_757)
                    .wrapping_add(3_037_000_493);
                *byte = (seed >> 33) as u8;
            }
            let _ = parse(&bytes);
        }
    }
}
