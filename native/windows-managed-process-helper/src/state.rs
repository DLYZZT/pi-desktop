use crate::error::{HelperError, Result};
use crate::json::{self, Value};
use std::collections::BTreeMap;

pub const MAX_ENVIRONMENT_ENTRIES: usize = 4096;
pub const MAX_ENVIRONMENT_JSON_BYTES: usize = 256 * 1024;
pub const MAX_ENVIRONMENT_BLOCK_BYTES: usize = 256 * 1024;
pub const MAX_METADATA_JSON_BYTES: usize = 32 * 1024;
pub const MAX_COMMAND_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone)]
pub struct Bootstrap {
    pub job_name: String,
    pub nonce: String,
    pub cwd: String,
    pub shell_executable: String,
    pub argv_prefix: Vec<String>,
    pub command: String,
    pub environment: BTreeMap<String, String>,
    pub main_pid: u32,
    pub main_start_time_ms: u64,
    pub main_image_path: String,
    pub host_pid: u32,
    pub host_start_time_ms: u64,
    pub host_image_path: String,
    pub host_instance_id: String,
}

#[derive(Debug, Clone)]
pub struct Commit {
    pub nonce: String,
    pub journal_revision: u64,
}

#[derive(Debug, Clone)]
pub struct Stdin {
    pub text: String,
    pub append_newline: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    Graceful,
    Force,
}

#[derive(Debug, Clone)]
pub struct Stop {
    pub mode: StopMode,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct ReapRequest {
    pub job_name: String,
    pub helper_pid: u32,
    pub helper_start_fingerprint: String,
    pub helper_build_id: String,
}

#[derive(Debug, Clone)]
pub struct SecureJournalDirectoryRequest {
    pub path: String,
}

fn take_string(
    object: &mut BTreeMap<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<String> {
    match object.remove(key) {
        Some(Value::String(value))
            if !value.is_empty()
                && value.len() <= max_bytes
                && !value.as_bytes().contains(&0)
                && !value.contains(['\r', '\n']) =>
        {
            Ok(value)
        }
        _ => Err(HelperError::protocol("HELPER_INVALID_FRAME")),
    }
}

fn take_integer(object: &mut BTreeMap<String, Value>, key: &str) -> Result<u64> {
    match object.remove(key) {
        Some(Value::Integer(value)) if value >= 0 => Ok(value as u64),
        _ => Err(HelperError::protocol("HELPER_INVALID_FRAME")),
    }
}

fn take_bool(object: &mut BTreeMap<String, Value>, key: &str) -> Result<bool> {
    match object.remove(key) {
        Some(Value::Bool(value)) => Ok(value),
        _ => Err(HelperError::protocol("HELPER_INVALID_FRAME")),
    }
}

fn exact(object: &BTreeMap<String, Value>) -> Result<()> {
    if object.is_empty() {
        Ok(())
    } else {
        Err(HelperError::protocol("HELPER_INVALID_FRAME"))
    }
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}

fn valid_job_name(value: &str) -> bool {
    value
        .strip_prefix("Local\\PiDesktop.Managed.")
        .is_some_and(valid_hash)
}

fn valid_bootstrap_path(value: &str) -> bool {
    let normalized = value.replace('/', "\\");
    std::path::Path::new(value).is_absolute()
        && !normalized.starts_with(r"\\?\")
        && !normalized.starts_with(r"\\.\")
        && !normalized.starts_with(r"\??\")
}

fn normalized_environment(value: Value) -> Result<BTreeMap<String, String>> {
    let Value::Object(values) = value else {
        return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
    };
    if values.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(HelperError::protocol("TARGET_ENVIRONMENT_TOO_LARGE"));
    }
    let mut folded = BTreeMap::<String, (String, String)>::new();
    let mut serialized_bytes = 2_usize;
    for (key, value) in values {
        let Value::String(value) = value else {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        };
        if key.is_empty()
            || key.contains(['\0', '='])
            || value.contains('\0')
            || key.encode_utf16().count() + value.encode_utf16().count() + 2 > 32_767
        {
            return Err(HelperError::protocol("TARGET_ENVIRONMENT_TOO_LARGE"));
        }
        let comparable = key.to_lowercase();
        if comparable == "electron_run_as_node" {
            continue;
        }
        serialized_bytes = serialized_bytes
            .saturating_add(crate::protocol::json_escape(&key).len())
            .saturating_add(crate::protocol::json_escape(&value).len())
            .saturating_add(2);
        if serialized_bytes > MAX_ENVIRONMENT_JSON_BYTES {
            return Err(HelperError::protocol("TARGET_ENVIRONMENT_TOO_LARGE"));
        }
        if folded.insert(comparable, (key, value)).is_some() {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
    }
    Ok(folded.into_values().collect())
}

impl Bootstrap {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > crate::protocol::MAX_BOOTSTRAP_BYTES {
            return Err(HelperError::protocol("HELPER_BOOTSTRAP_TOO_LARGE"));
        }
        let mut object = json::parse(bytes)?.object()?;
        if take_integer(&mut object, "version")? != 1 {
            return Err(HelperError::protocol("HELPER_PROTOCOL_MISMATCH"));
        }
        let process_id_hash = take_string(&mut object, "processIdHash", 64)?;
        let run_id_hash = take_string(&mut object, "runIdHash", 64)?;
        let job_name = take_string(&mut object, "jobName", 128)?;
        let nonce = take_string(&mut object, "nonce", 128)?;
        let cwd = take_string(&mut object, "cwd", 4096)?;
        let shell_executable = take_string(&mut object, "shellExecutable", 4096)?;
        let command = take_string(&mut object, "command", MAX_COMMAND_BYTES)?;
        let argv_prefix = match object.remove("argvPrefix") {
            Some(Value::Array(values)) if values.len() <= 32 => values
                .into_iter()
                .map(|value| match value {
                    Value::String(value)
                        if value.len() <= 4096 && !value.contains(['\0', '\r', '\n']) =>
                    {
                        Ok(value)
                    }
                    _ => Err(HelperError::protocol("HELPER_INVALID_FRAME")),
                })
                .collect::<Result<Vec<_>>>()?,
            _ => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
        };
        let environment = normalized_environment(
            object
                .remove("environment")
                .ok_or_else(|| HelperError::protocol("HELPER_INVALID_FRAME"))?,
        )?;
        let main_pid = u32::try_from(take_integer(&mut object, "mainPid")?)
            .map_err(|_| HelperError::protocol("HELPER_PARENT_UNAVAILABLE"))?;
        let main_start_time_ms = take_integer(&mut object, "mainStartTimeMs")?;
        let main_image_path = take_string(&mut object, "mainImagePath", 4096)?;
        let host_pid = u32::try_from(take_integer(&mut object, "hostPid")?)
            .map_err(|_| HelperError::protocol("HELPER_PARENT_UNAVAILABLE"))?;
        let host_start_time_ms = take_integer(&mut object, "hostStartTimeMs")?;
        let host_image_path = take_string(&mut object, "hostImagePath", 4096)?;
        let host_instance_id = take_string(&mut object, "hostInstanceId", 64)?;
        exact(&object)?;
        let argv_metadata = argv_prefix
            .iter()
            .map(|value| crate::protocol::json_escape(value))
            .collect::<Vec<_>>()
            .join(",");
        let metadata_bytes = format!(
            r#"{{"version":1,"processIdHash":{},"runIdHash":{},"jobName":{},"nonce":{},"cwd":{},"shellExecutable":{},"argvPrefix":[{}],"command":"","environment":{{}},"mainPid":{},"mainStartTimeMs":{},"mainImagePath":{},"hostPid":{},"hostStartTimeMs":{},"hostImagePath":{},"hostInstanceId":{}}}"#,
            crate::protocol::json_escape(&process_id_hash),
            crate::protocol::json_escape(&run_id_hash),
            crate::protocol::json_escape(&job_name),
            crate::protocol::json_escape(&nonce),
            crate::protocol::json_escape(&cwd),
            crate::protocol::json_escape(&shell_executable),
            argv_metadata,
            main_pid,
            main_start_time_ms,
            crate::protocol::json_escape(&main_image_path),
            host_pid,
            host_start_time_ms,
            crate::protocol::json_escape(&host_image_path),
            crate::protocol::json_escape(&host_instance_id),
        )
        .len();
        if !valid_hash(&process_id_hash)
            || !valid_hash(&run_id_hash)
            || !valid_job_name(&job_name)
            || !valid_hash(&nonce)
            || !valid_uuid(&host_instance_id)
            || main_pid <= 1
            || host_pid <= 1
            || main_start_time_ms == 0
            || host_start_time_ms == 0
            || !valid_bootstrap_path(&cwd)
            || !valid_bootstrap_path(&shell_executable)
            || command.len() > MAX_COMMAND_BYTES
        {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        if metadata_bytes > MAX_METADATA_JSON_BYTES {
            return Err(HelperError::protocol("HELPER_BOOTSTRAP_TOO_LARGE"));
        }
        Ok(Self {
            job_name,
            nonce,
            cwd,
            shell_executable,
            argv_prefix,
            command,
            environment,
            main_pid,
            main_start_time_ms,
            main_image_path,
            host_pid,
            host_start_time_ms,
            host_image_path,
            host_instance_id,
        })
    }
}

impl Commit {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut object = json::parse(bytes)?.object()?;
        let nonce = take_string(&mut object, "nonce", 128)?;
        let journal_revision = take_integer(&mut object, "journalRevision")?;
        exact(&object)?;
        if !valid_hash(&nonce) || journal_revision == 0 {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        Ok(Self {
            nonce,
            journal_revision,
        })
    }
}

impl Stdin {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut object = json::parse(bytes)?.object()?;
        let text = match object.remove("text") {
            Some(Value::String(value)) if value.len() <= 64 * 1024 => value,
            _ => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
        };
        let append_newline = take_bool(&mut object, "appendNewline")?;
        exact(&object)?;
        Ok(Self {
            text,
            append_newline,
        })
    }
}

impl Stop {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut object = json::parse(bytes)?.object()?;
        let mode = match take_string(&mut object, "mode", 16)?.as_str() {
            "graceful" => StopMode::Graceful,
            "force" => StopMode::Force,
            _ => return Err(HelperError::protocol("HELPER_INVALID_FRAME")),
        };
        let source = take_string(&mut object, "source", 16)?;
        if !matches!(source.as_str(), "agent" | "user" | "host" | "main") {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        exact(&object)?;
        Ok(Self { mode, source })
    }
}

impl ReapRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut object = json::parse(bytes)?.object()?;
        let job_name = take_string(&mut object, "jobName", 128)?;
        let helper_pid = u32::try_from(take_integer(&mut object, "helperPid")?)
            .map_err(|_| HelperError::protocol("HELPER_INVALID_FRAME"))?;
        let helper_start_fingerprint = take_string(&mut object, "helperStartFingerprint", 512)?;
        let helper_build_id = take_string(&mut object, "helperBuildId", 128)?;
        let nonce = take_string(&mut object, "nonce", 128)?;
        exact(&object)?;
        if !valid_job_name(&job_name)
            || !valid_hash(&nonce)
            || helper_pid <= 1
            || helper_build_id.is_empty()
            || !job_name.ends_with(&nonce)
        {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        Ok(Self {
            job_name,
            helper_pid,
            helper_start_fingerprint,
            helper_build_id,
        })
    }
}

impl SecureJournalDirectoryRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut object = json::parse(bytes)?.object()?;
        let path = take_string(&mut object, "path", 4096)?;
        exact(&object)?;
        if !std::path::Path::new(&path).is_absolute() {
            return Err(HelperError::protocol("HELPER_INVALID_FRAME"));
        }
        Ok(Self { path })
    }
}

pub fn build_environment_block(environment: &BTreeMap<String, String>) -> Result<Vec<u16>> {
    let mut pairs: Vec<_> = environment.iter().collect();
    pairs.sort_by_key(|left| left.0.to_lowercase());
    let mut block = Vec::new();
    for (key, value) in pairs {
        block.extend(key.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    if block.len().saturating_mul(2) > MAX_ENVIRONMENT_BLOCK_BYTES {
        return Err(HelperError::protocol("TARGET_ENVIRONMENT_TOO_LARGE"));
    }
    Ok(block)
}

pub fn quote_windows_argument(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return value.to_owned();
    }
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        if character == '"' {
            result.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
            result.push('"');
            slashes = 0;
            continue;
        }
        result.extend(std::iter::repeat_n('\\', slashes));
        slashes = 0;
        result.push(character);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

pub fn build_command_line(
    executable: &str,
    argv_prefix: &[String],
    command: &str,
) -> Result<Vec<u16>> {
    let arguments = std::iter::once(executable)
        .chain(argv_prefix.iter().map(String::as_str))
        .chain(["-c", command])
        .map(quote_windows_argument)
        .collect::<Vec<_>>()
        .join(" ");
    let mut wide: Vec<u16> = arguments.encode_utf16().collect();
    if wide.len() >= 32_767 {
        return Err(HelperError::protocol("TARGET_COMMAND_LINE_TOO_LONG"));
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bootstrap_json(command: &str, argv_prefix: &[String], environment: &str) -> String {
        let argv = argv_prefix
            .iter()
            .map(|value| crate::protocol::json_escape(value))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"version":1,"processIdHash":"{}","runIdHash":"{}","jobName":"Local\\PiDesktop.Managed.{}","nonce":"{}","cwd":"C:\\work","shellExecutable":"C:\\bash.exe","argvPrefix":[{}],"command":{},"environment":{},"mainPid":10,"mainStartTimeMs":1000,"mainImagePath":"C:\\electron.exe","hostPid":11,"hostStartTimeMs":1001,"hostImagePath":"C:\\electron.exe","hostInstanceId":"12345678-1234-4234-8234-123456789abc"}}"#,
            "a".repeat(64),
            "b".repeat(64),
            "c".repeat(64),
            "c".repeat(64),
            argv,
            crate::protocol::json_escape(command),
            environment,
        )
    }

    #[test]
    fn windows_argument_quoting_matches_documented_rules() {
        assert_eq!(quote_windows_argument(""), "\"\"");
        assert_eq!(quote_windows_argument("plain"), "plain");
        assert_eq!(quote_windows_argument("two words"), "\"two words\"");
        assert_eq!(quote_windows_argument("tail \\"), r#""tail \\""#);
        assert_eq!(quote_windows_argument("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn environment_is_sorted_deduplicated_and_double_nul_terminated() {
        let mut environment = BTreeMap::new();
        environment.insert("z".into(), "1".into());
        environment.insert("Path".into(), "C:\\bin".into());
        let block = build_environment_block(&environment).unwrap();
        assert_eq!(&block[block.len() - 2..], &[0, 0]);
        let text = String::from_utf16_lossy(&block);
        assert!(text.starts_with("Path=C:\\bin\0z=1\0"));
    }

    #[test]
    fn bootstrap_accepts_worst_case_command_escaping_and_rejects_budgets() {
        let command = "\"".repeat(MAX_COMMAND_BYTES);
        let parsed = Bootstrap::parse(bootstrap_json(&command, &[], "{}").as_bytes()).unwrap();
        assert_eq!(parsed.command.len(), MAX_COMMAND_BYTES);

        let oversized = "a".repeat(MAX_COMMAND_BYTES + 1);
        assert_eq!(
            Bootstrap::parse(bootstrap_json(&oversized, &[], "{}").as_bytes())
                .unwrap_err()
                .subcode,
            "HELPER_INVALID_FRAME"
        );

        let metadata_heavy = vec!["\"".repeat(4096); 8];
        assert_eq!(
            Bootstrap::parse(bootstrap_json("ok", &metadata_heavy, "{}").as_bytes())
                .unwrap_err()
                .subcode,
            "HELPER_BOOTSTRAP_TOO_LARGE"
        );
    }

    #[test]
    fn bootstrap_environment_is_case_insensitive_and_removes_electron_node_mode() {
        let parsed = Bootstrap::parse(
            bootstrap_json(
                "ok",
                &[],
                r#"{"Path":"C:\\bin","ELECTRON_RUN_AS_NODE":"1","z":"last"}"#,
            )
            .as_bytes(),
        )
        .unwrap();
        assert!(
            !parsed
                .environment
                .keys()
                .any(|key| key.eq_ignore_ascii_case("ELECTRON_RUN_AS_NODE"))
        );
        assert_eq!(
            Bootstrap::parse(bootstrap_json("ok", &[], r#"{"Path":"a","PATH":"b"}"#).as_bytes())
                .unwrap_err()
                .subcode,
            "HELPER_INVALID_FRAME"
        );
    }

    #[test]
    fn bootstrap_environment_accepts_4096_unicode_entries_and_rejects_4097() {
        let entries = (0..MAX_ENVIRONMENT_ENTRIES)
            .map(|index| format!(r#""PI_BOUNDARY_{index:04}":"值😀""#))
            .collect::<Vec<_>>();
        let exact = format!("{{{}}}", entries.join(","));
        let parsed = Bootstrap::parse(bootstrap_json("ok", &[], &exact).as_bytes()).unwrap();
        assert_eq!(parsed.environment.len(), MAX_ENVIRONMENT_ENTRIES);
        let block = build_environment_block(&parsed.environment).unwrap();
        assert_eq!(&block[block.len() - 2..], &[0, 0]);
        assert!(String::from_utf16_lossy(&block).contains("PI_BOUNDARY_0000=值😀\0"));

        let oversized = format!("{{{},\"PI_BOUNDARY_OVERFLOW\":\"x\"}}", entries.join(","));
        assert_eq!(
            Bootstrap::parse(bootstrap_json("ok", &[], &oversized).as_bytes())
                .unwrap_err()
                .subcode,
            "TARGET_ENVIRONMENT_TOO_LARGE"
        );
    }

    #[test]
    fn bootstrap_paths_allow_drive_and_unc_but_reject_device_namespaces() {
        assert!(valid_bootstrap_path(r"C:\work"));
        assert!(valid_bootstrap_path(r"\\server\share\work"));
        assert!(!valid_bootstrap_path(r"C:relative"));
        assert!(!valid_bootstrap_path(r"\\?\C:\work"));
        assert!(!valid_bootstrap_path(r"\\.\C:\work"));
        assert!(!valid_bootstrap_path(r"\??\C:\work"));
    }

    #[test]
    fn command_line_enforces_windows_utf16_limit() {
        assert!(build_command_line("C:\\bash.exe", &[], "echo 你好").is_ok());
        assert_eq!(
            build_command_line("C:\\bash.exe", &[], &"x".repeat(32_767))
                .unwrap_err()
                .subcode,
            "TARGET_COMMAND_LINE_TOO_LONG"
        );
    }
}
