//! Bounded, read-only KSPackage access. Only the requested entry is read; no
//! extraction into the game directory or whole-package allocation takes place.
//! Format reference: Nenkai/ACEvo.Package (MIT), PackFile/PackFileEntry, 1.1.0.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const KEY: u64 = 0x9f97_21a9_7d11_35c1;
const RECORD: u64 = 256;
const TABLES: [u64; 2] = [64 * 1024 * 1024, 32 * 1024 * 1024];

fn hash_path(path: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for word in path.to_ascii_lowercase().replace('/', "\\").encode_utf16() {
        for byte in word.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    hash
}

fn xor(bytes: &mut [u8]) {
    let key = KEY.to_le_bytes();
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte ^= key[i % 8];
    }
}

#[derive(Debug)]
struct Entry {
    name: String,
    hash: u64,
    offset: u64,
    size: u64,
    flags: u16,
}

fn entry(raw: &mut [u8; 256], table_start: u64) -> Result<Option<Entry>, String> {
    xor(raw);
    let hash = u64::from_le_bytes(raw[232..240].try_into().unwrap());
    if hash == 0 {
        return Ok(None);
    }
    let length = i16::from_le_bytes(raw[230..232].try_into().unwrap());
    if !(1..=224).contains(&length) {
        return Err("invalid KSPackage entry name length".into());
    }
    let name = std::str::from_utf8(&raw[..length as usize])
        .map_err(|_| "non-UTF8 KSPackage path")?
        .to_owned();
    // Binary search can probe unrelated editor/UI entries. Scope the requested
    // path below, not every legitimate name in the package's shared file table.
    if name.chars().any(char::is_control) || hash_path(&name) != hash {
        return Err("invalid KSPackage entry path/hash".into());
    }
    let flags = u16::from_le_bytes(raw[228..230].try_into().unwrap());
    if flags & !0x101 != 0 {
        return Err("unknown KSPackage entry flags".into());
    }
    let size = u64::from_le_bytes(raw[240..248].try_into().unwrap());
    let offset = u64::from_le_bytes(raw[248..256].try_into().unwrap());
    if offset.checked_add(size).is_none_or(|end| end > table_start) {
        return Err("KSPackage entry is outside the payload region".into());
    }
    Ok(Some(Entry {
        name,
        hash,
        offset,
        size,
        flags,
    }))
}

pub struct Package<R> {
    reader: R,
    table_start: u64,
    slots: u64,
}

impl Package<File> {
    pub fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("cannot open game package: {e}"))?;
        Self::detect(file, &TABLES)
    }
}

impl<R: Read + Seek> Package<R> {
    fn detect(mut reader: R, tables: &[u64]) -> Result<Self, String> {
        let length = reader.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        for &table_bytes in tables {
            if table_bytes < RECORD || table_bytes % RECORD != 0 || length < table_bytes {
                continue;
            }
            let table_start = length - table_bytes;
            reader.seek(SeekFrom::Start(table_start)).map_err(|e| e.to_string())?;
            let mut raw = [0u8; 256];
            reader.read_exact(&mut raw).map_err(|e| e.to_string())?;
            if entry(&mut raw, table_start).is_ok_and(|e| e.is_some()) {
                return Ok(Self {
                    reader,
                    table_start,
                    slots: table_bytes / RECORD,
                });
            }
        }
        Err("unrecognized KSPackage file table; source/tool revalidation required".into())
    }

    pub fn read(&mut self, requested: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
        let requested = requested.replace('/', "\\");
        if !requested.starts_with("content\\")
            || requested.len() > 224
            || !requested.is_ascii()
            || requested.split('\\').any(|p| p.is_empty() || p == "." || p == "..")
            || requested.chars().any(|c| c.is_control() || c == ':')
        {
            return Err("invalid requested KSPackage path".into());
        }
        let wanted = hash_path(&requested);
        let (mut lo, mut hi) = (0, self.slots);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            self.reader
                .seek(SeekFrom::Start(self.table_start + mid * RECORD))
                .map_err(|e| e.to_string())?;
            let mut raw = [0u8; 256];
            self.reader.read_exact(&mut raw).map_err(|e| e.to_string())?;
            match entry(&mut raw, self.table_start)? {
                None => hi = mid, // Padding follows sorted nonzero hashes.
                Some(e) if e.hash > wanted => hi = mid,
                Some(e) if e.hash < wanted => lo = mid + 1,
                Some(e) => {
                    if !e.name.eq_ignore_ascii_case(&requested) || e.flags & 1 != 0 {
                        return Err("KSPackage name/hash mismatch or directory in place of file".into());
                    }
                    if e.size == 0 || e.size > max_bytes as u64 {
                        return Err(format!("KSPackage entry exceeds the {max_bytes}-byte input bound or is empty"));
                    }
                    self.reader.seek(SeekFrom::Start(e.offset)).map_err(|e| e.to_string())?;
                    let mut data = vec![0; e.size as usize];
                    self.reader.read_exact(&mut data).map_err(|e| e.to_string())?;
                    if e.flags & 0x100 != 0 {
                        xor(&mut data);
                    }
                    return Ok(data);
                }
            }
        }
        Err(format!("requested native source is absent from KSPackage: {requested}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn fixture() -> Vec<u8> {
        let mut data = b"prefix".to_vec();
        let mut records = Vec::new();
        for (name, bytes, flags) in [
            ("content\\b.bin", b"eleven-byte".as_slice(), 0x100u16),
            ("content\\a.bin", b"plain".as_slice(), 0),
            ("cfg", b"".as_slice(), 1),
        ] {
            let offset = data.len() as u64;
            let mut payload = bytes.to_vec();
            if flags != 0 {
                xor(&mut payload);
            }
            data.extend(payload);
            let mut row = [0u8; 256];
            row[..name.len()].copy_from_slice(name.as_bytes());
            row[228..230].copy_from_slice(&flags.to_le_bytes());
            row[230..232].copy_from_slice(&(name.len() as i16).to_le_bytes());
            row[232..240].copy_from_slice(&hash_path(name).to_le_bytes());
            row[240..248].copy_from_slice(&(bytes.len() as u64).to_le_bytes());
            row[248..256].copy_from_slice(&offset.to_le_bytes());
            records.push((hash_path(name), row));
        }
        records.sort_by_key(|r| r.0);
        for (_, mut row) in records {
            xor(&mut row);
            data.extend(row);
        }
        for _ in 0..5 {
            let mut row = [0u8; 256];
            xor(&mut row);
            data.extend(row);
        }
        data
    }

    #[test]
    fn selected_entry_reads_match_plain_and_encrypted_partial_words() {
        let mut p = Package::detect(Cursor::new(fixture()), &[2048]).unwrap();
        assert_eq!(p.read("content/b.bin", 100).unwrap(), b"eleven-byte");
        assert_eq!(p.read("content/a.bin", 100).unwrap(), b"plain");
        assert!(p.read("content/missing.bin", 100).is_err());
        assert!(p.read("content/b.bin", 4).is_err());
        assert!(p.read("content/../b.bin", 100).is_err());
        assert!(p.read("cfg", 100).is_err(), "requested entries remain scoped to game content");
    }

    #[test]
    fn damaged_tables_and_out_of_region_payloads_are_refused() {
        assert!(Package::detect(Cursor::new(vec![0; 20]), &[2048]).is_err());
        let mut bytes = fixture();
        let start = bytes.len() - 2048;
        let mut row: [u8; 256] = bytes[start..start + 256].try_into().unwrap();
        xor(&mut row);
        row[248..256].copy_from_slice(&u64::MAX.to_le_bytes());
        xor(&mut row);
        bytes[start..start + 256].copy_from_slice(&row);
        assert!(Package::detect(Cursor::new(bytes), &[2048]).is_err());
    }
}
