"""Bounded offline LMU MAS index/access probe; never enables geometry support.

The format research reference is nlhans/MAS2Extract, MAS2Reader.cs at
f26563f1713ca7596d9baa580205a0fbfdc18611. Supply that original source with
--reader-source; its published format constants are read as data, never executed.
Only the LMU100_MAS_2.90 layout variant observed locally is accepted. Payloads
are untouched unless one exact .AIW filename is explicitly selected.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import tempfile
import zlib

SOURCE_SHA256 = '681bf4f022c7b548b7b5b76e1e299bd5cfbc2bfb60a85a39d788b7c703bed3ba'
MAX_INDEX = 4 * 1024 * 1024
MAX_PAYLOAD = 16 * 1024 * 1024
LOCAL_ROOT = Path(__file__).resolve().parent.parent / '.codex-local'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def format_keys(source):
    raw = Path(source).read_bytes()
    if digest(raw) != SOURCE_SHA256:
        raise ValueError('Reference source SHA256 differs from the pinned research version')
    text = raw.decode('utf-8-sig')
    result = []
    for name, size in [('FileTypeKeys', 16), ('FileHeaderKeys', 256)]:
        body = text.split(name + ' = new byte[]', 1)[1].split('};', 1)[0]
        values = [int(v, 0) for v in re.findall(r'0x[0-9A-Fa-f]+|\b0\b', body)]
        if len(values) != size:
            raise ValueError('Invalid reference constants')
        result.append(values)
    return result


def transform_index(data, salt, salt2, keys):
    salt += 64 if salt < 64 else 0
    salt2 += 64 if salt2 < 64 else 0
    result = bytearray()
    for i, byte in enumerate(data):
        shift = i & 63
        value = (keys[(i + i // 256) % 256] << shift) & 0xffffffffffffffff
        low = i | (salt & value)
        high = (i >> 32) | (salt2 & (value >> 32))
        value = (low | (high << 32)) & 0xffffffffffffffff
        result.append(byte ^ ((value >> shift) & 255))
    return bytes(result)


def read_exact(handle, size):
    result = handle.read(size)
    if len(result) != size:
        raise ValueError('Truncated source')
    return result


def inspect(handle, size, keys):
    header = read_exact(handle, 124)
    kind = bytes(v ^ (k >> 1) for v, k in zip(header[:16], keys[0])).rstrip(b'\0')
    if kind != b'LMU100_MAS_2.90':
        raise ValueError('Unverified MAS variant: ' + repr(kind))
    count_bytes = struct.unpack_from('<I', header, 120)[0]
    if count_bytes < 12 or count_bytes > MAX_INDEX or (count_bytes - 12) % 256:
        raise ValueError('Invalid or excessive index length')
    if 124 + count_bytes > size:
        raise ValueError('Index exceeds source size')
    encoded = read_exact(handle, count_bytes)
    index = transform_index(encoded, *struct.unpack_from('<II', header, 16), keys[1])
    count = struct.unpack_from('<I', index, 4)[0]
    if count != (count_bytes - 12) // 256:
        raise ValueError('Index count/length mismatch')
    entries = []
    names = set()
    start = 124 + count_bytes
    for i in range(count):
        base = i * 256
        slot = index[base + 16:base + 144]
        if b'\0' not in slot:
            raise ValueError('Unterminated index filename')
        name = slot.split(b'\0', 1)[0].decode('ascii')
        if not name or '/' in name or '\\' in name or name in ('.', '..') or name in names:
            raise ValueError('Unsafe or duplicate index filename')
        names.add(name)
        relative, unpacked, packed = (struct.unpack_from('<I', index, base + j)[0] for j in (244, 252, 260))
        if relative != start - 124 - count_bytes or start + packed > size:
            raise ValueError('Payload offsets exceed or disagree with source')
        entries.append({'name': name, 'offset': start, 'packedBytes': packed, 'unpackedBytes': unpacked})
        start += packed
    if start != size:
        raise ValueError('Unaccounted source bytes; variant remains unverified')
    return {'type': kind.decode('ascii'), 'sourceBytes': size, 'indexBytes': count_bytes,
            'headerIndexSha256': digest(header + encoded), 'entries': entries,
            'scope': 'Index access only; proprietary payload meaning and runtime alignment unverified'}


def extract_aiw(handle, entry):
    if not entry['name'].lower().endswith('.aiw'):
        raise ValueError('Only an explicitly selected AIW may be extracted')
    if not 0 < entry['packedBytes'] <= MAX_PAYLOAD or not 0 < entry['unpackedBytes'] <= MAX_PAYLOAD:
        raise ValueError('Selected payload exceeds extraction limit')
    handle.seek(entry['offset'])
    packed = read_exact(handle, entry['packedBytes'])
    if entry['packedBytes'] == entry['unpackedBytes']:
        data = packed
    else:
        decoder = zlib.decompressobj()
        data = decoder.decompress(packed, entry['unpackedBytes'] + 1)
        if len(data) != entry['unpackedBytes'] or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise ValueError('Invalid, oversized or trailing compressed payload')
    if len(data) != entry['unpackedBytes'] or b'\0' in data:
        raise ValueError('Selected payload is not bounded AIW text')
    text = data.decode('utf-8-sig')
    if '[Waypoint]' not in text:
        raise ValueError('Selected payload lacks the observed AIW section')
    fields = Counter(re.findall(r'(?im)^\s*(wp_\w+)\s*=', text))
    branches = Counter(re.findall(r'(?im)^[ \t]*wp_branchID=\((\d+)\)', text))
    schema = {'sha256': digest(data), 'packedSha256': digest(packed), 'bytes': len(data),
              'fieldCounts': dict(sorted(fields.items())), 'branchCounts': dict(sorted(branches.items())),
              'lapLengthDeclaration': re.findall(r'(?im)^lap_length=([^\r\n]+)', text)}
    return data, schema


def local_destination(directory, name):
    root = Path(directory).resolve()
    if not root.is_relative_to(LOCAL_ROOT.resolve()):
        raise ValueError('Extraction output must stay in the repository ignored .codex-local tree')
    destination = root / name
    if not destination.resolve().is_relative_to(root) or ':' in name:
        raise ValueError('Unsafe destination filename')
    return destination


def self_test(keys):
    import io
    text = b'[Waypoint]\nwp_pos=(0,0,0)\n'
    payload = zlib.compress(text)
    plain = bytearray(268)
    struct.pack_into('<I', plain, 4, 1)
    plain[16:22] = b'a.AIW\0'
    struct.pack_into('<I', plain, 252, len(text))
    struct.pack_into('<I', plain, 260, len(payload))
    header = bytearray(124)
    header[:16] = bytes(v ^ (k >> 1) for v, k in zip(b'LMU100_MAS_2.90\0\0', keys[0]))
    struct.pack_into('<II', header, 16, 100, 200)
    struct.pack_into('<I', header, 120, len(plain))
    data = bytes(header) + transform_index(plain, 100, 200, keys[1]) + payload
    report = inspect(io.BytesIO(data), len(data), keys)
    assert extract_aiw(io.BytesIO(data), report['entries'][0])[0] == text
    for bad in [data[:123], data[:-1], data + b'x', b'?' * len(data)]:
        try:
            inspect(io.BytesIO(bad), len(bad), keys)
        except (ValueError, UnicodeError):
            pass
        else:
            raise AssertionError('Malformed source accepted')
    entry = dict(report['entries'][0], unpackedBytes=len(text) - 1)
    try:
        extract_aiw(io.BytesIO(data), entry)
    except ValueError:
        pass
    else:
        raise AssertionError('Oversized inflated payload accepted')
    try:
        local_destination(tempfile.gettempdir(), 'a.AIW')
    except ValueError:
        pass
    else:
        raise AssertionError('External extraction destination accepted')
    print('7 bounded MAS/AIW synthetic checks passed', file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mas', nargs='?')
    parser.add_argument('--reader-source', required=True)
    parser.add_argument('--extract-aiw')
    parser.add_argument('--out-dir')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    keys = format_keys(args.reader_source)
    if args.self_test:
        self_test(keys)
        return
    if not args.mas or bool(args.extract_aiw) != bool(args.out_dir):
        parser.error('Supply MAS; extraction requires both --extract-aiw and --out-dir')
    source = Path(args.mas).resolve()
    with source.open('rb') as handle:
        report = inspect(handle, source.stat().st_size, keys)
        report.update({'source': str(source), 'referenceSourceSha256': SOURCE_SHA256})
        if args.extract_aiw:
            matches = [e for e in report['entries'] if e['name'] == args.extract_aiw]
            if len(matches) != 1:
                raise ValueError('Exact selected AIW filename not found')
            data, schema = extract_aiw(handle, matches[0])
            destination = local_destination(args.out_dir, matches[0]['name'])
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as output:
                output.write(data)
            report['selectedAiw'] = dict(schema, output=str(destination))
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, UnicodeError, zlib.error) as error:
        sys.exit(str(error))
