//! The device key protected by Windows (DPAPI, `CryptProtectData`), so `config.json` does not hold it in plain text.
//!
//! The protection is tied to the signed-in Windows user: the bytes only open for the same user on the same profile.
//! A profile copied to another user or PC cannot read them, and that is the point. An application-specific entropy
//! string is mixed in, so another program of the same user cannot trivially unprotect the value with a plain call.
//! Outside Windows there is no such facility: `protect` says so and the configuration keeps the key as before.

/// The entropy of this app's protected values. It is part of the format: changing it makes every stored key unreadable.
pub const ENTROPY: &[u8] = b"Xpeed Companion device key v1";

/// Protects `data` for the current Windows user with `entropy`.
#[cfg(windows)]
pub fn protect_with(data: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let blob = |bytes: &[u8]| CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let (input, extra) = (blob(data), blob(entropy));
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // Safety: the blobs point at slices that outlive the call; the output is allocated by Windows and freed below.
    unsafe {
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            &extra,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 || output.pbData.is_null() {
            return Err("Windows could not protect the device key".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        Ok(bytes)
    }
}

/// Opens what `protect_with` made, for the same Windows user and the same `entropy`.
#[cfg(windows)]
pub fn unprotect_with(blob: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    if blob.is_empty() {
        return Err("the protected value is empty".into());
    }
    let (input, extra) = (
        CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_ptr().cast_mut(),
        },
        CRYPT_INTEGER_BLOB {
            cbData: entropy.len() as u32,
            pbData: entropy.as_ptr().cast_mut(),
        },
    );
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // Safety: as in `protect_with`.
    unsafe {
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            &extra,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 || output.pbData.is_null() {
            return Err("Windows could not open the protected device key (another user or computer?)".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        // The plain key was in that memory: wipe it before handing it back to Windows.
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        LocalFree(output.pbData.cast());
        Ok(bytes)
    }
}

#[cfg(not(windows))]
pub fn protect_with(_data: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, String> {
    Err("this system has no protection for the device key".into())
}

#[cfg(not(windows))]
pub fn unprotect_with(_blob: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, String> {
    Err("this system cannot open a protected device key".into())
}

pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    protect_with(data, ENTROPY)
}

pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    unprotect_with(blob, ENTROPY)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn protecting_then_unprotecting_gives_the_same_bytes_and_hides_the_text() {
        let key = b"xpd_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
        let protected = protect(key).unwrap();
        assert_ne!(protected.as_slice(), key.as_slice());
        assert!(
            !protected.windows(8).any(|w| w == b"xpd_0123"),
            "the key does not appear in the clear"
        );
        assert_eq!(unprotect(&protected).unwrap(), key);
        // Two protections of the same bytes are not the same bytes (DPAPI salts each one), and both open.
        assert_ne!(protect(key).unwrap(), protected);
    }

    #[test]
    fn another_entropy_cannot_open_it() {
        let protected = protect_with(b"xpd_secret", b"one").unwrap();
        assert_eq!(unprotect_with(&protected, b"one").unwrap(), b"xpd_secret");
        assert!(unprotect_with(&protected, b"two").is_err());
        assert!(unprotect(&protected).is_err(), "not with this app's entropy either");
    }

    #[test]
    fn rubbish_is_refused() {
        assert!(unprotect(b"not a dpapi blob").is_err());
        assert!(unprotect(&[]).is_err());
    }
}
