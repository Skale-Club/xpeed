//! Windows closes this private job handle if the Companion exits unexpectedly.
//! The speech script waits for a pipe handshake before using the microphone or
//! speaker, so it can start audio only after joining the job.

use std::io;
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::ptr::null;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(super) struct SpeechProcessJob(HANDLE);

impl Drop for SpeechProcessJob {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub(super) fn assign(child: &Child) -> io::Result<SpeechProcessJob> {
    unsafe {
        // Null attributes mean the child cannot inherit the job handle.
        let handle = CreateJobObjectW(null(), null());
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = SpeechProcessJob(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job.0, child.as_raw_handle().cast()) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
}
