//! Optional desktop speech. The Windows PowerShell child uses only the installed
//! Microsoft desktop recognition/synthesis engines, with text over private pipes.

use std::io::{Read, Write};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DICTATION_LIMIT: Duration = Duration::from_secs(15);
const SPEAKING_LIMIT: Duration = Duration::from_secs(120);
const MAX_TRANSCRIPT_BYTES: u64 = 8_000;
const MAX_SPEAK_BYTES: usize = 128 * 1024;
const HANDSHAKE: &[u8] = b"XpeedSpeechReady\n";

#[link(name = "kernel32")]
extern "system" {
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

// Both scripts are fixed. Language is selected from the app's three language
// codes. The reply is never executable text or a process argument.
const DICTATE: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ([Console]::ReadLine() -cne 'XpeedSpeechReady') { exit 23 }
Add-Type -AssemblyName System.Speech
$locale = $env:XPEED_SPEECH_LOCALE
$installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object {
    $_.Culture.Name -eq $locale -and $_.Id -match '(?i)(^|\\)MS-[A-Z0-9-]+-DESK$'
})
if ($installed.Count -eq 0) { exit 21 }
$engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($installed[0])
try {
    $engine.SetInputToDefaultAudioDevice()
    $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
    $result = $engine.Recognize([TimeSpan]::FromSeconds(8))
    if ($null -eq $result -or [String]::IsNullOrWhiteSpace($result.Text)) { exit 22 }
    $text = $result.Text
    if ($text.Length -gt 2000) { $text = $text.Substring(0, 2000) }
    [Console]::Write($text)
} finally {
    $engine.Dispose()
}
"#;

const SPEAK: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
if ([Console]::ReadLine() -cne 'XpeedSpeechReady') { exit 23 }
Add-Type -AssemblyName System.Speech
$locale = $env:XPEED_SPEECH_LOCALE
$text = [Console]::In.ReadToEnd()
$voice = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $installed = @($voice.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $locale -and $_.VoiceInfo.Id -match '(?i)(^|\\)TTS_MS_'
    })
    if ($installed.Count -eq 0) { exit 21 }
    $voice.SelectVoice($installed[0].VoiceInfo.Name)
    $voice.SetOutputToDefaultAudioDevice()
    $voice.Speak($text)
} finally {
    $voice.Dispose()
}
"#;

pub(crate) enum SpeechRequest {
    Dictate { locale: &'static str },
    Speak { locale: &'static str, text: String },
}

pub(crate) enum SpeechResult {
    Dictated(String),
    Spoken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SpeechError {
    NoEngine,
    NoWords,
    TimedOut,
    Cancelled,
    Unavailable,
}

fn powershell() -> Option<PathBuf> {
    let mut buffer = [0u16; 1024];
    let len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if len == 0 || len >= buffer.len() {
        return None;
    }
    let system = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len]));
    system.is_absolute().then(|| system.join(r"WindowsPowerShell\v1.0\powershell.exe"))
}

fn stop(child: &mut Child) {
    // The job guard also closes on return. Never wait on a terminated speech
    // process here: a failing audio driver can delay Windows' exit signal.
    let _ = child.kill();
}

pub(crate) fn run<Job>(
    request: SpeechRequest,
    cancelled: Arc<AtomicBool>,
    bind_job: impl FnOnce(&Child) -> std::io::Result<Job>,
) -> Result<SpeechResult, SpeechError> {
    let (locale, script, deadline, input) = match request {
        SpeechRequest::Dictate { locale } => (locale, DICTATE, DICTATION_LIMIT, None),
        SpeechRequest::Speak { locale, text } if !text.trim().is_empty() && text.len() <= MAX_SPEAK_BYTES => {
            (locale, SPEAK, SPEAKING_LIMIT, Some(text))
        }
        SpeechRequest::Speak { .. } => return Err(SpeechError::Unavailable),
    };
    if !matches!(locale, "en-US" | "pt-BR" | "es-ES") {
        return Err(SpeechError::NoEngine);
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(SpeechError::Cancelled);
    }
    let end = Instant::now() + deadline;
    let mut child = Command::new(powershell().ok_or(SpeechError::Unavailable)?)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
        .env("XPEED_SPEECH_LOCALE", locale)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(if input.is_some() { Stdio::null() } else { Stdio::piped() })
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| SpeechError::Unavailable)?;
    let Ok(_job) = bind_job(&child) else {
        stop(&mut child);
        return Err(SpeechError::Unavailable);
    };
    if cancelled.load(Ordering::Acquire) {
        stop(&mut child);
        return Err(SpeechError::Cancelled);
    }

    // Drain/fill the pipe on another thread so a stuck child cannot prevent
    // cancellation or the wall-clock deadline from stopping it.
    let dictated = input.is_none();
    let reader = if dictated {
        let reader = child.stdout.take().and_then(|stdout| {
            thread::Builder::new()
                .name("coach-speech-read".into())
                .spawn(move || {
                    let mut bytes = Vec::new();
                    stdout.take(MAX_TRANSCRIPT_BYTES + 1).read_to_end(&mut bytes)?;
                    if bytes.len() as u64 > MAX_TRANSCRIPT_BYTES {
                        return Err(std::io::ErrorKind::InvalidData.into());
                    }
                    String::from_utf8(bytes)
                        .map(SpeechResult::Dictated)
                        .map_err(|_| std::io::ErrorKind::InvalidData.into())
                })
                .ok()
        });
        if reader.is_none() {
            stop(&mut child);
            return Err(SpeechError::Unavailable);
        }
        reader
    } else {
        None
    };
    let writer_cancelled = cancelled.clone();
    let writer = child.stdin.take().and_then(|mut stdin| {
        thread::Builder::new()
            .name("coach-speech-write".into())
            .spawn(move || {
                // This releases the fixed script only after the job is in place.
                if writer_cancelled.load(Ordering::Acquire) {
                    return Err(std::io::ErrorKind::Interrupted.into());
                }
                stdin.write_all(HANDSHAKE)?;
                if let Some(text) = input {
                    stdin.write_all(text.as_bytes())?;
                }
                Ok::<(), std::io::Error>(())
            })
            .ok()
    });
    let Some(writer) = writer else {
        stop(&mut child);
        return Err(SpeechError::Unavailable);
    };

    loop {
        if cancelled.load(Ordering::Acquire) {
            stop(&mut child);
            return Err(SpeechError::Cancelled);
        }
        if Instant::now() >= end {
            stop(&mut child);
            return Err(SpeechError::TimedOut);
        }
        match child.try_wait() {
            Ok(Some(status)) => match status.code() {
                Some(0) if writer.is_finished() && reader.as_ref().is_none_or(|reader| reader.is_finished()) => {
                    writer.join().ok().and_then(Result::ok).ok_or(SpeechError::Unavailable)?;
                    return match reader {
                        Some(reader) => reader.join().ok().and_then(Result::ok).ok_or(SpeechError::Unavailable),
                        None => Ok(SpeechResult::Spoken),
                    };
                }
                Some(0) => thread::sleep(Duration::from_millis(40)),
                Some(21) => return Err(SpeechError::NoEngine),
                Some(22) => return Err(SpeechError::NoWords),
                _ => return Err(SpeechError::Unavailable),
            },
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => {
                stop(&mut child);
                return Err(SpeechError::Unavailable);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_use_local_desktop_engines_and_reply_stdin() {
        assert!(DICTATE.contains("SetInputToDefaultAudioDevice"));
        assert!(DICTATE.contains("DictationGrammar"));
        assert!(DICTATE.contains("-DESK"));
        assert!(DICTATE.contains("[Console]::ReadLine()"));
        assert!(SPEAK.contains("[Console]::ReadLine()"));
        assert!(SPEAK.contains("[Console]::In.ReadToEnd()"));
        assert!(SPEAK.contains("TTS_MS_"));
        assert!(SPEAK.contains("$voice.Speak($text)"));
        assert_eq!(DICTATION_LIMIT.as_secs(), 15);
        assert_eq!(SPEAKING_LIMIT.as_secs(), 120);
    }

    #[test]
    fn pre_cancelled_and_invalid_locale_requests_stop_before_the_child() {
        let unexpected_child = |_: &Child| -> std::io::Result<()> { panic!("unexpected speech child") };
        assert!(matches!(
            run(
                SpeechRequest::Dictate { locale: "en-US" },
                Arc::new(AtomicBool::new(true)),
                unexpected_child
            ),
            Err(SpeechError::Cancelled)
        ));
        assert!(matches!(
            run(
                SpeechRequest::Dictate { locale: "invalid" },
                Arc::new(AtomicBool::new(false)),
                unexpected_child
            ),
            Err(SpeechError::NoEngine)
        ));
    }
}
