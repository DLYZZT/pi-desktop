use crate::error::{HelperError, Result};
use crate::state::{Bootstrap, build_command_line, build_environment_block};
use std::ffi::c_void;
use std::fs::File;
use std::mem::{size_of, size_of_val, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, GENERIC_READ,
    GetLastError, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, LocalFree,
    SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetFileSecurityW, GetTokenInformation,
    PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, SetFileSecurityW, TOKEN_QUERY,
    TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileAttributesW,
    GetFileInformationByHandle, GetFinalPathNameByHandleW, INVALID_FILE_ATTRIBUTES, OPEN_EXISTING,
    READ_CONTROL, SYNCHRONIZE,
};
use windows_sys::Win32::System::Console::{
    AllocConsole, CTRL_BREAK_EVENT, CTRL_C_EVENT, FreeConsole, GenerateConsoleCtrlEvent,
    GetConsoleWindow, SetConsoleCtrlHandler,
};
use windows_sys::Win32::System::IO::CreateIoCompletionPort;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, OpenJobObjectW,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE};
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    GetProcessTimes, InitializeProcThreadAttributeList, OpenProcess, OpenProcessToken,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, QueryFullProcessImageNameW, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForMultipleObjects,
    WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};

pub struct OwnedHandle(HANDLE);

// SAFETY: HANDLE values are kernel object references. The wrapper has single
// ownership, closes once in Drop, and Win32 wait/query APIs permit calls from
// multiple threads while a live reference is retained.
unsafe impl Send for OwnedHandle {}
// SAFETY: See the Send invariant above. No Rust aliasing is derived from a HANDLE.
unsafe impl Sync for OwnedHandle {}

impl OwnedHandle {
    fn new(value: HANDLE, subcode: &'static str) -> Result<Self> {
        if value.is_null() || value == INVALID_HANDLE_VALUE {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32(subcode, unsafe { GetLastError() }));
        }
        Ok(Self(value))
    }

    pub const fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_raw(mut self) -> HANDLE {
        let value = self.0;
        self.0 = null_mut();
        value
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: self.0 is owned by this wrapper and is closed exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn wide_nul(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

pub fn lock_current_executable() -> Result<OwnedHandle> {
    let executable =
        std::env::current_exe().map_err(|_| HelperError::protocol("HELPER_INTEGRITY_FAILED"))?;
    let wide: Vec<u16> = executable.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: wide is a live NUL-terminated UTF-16 path to this process image.
    // Sharing only reads pins the helper against write/delete replacement until
    // the owner/reaper process exits and this owned handle is dropped.
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    OwnedHandle::new(raw, "HELPER_INTEGRITY_FAILED")
}

fn normalize_image_path(value: &str) -> String {
    normalize_final_path(value)
}

fn normalize_final_path(value: &str) -> String {
    let normalized = value.replace('/', "\\");
    let without_namespace = if let Some(rest) = normalized.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        normalized
            .strip_prefix(r"\\?\")
            .unwrap_or(&normalized)
            .to_owned()
    };
    without_namespace.to_lowercase()
}

fn final_path_for_handle(handle: HANDLE) -> Result<String> {
    let mut buffer = vec![0_u16; 32_768];
    // SAFETY: handle is live and opened for FILE_READ_ATTRIBUTES; buffer is
    // writable for its declared length and remains live for the call.
    let length =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if length == 0 || length as usize >= buffer.len() {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("TARGET_CREATE_FAILED", unsafe {
            GetLastError()
        }));
    }
    String::from_utf16(&buffer[..length as usize])
        .map_err(|_| HelperError::protocol("TARGET_CREATE_FAILED"))
}

fn verify_spawn_path(path: &str, expect_directory: bool) -> Result<OwnedHandle> {
    let wide = wide_nul(path);
    let flags = if expect_directory {
        FILE_FLAG_BACKUP_SEMANTICS
    } else {
        FILE_ATTRIBUTE_NORMAL
    };
    // SAFETY: wide is a live NUL-terminated UTF-16 path. The returned handle
    // is exclusively owned by OwnedHandle. Omitting FILE_SHARE_DELETE keeps
    // the verified object pinned against rename/delete until CreateProcessW.
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    let handle = OwnedHandle::new(raw, "TARGET_CREATE_FAILED")?;
    // SAFETY: information points to initialized writable stack storage and
    // handle remains live for the duration of the call.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    // SAFETY: handle is a valid file/directory handle and information is a
    // correctly sized output buffer.
    if unsafe { GetFileInformationByHandle(handle.raw(), &raw mut information) } == 0 {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("TARGET_CREATE_FAILED", unsafe {
            GetLastError()
        }));
    }
    let is_directory = information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if is_directory != expect_directory
        || normalize_final_path(&final_path_for_handle(handle.raw())?) != normalize_final_path(path)
    {
        return Err(HelperError::protocol("TARGET_CREATE_FAILED"));
    }
    Ok(handle)
}

fn filetime_ticks(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

fn creation_time_millis(handle: HANDLE) -> Result<u64> {
    // SAFETY: All FILETIME outputs point to initialized stack storage for the
    // duration of the call; handle has PROCESS_QUERY_LIMITED_INFORMATION.
    unsafe {
        let mut creation = zeroed();
        let mut exit = zeroed();
        let mut kernel = zeroed();
        let mut user = zeroed();
        if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
            return Err(HelperError::win32(
                "HELPER_PARENT_UNAVAILABLE",
                GetLastError(),
            ));
        }
        let ticks = filetime_ticks(creation);
        const WINDOWS_TO_UNIX_TICKS: u64 = 116_444_736_000_000_000;
        if ticks < WINDOWS_TO_UNIX_TICKS {
            return Err(HelperError::protocol("HELPER_PARENT_UNAVAILABLE"));
        }
        Ok((ticks - WINDOWS_TO_UNIX_TICKS) / 10_000)
    }
}

fn process_image_path(handle: HANDLE) -> Result<String> {
    let mut capacity = 32_768_u32;
    let mut buffer = vec![0_u16; capacity as usize];
    // SAFETY: buffer is writable for capacity UTF-16 units and size points to
    // live stack storage. The process handle remains valid for the call.
    unsafe {
        if QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut capacity) == 0 {
            return Err(HelperError::win32(
                "HELPER_PARENT_UNAVAILABLE",
                GetLastError(),
            ));
        }
    }
    String::from_utf16(&buffer[..capacity as usize])
        .map_err(|_| HelperError::protocol("HELPER_PARENT_UNAVAILABLE"))
}

fn fnv1a64(value: &[u8]) -> u64 {
    value.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

pub fn process_fingerprint(handle: HANDLE, build_id: &str) -> Result<String> {
    let started = creation_time_millis(handle)?;
    let image = normalize_image_path(&process_image_path(handle)?);
    Ok(format!(
        "win32:{started}:{:016x}:{build_id}",
        fnv1a64(image.as_bytes())
    ))
}

pub fn open_reap_owner(
    pid: u32,
    expected_fingerprint: &str,
    build_id: &str,
) -> Result<Option<OwnedHandle>> {
    // SAFETY: OpenProcess receives a bounded journal PID and requests only the
    // rights needed to fingerprint, wait for, and close the verified old helper.
    let raw = unsafe {
        OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        )
    };
    if raw.is_null() {
        return Ok(None);
    }
    let handle = OwnedHandle::new(raw, "HELPER_REAP_IDENTITY_UNCERTAIN")?;
    let fingerprint = match process_fingerprint(handle.raw(), build_id) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if fingerprint != expected_fingerprint {
        return Ok(None);
    }
    Ok(Some(handle))
}

pub fn terminate_reap_owner(owner: &OwnedHandle) -> Result<()> {
    // SAFETY: owner is the live, fingerprint-verified old helper handle and was
    // opened with PROCESS_TERMINATE and SYNCHRONIZE rights.
    if unsafe { WaitForSingleObject(owner.raw(), 0) } == WAIT_OBJECT_0 {
        return Ok(());
    }
    // SAFETY: see the verified ownership invariant above.
    if unsafe { windows_sys::Win32::System::Threading::TerminateProcess(owner.raw(), 0x5049_4d50) }
        == 0
    {
        return Err(HelperError::win32("HELPER_REAP_FAILED", unsafe {
            GetLastError()
        }));
    }
    // SAFETY: owner remains live and waitable for this bounded confirmation.
    if unsafe { WaitForSingleObject(owner.raw(), 500) } != WAIT_OBJECT_0 {
        return Err(HelperError::protocol("HELPER_REAP_FAILED"));
    }
    Ok(())
}

pub struct OwnerHandles {
    pub main: OwnedHandle,
    pub host: OwnedHandle,
}

fn open_and_validate_owner(
    pid: u32,
    start_time_ms: u64,
    expected_image_path: &str,
) -> Result<OwnedHandle> {
    // SAFETY: OpenProcess receives a concrete PID and requests query/wait-only
    // rights. The returned owning handle is immediately wrapped.
    let handle = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    let handle = OwnedHandle::new(handle, "HELPER_PARENT_UNAVAILABLE")?;
    if creation_time_millis(handle.raw())? != start_time_ms {
        return Err(HelperError::protocol("HELPER_PARENT_TIME_MISMATCH"));
    }
    if normalize_image_path(&process_image_path(handle.raw())?)
        != normalize_image_path(expected_image_path)
    {
        return Err(HelperError::protocol("HELPER_PARENT_IMAGE_MISMATCH"));
    }
    Ok(handle)
}

pub fn open_owner_handles(bootstrap: &Bootstrap) -> Result<OwnerHandles> {
    Ok(OwnerHandles {
        main: open_and_validate_owner(
            bootstrap.main_pid,
            bootstrap.main_start_time_ms,
            &bootstrap.main_image_path,
        )?,
        host: open_and_validate_owner(
            bootstrap.host_pid,
            bootstrap.host_start_time_ms,
            &bootstrap.host_image_path,
        )?,
    })
}

pub fn wait_for_owner_loss(owners: OwnerHandles) -> Result<()> {
    let handles = [owners.main.raw(), owners.host.raw()];
    // SAFETY: handles references two live, waitable process handles kept alive
    // by owners until WaitForMultipleObjects returns.
    let result =
        unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, u32::MAX) };
    if result == WAIT_OBJECT_0 || result == WAIT_OBJECT_0 + 1 {
        Ok(())
    } else {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        Err(HelperError::win32("HELPER_PARENT_UNAVAILABLE", unsafe {
            GetLastError()
        }))
    }
}

pub struct Job {
    handle: OwnedHandle,
    _completion_port: OwnedHandle,
}

impl Job {
    pub fn create(name: &str) -> Result<Self> {
        let name = wide_nul(name);
        let security_descriptor = current_user_job_security_descriptor()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: security_descriptor.raw(),
            bInheritHandle: 0,
        };
        // SAFETY: name is NUL-terminated; attributes points to a live absolute
        // security descriptor granting access only to the current user and
        // SYSTEM, and neither buffer outlives this call.
        let raw = unsafe { CreateJobObjectW(&raw const attributes, name.as_ptr()) };
        let handle = OwnedHandle::new(raw, "JOB_CREATE_FAILED")?;
        // SAFETY: GetLastError is read immediately after CreateJobObjectW.
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Err(HelperError::protocol("JOB_CREATE_FAILED"));
        }
        verify_job_dacl(handle.raw(), "JOB_CREATE_FAILED")?;
        // SAFETY: zeroed is valid for the Win32 POD information structure.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the information pointer and byte count exactly describe
        // limits; handle is a live Job handle.
        if unsafe {
            SetInformationJobObject(
                handle.raw(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("JOB_LIMIT_FAILED", unsafe {
                GetLastError()
            }));
        }
        // SAFETY: INVALID_HANDLE_VALUE requests a new completion port; null
        // existing port and zero key are valid for creation.
        let completion = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) };
        let completion = OwnedHandle::new(completion, "JOB_COMPLETION_PORT_FAILED")?;
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: handle.raw(),
            CompletionPort: completion.raw(),
        };
        // SAFETY: association is live for the call and contains two valid
        // handles. The byte size matches the declared information class.
        if unsafe {
            SetInformationJobObject(
                handle.raw(),
                JobObjectAssociateCompletionPortInformation,
                (&raw const association).cast::<c_void>(),
                size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
            )
        } == 0
        {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("JOB_COMPLETION_PORT_FAILED", unsafe {
                GetLastError()
            }));
        }
        Ok(Self {
            handle,
            _completion_port: completion,
        })
    }

    pub fn open_for_reap(name: &str) -> Result<Option<Self>> {
        let name = wide_nul(name);
        // SAFETY: name is a live, NUL-terminated UTF-16 string.
        let raw = unsafe {
            OpenJobObjectW(
                JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY | READ_CONTROL | SYNCHRONIZE,
                0,
                name.as_ptr(),
            )
        };
        if raw.is_null() {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            let code = unsafe { GetLastError() };
            if code == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            return Err(HelperError::win32("JOB_QUERY_FAILED", code));
        }
        let handle = OwnedHandle::new(raw, "JOB_QUERY_FAILED")?;
        verify_job_dacl(handle.raw(), "JOB_QUERY_FAILED")?;
        // Reaper mode only needs the Job handle. A private completion port keeps
        // the representation uniform without changing the existing Job binding.
        // SAFETY: same completion-port creation contract as Job::create.
        let completion = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) };
        Ok(Some(Self {
            handle,
            _completion_port: OwnedHandle::new(completion, "JOB_QUERY_FAILED")?,
        }))
    }

    pub fn raw(&self) -> HANDLE {
        self.handle.raw()
    }

    pub fn active_processes(&self) -> Result<u32> {
        // SAFETY: zeroed is valid for this Win32 POD output structure.
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        // SAFETY: output pointer and byte count exactly match accounting; Job
        // handle has query rights.
        if unsafe {
            QueryInformationJobObject(
                self.handle.raw(),
                JobObjectBasicAccountingInformation,
                (&raw mut accounting).cast::<c_void>(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("JOB_QUERY_FAILED", unsafe {
                GetLastError()
            }));
        }
        Ok(accounting.ActiveProcesses)
    }

    pub fn terminate(&self) -> Result<()> {
        // SAFETY: handle is a live Job with terminate rights.
        if unsafe { TerminateJobObject(self.handle.raw(), 0x5049_4d50) } == 0 {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("JOB_TERMINATE_FAILED", unsafe {
                GetLastError()
            }));
        }
        Ok(())
    }

    pub fn wait_empty(&self, timeout: Duration) -> Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.active_processes()? == 0 {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

struct LocalMemory(*mut c_void);

impl LocalMemory {
    const fn raw(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for LocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer was allocated by a Win32 conversion API that
            // documents LocalFree as its matching deallocator, exactly once.
            unsafe { LocalFree(self.0) };
        }
    }
}

fn current_user_sid_string() -> Result<String> {
    // SAFETY: GetCurrentProcess returns a borrowed pseudo-handle that is never closed.
    let process = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() };
    let mut token = null_mut();
    // SAFETY: token points to writable stack storage; the returned owned handle
    // is wrapped immediately and receives query-only rights.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) } == 0 {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("JOB_CREATE_FAILED", unsafe {
            GetLastError()
        }));
    }
    let token = OwnedHandle::new(token, "JOB_CREATE_FAILED")?;
    let mut bytes = 0_u32;
    // SAFETY: the first null-buffer call obtains the required TOKEN_USER size.
    unsafe { GetTokenInformation(token.raw(), TokenUser, null_mut(), 0, &raw mut bytes) };
    if bytes < size_of::<TOKEN_USER>() as u32 {
        return Err(HelperError::protocol("JOB_CREATE_FAILED"));
    }
    let mut buffer = vec![0_u8; bytes as usize];
    // SAFETY: buffer is writable for bytes and the output length pointer is live.
    if unsafe {
        GetTokenInformation(
            token.raw(),
            TokenUser,
            buffer.as_mut_ptr().cast::<c_void>(),
            bytes,
            &raw mut bytes,
        )
    } == 0
    {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("JOB_CREATE_FAILED", unsafe {
            GetLastError()
        }));
    }
    // SAFETY: GetTokenInformation populated buffer with a TOKEN_USER whose SID
    // pointer remains valid as long as buffer is retained in this scope.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut sid_text = null_mut();
    // SAFETY: user.User.Sid is valid for buffer's lifetime and sid_text points
    // to writable storage for a LocalAlloc-backed UTF-16 result.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &raw mut sid_text) } == 0 {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("JOB_CREATE_FAILED", unsafe {
            GetLastError()
        }));
    }
    let sid_memory = LocalMemory(sid_text.cast::<c_void>());
    let mut length = 0_usize;
    // SAFETY: sid_text is a valid NUL-terminated string returned by Win32.
    unsafe {
        while *sid_text.add(length) != 0 {
            length += 1;
            if length > 256 {
                return Err(HelperError::protocol("JOB_CREATE_FAILED"));
            }
        }
    }
    // SAFETY: the bounded scan above found the terminating NUL and the slice
    // remains within the LocalAlloc-backed sid string.
    let sid = unsafe { std::slice::from_raw_parts(sid_text, length) };
    let value = String::from_utf16(sid).map_err(|_| HelperError::protocol("JOB_CREATE_FAILED"))?;
    drop(sid_memory);
    Ok(value)
}

fn current_user_job_security_descriptor() -> Result<LocalMemory> {
    let sid = current_user_sid_string()?;
    // 0x1f003f is the kernel-expanded Job all-access mask. Using the specific
    // rights makes read-back comparison stable instead of comparing GA with
    // the object manager's expanded representation.
    let sddl = wide_nul(&format!("D:P(A;;0x1f003f;;;SY)(A;;0x1f003f;;;{sid})"));
    let mut descriptor = null_mut();
    // SAFETY: sddl is a valid NUL-terminated SDDL string and descriptor points
    // to writable storage for a LocalAlloc-backed SECURITY_DESCRIPTOR.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &raw mut descriptor,
            null_mut(),
        )
    } == 0
    {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("JOB_CREATE_FAILED", unsafe {
            GetLastError()
        }));
    }
    Ok(LocalMemory(descriptor.cast::<c_void>()))
}

fn current_user_directory_security_descriptor() -> Result<LocalMemory> {
    let sid = current_user_sid_string()?;
    let sddl = wide_nul(&format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{sid})"));
    let mut descriptor = null_mut();
    // SAFETY: sddl is a bounded, NUL-terminated string assembled from the
    // current token SID; descriptor receives one LocalAlloc-owned result.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &raw mut descriptor,
            null_mut(),
        )
    } == 0
    {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("JOURNAL_SECURITY_FAILED", unsafe {
            GetLastError()
        }));
    }
    Ok(LocalMemory(descriptor.cast::<c_void>()))
}

fn descriptor_dacl_sddl(descriptor: *mut c_void, subcode: &'static str) -> Result<String> {
    let mut text = null_mut();
    let mut text_len = 0_u32;
    // SAFETY: descriptor points to a live security descriptor and text receives
    // one LocalAlloc-owned UTF-16 string, which is released below.
    if unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &raw mut text,
            &raw mut text_len,
        )
    } == 0
    {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32(subcode, unsafe { GetLastError() }));
    }
    let memory = LocalMemory(text.cast::<c_void>());
    let length =
        usize::try_from(text_len).map_err(|_| HelperError::protocol("JOURNAL_SECURITY_FAILED"))?;
    if length == 0 || length > 4096 {
        return Err(HelperError::protocol(subcode));
    }
    // SAFETY: Win32 reported text_len UTF-16 code units for the LocalAlloc
    // result. Strip its optional terminating NUL before decoding.
    let slice = unsafe { std::slice::from_raw_parts(text, length) };
    let non_nul_length = slice
        .iter()
        .rposition(|unit| *unit != 0)
        .map_or(0, |index| index + 1);
    let slice = &slice[..non_nul_length];
    let value = String::from_utf16(slice).map_err(|_| HelperError::protocol(subcode))?;
    drop(memory);
    Ok(value)
}

fn verify_job_dacl(handle: HANDLE, subcode: &'static str) -> Result<()> {
    let expected = current_user_job_security_descriptor()?;
    let mut actual = null_mut();
    // SAFETY: handle is a live Job handle. Only its DACL is requested; actual
    // receives one LocalAlloc-owned self-relative descriptor released below.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &raw mut actual,
        )
    };
    if status != 0 || actual.is_null() {
        return Err(HelperError::win32(subcode, status));
    }
    let actual = LocalMemory(actual);
    if descriptor_dacl_sddl(expected.raw(), subcode)?
        != descriptor_dacl_sddl(actual.raw(), subcode)?
    {
        return Err(HelperError::protocol(subcode));
    }
    Ok(())
}

pub fn secure_journal_directory(path: &str) -> Result<()> {
    let path = wide_nul(path);
    let descriptor = current_user_directory_security_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.raw(),
        bInheritHandle: 0,
    };
    // SAFETY: path is NUL-terminated and attributes references the live exact
    // current-user/SYSTEM protected descriptor. Existing directories are
    // handled below and never followed when marked as a reparse point.
    if unsafe { CreateDirectoryW(path.as_ptr(), &raw const attributes) } == 0 {
        // SAFETY: GetLastError is read immediately after CreateDirectoryW.
        let code = unsafe { GetLastError() };
        if code != ERROR_ALREADY_EXISTS {
            return Err(HelperError::win32("JOURNAL_SECURITY_FAILED", code));
        }
    }
    // SAFETY: path remains a live NUL-terminated buffer for this metadata-only
    // query; no handle to a reparse target is opened.
    let file_attributes = unsafe { GetFileAttributesW(path.as_ptr()) };
    if file_attributes == INVALID_FILE_ATTRIBUTES
        || file_attributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(HelperError::protocol("JOURNAL_SECURITY_FAILED"));
    }
    // SAFETY: path names the verified non-reparse directory and descriptor is
    // live. DACL_SECURITY_INFORMATION replaces the DACL; PROTECTED disables
    // inherited ACEs, leaving exactly the two inheritable allow ACEs.
    if unsafe {
        SetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.raw(),
        )
    } == 0
    {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("JOURNAL_SECURITY_FAILED", unsafe {
            GetLastError()
        }));
    }

    let mut required = 0_u32;
    // SAFETY: null buffer with zero length requests the exact descriptor size.
    unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION,
            null_mut(),
            0,
            &raw mut required,
        )
    };
    if required == 0 || required > 64 * 1024 {
        return Err(HelperError::protocol("JOURNAL_SECURITY_FAILED"));
    }
    let words = usize::try_from(required)
        .map_err(|_| HelperError::protocol("JOURNAL_SECURITY_FAILED"))?
        .div_ceil(size_of::<usize>());
    let mut actual = vec![0_usize; words];
    // SAFETY: actual is suitably aligned and writable for at least required
    // bytes; required_out is live and path remains valid.
    if unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION,
            actual.as_mut_ptr().cast::<c_void>(),
            required,
            &raw mut required,
        )
    } == 0
    {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("JOURNAL_SECURITY_FAILED", unsafe {
            GetLastError()
        }));
    }
    if descriptor_dacl_sddl(descriptor.raw(), "JOURNAL_SECURITY_FAILED")?
        != descriptor_dacl_sddl(
            actual.as_mut_ptr().cast::<c_void>(),
            "JOURNAL_SECURITY_FAILED",
        )?
    {
        return Err(HelperError::protocol("JOURNAL_SECURITY_FAILED"));
    }
    Ok(())
}

pub struct ChildPipes {
    pub stdin: File,
    pub stdout: File,
    pub stderr: File,
}

struct PipePair {
    parent: OwnedHandle,
    child: OwnedHandle,
}

fn pipe(parent_reads: bool) -> Result<PipePair> {
    let mut read_handle = null_mut();
    let mut write_handle = null_mut();
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    // SAFETY: output pointers and SECURITY_ATTRIBUTES are live for the call.
    if unsafe {
        CreatePipe(
            &mut read_handle,
            &mut write_handle,
            &raw const attributes,
            0,
        )
    } == 0
    {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("PIPE_SETUP_FAILED", unsafe {
            GetLastError()
        }));
    }
    let read = OwnedHandle::new(read_handle, "PIPE_SETUP_FAILED")?;
    let write = OwnedHandle::new(write_handle, "PIPE_SETUP_FAILED")?;
    let (parent, child) = if parent_reads {
        (read, write)
    } else {
        (write, read)
    };
    // SAFETY: parent is a live pipe handle; clearing inheritance cannot outlive it.
    if unsafe { SetHandleInformation(parent.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("PIPE_SETUP_FAILED", unsafe {
            GetLastError()
        }));
    }
    Ok(PipePair { parent, child })
}

struct AttributeList {
    storage: Vec<u8>,
}

impl AttributeList {
    fn handles(handles: &mut [HANDLE]) -> Result<Self> {
        let mut bytes = 0_usize;
        // SAFETY: a null first call asks Windows for the required byte count.
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes) };
        if bytes == 0 {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("PIPE_SETUP_FAILED", unsafe {
                GetLastError()
            }));
        }
        let mut storage = vec![0_u8; bytes];
        let list = storage.as_mut_ptr().cast();
        // SAFETY: storage owns bytes writable for the requested attribute list
        // size and remains fixed until Drop.
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut bytes) } == 0 {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("PIPE_SETUP_FAILED", unsafe {
                GetLastError()
            }));
        }
        // SAFETY: list is initialized, handles points at the exact allowlist,
        // and both buffers remain live through CreateProcessW.
        if unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_mut_ptr().cast::<c_void>(),
                size_of_val(handles),
                null_mut(),
                null_mut(),
            )
        } == 0
        {
            // SAFETY: list was initialized and may be destroyed on failure.
            unsafe { DeleteProcThreadAttributeList(list) };
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("PIPE_SETUP_FAILED", unsafe {
                GetLastError()
            }));
        }
        Ok(Self { storage })
    }

    fn raw(&mut self) -> windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.storage.is_empty() {
            // SAFETY: storage contains exactly one initialized attribute list.
            unsafe { DeleteProcThreadAttributeList(self.storage.as_mut_ptr().cast()) };
        }
    }
}

pub struct Target {
    process: OwnedHandle,
    primary_thread: Option<OwnedHandle>,
    pub process_id: u32,
    pipes: Option<ChildPipes>,
}

impl Target {
    pub fn prepare(bootstrap: &Bootstrap, job: &Job) -> Result<Self> {
        setup_hidden_console()?;
        let stdin_pipe = pipe(false)?;
        let stdout_pipe = pipe(true)?;
        let stderr_pipe = pipe(true)?;
        let mut inherited = [
            stdin_pipe.child.raw(),
            stdout_pipe.child.raw(),
            stderr_pipe.child.raw(),
        ];
        let mut attributes = AttributeList::handles(&mut inherited)?;
        // SAFETY: zeroed is valid for this Win32 POD input structure. Required
        // fields are initialized immediately below.
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin_pipe.child.raw();
        startup.StartupInfo.hStdOutput = stdout_pipe.child.raw();
        startup.StartupInfo.hStdError = stderr_pipe.child.raw();
        startup.lpAttributeList = attributes.raw();
        // SAFETY: zeroed is valid for this Win32 POD output structure.
        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
        let application = wide_nul(&bootstrap.shell_executable);
        let cwd = wide_nul(&bootstrap.cwd);
        let mut command_line = build_command_line(
            &bootstrap.shell_executable,
            &bootstrap.argv_prefix,
            &bootstrap.command,
        )?;
        let environment = build_environment_block(&bootstrap.environment)?;
        // Re-open both validated paths immediately before process creation and
        // hold the handles across CreateProcessW. Host realpath validation is
        // necessary but insufficient against a reparse swap between processes.
        let _cwd_guard = verify_spawn_path(&bootstrap.cwd, true)?;
        let _shell_guard = verify_spawn_path(&bootstrap.shell_executable, false)?;
        let flags: PROCESS_CREATION_FLAGS = CREATE_SUSPENDED
            | CREATE_UNICODE_ENVIRONMENT
            | CREATE_NEW_PROCESS_GROUP
            | EXTENDED_STARTUPINFO_PRESENT;
        // SAFETY: application/cwd/environment are live NUL-terminated UTF-16
        // buffers; command_line is writable as required by CreateProcessW;
        // STARTUPINFOEX and attribute allowlist remain live for the call.
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                flags,
                environment.as_ptr().cast::<c_void>(),
                cwd.as_ptr(),
                &raw const startup.StartupInfo,
                &raw mut process_info,
            )
        } == 0
        {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("TARGET_CREATE_FAILED", unsafe {
                GetLastError()
            }));
        }
        let process = OwnedHandle::new(process_info.hProcess, "TARGET_CREATE_FAILED")?;
        let primary_thread = OwnedHandle::new(process_info.hThread, "TARGET_CREATE_FAILED")?;
        // SAFETY: process is suspended and both handles remain live; assignment
        // occurs before its primary thread can execute or create descendants.
        if unsafe { AssignProcessToJobObject(job.raw(), process.raw()) } == 0 {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            let code = unsafe { GetLastError() };
            // The suspended target is outside the Job on assignment failure, so
            // it must be terminated explicitly before owned handles are dropped.
            // SAFETY: process is a live process handle with terminate access
            // returned by CreateProcessW.
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(process.raw(), 0x5049_4d50)
            };
            return Err(HelperError::win32("TARGET_ASSIGN_FAILED", code));
        }
        drop(stdin_pipe.child);
        drop(stdout_pipe.child);
        drop(stderr_pipe.child);
        // SAFETY: these parent pipe handles were removed from the inheritance
        // set and ownership is transferred exactly once to File.
        let stdin = unsafe { File::from_raw_handle(stdin_pipe.parent.into_raw() as RawHandle) };
        // SAFETY: same single-owner transfer invariant as stdin.
        let stdout = unsafe { File::from_raw_handle(stdout_pipe.parent.into_raw() as RawHandle) };
        // SAFETY: same single-owner transfer invariant as stdin.
        let stderr = unsafe { File::from_raw_handle(stderr_pipe.parent.into_raw() as RawHandle) };
        Ok(Self {
            process,
            primary_thread: Some(primary_thread),
            process_id: process_info.dwProcessId,
            pipes: Some(ChildPipes {
                stdin,
                stdout,
                stderr,
            }),
        })
    }

    pub fn take_pipes(&mut self) -> Result<ChildPipes> {
        self.pipes
            .take()
            .ok_or_else(|| HelperError::protocol("PIPE_SETUP_FAILED"))
    }

    pub fn resume(&mut self) -> Result<()> {
        let thread = self
            .primary_thread
            .take()
            .ok_or_else(|| HelperError::protocol("TARGET_RESUME_FAILED"))?;
        // SAFETY: thread is the suspended primary thread returned by
        // CreateProcessW and is resumed exactly once.
        if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("TARGET_RESUME_FAILED", unsafe {
                GetLastError()
            }));
        }
        Ok(())
    }

    pub fn has_exited(&self) -> Result<bool> {
        // SAFETY: process is a live waitable process handle.
        match unsafe { WaitForSingleObject(self.process.raw(), 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => {
                // SAFETY: GetLastError has no pointer or lifetime preconditions.
                Err(HelperError::win32("JOB_QUERY_FAILED", unsafe {
                    GetLastError()
                }))
            }
        }
    }

    pub fn exit_code(&self) -> Result<Option<u32>> {
        if !self.has_exited()? {
            return Ok(None);
        }
        let mut code = 0_u32;
        // SAFETY: code is live output storage and process is a live process handle.
        if unsafe { GetExitCodeProcess(self.process.raw(), &mut code) } == 0 {
            // SAFETY: GetLastError has no pointer or lifetime preconditions.
            return Err(HelperError::win32("JOB_QUERY_FAILED", unsafe {
                GetLastError()
            }));
        }
        Ok(Some(code))
    }
}

pub fn setup_hidden_console() -> Result<()> {
    // SAFETY: FreeConsole/AllocConsole do not use caller-provided pointers.
    unsafe {
        FreeConsole();
        if AllocConsole() == 0 {
            let code = GetLastError();
            if code != ERROR_ACCESS_DENIED {
                return Err(HelperError::win32("CONSOLE_SETUP_FAILED", code));
            }
        }
        let window = GetConsoleWindow();
        if !window.is_null() {
            ShowWindow(window, SW_HIDE);
        }
        // NULL handler with add=TRUE makes the helper ignore Ctrl+C while the
        // target, in the same private console, remains eligible to receive it.
        if SetConsoleCtrlHandler(None, 1) == 0 {
            return Err(HelperError::win32("CONSOLE_SETUP_FAILED", GetLastError()));
        }
    }
    Ok(())
}

pub fn send_ctrl_c() -> Result<()> {
    // SAFETY: group 0 broadcasts only to processes attached to the helper's
    // private console; the helper installed an ignore handler.
    if unsafe { GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) } == 0 {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("CONSOLE_SETUP_FAILED", unsafe {
            GetLastError()
        }));
    }
    Ok(())
}

pub fn send_ctrl_break(process_group_id: u32) -> Result<()> {
    // SAFETY: process_group_id is the target created with
    // CREATE_NEW_PROCESS_GROUP in this private console.
    if unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, process_group_id) } == 0 {
        // SAFETY: GetLastError has no pointer or lifetime preconditions.
        return Err(HelperError::win32("CONSOLE_SETUP_FAILED", unsafe {
            GetLastError()
        }));
    }
    Ok(())
}

pub fn current_process_fingerprint(build_id: &str) -> Result<String> {
    // SAFETY: GetCurrentProcess returns a borrowed pseudo-handle valid for the
    // process lifetime; it is never wrapped or closed.
    let handle = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() };
    process_fingerprint(handle, build_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_job_dacl_is_exact_and_name_collision_fails_closed() {
        let name = format!(
            r"Local\PiDesktop.Managed.TestCollision.{:08x}",
            std::process::id()
        );
        let first = Job::create(&name).unwrap();
        verify_job_dacl(first.handle.raw(), "JOB_QUERY_FAILED").unwrap();
        let reopened = Job::open_for_reap(&name).unwrap().unwrap();
        verify_job_dacl(reopened.handle.raw(), "JOB_QUERY_FAILED").unwrap();
        drop(reopened);
        let error = match Job::create(&name) {
            Ok(_) => panic!("duplicate named Job unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.subcode, "JOB_CREATE_FAILED");
    }
}
