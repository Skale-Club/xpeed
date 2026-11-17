"""Read-only bounded AMS2/Wreckfest native source probe. No assets are written.

Bag wrapper/LZ4 control flow follows gmazy/bag-decompress (CC0 source/main.c).
The WF2 aisc-v4 64-byte stride is an observed candidate, not a production schema.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct

MAX_BYTES = 8 * 1024 * 1024


def require_range(data, offset, size, context):
    """Reject truncated ranges before indexing or struct decoding."""
    if offset < 0 or size < 0 or offset + size > len(data):
        raise ValueError(f"Truncated {context}")


def decode(data, max_bytes=MAX_BYTES):
    """Decode one bounded Bag wrapper without writing the resulting asset."""
    if not 12 <= max_bytes <= MAX_BYTES:
        raise ValueError("Invalid output limit")
    if len(data) > MAX_BYTES or len(data) < 12:
        raise ValueError("Input limit/header")
    if data[0] not in (4, 7, 10):
        raise ValueError("Unsupported wrapper")
    position = 12
    output = bytearray(data[:12])
    output[0] = 1
    prefix_size = 8 if data[0] in (7, 10) else 4

    while position < len(data):
        require_range(data, position, prefix_size, "block prefix")
        block_size = struct.unpack_from("<I", data, position)[0]
        position += prefix_size
        block_end = position + block_size
        if block_size == 0 or block_end > len(data):
            raise ValueError("Invalid block length")

        def extension(length):
            nonlocal position
            while True:
                if position >= block_end:
                    raise ValueError("Truncated length extension")
                value = data[position]
                position += 1
                length += value
                if value != 255:
                    return length

        while position < block_end:
            token = data[position]
            position += 1
            literal_length = token >> 4
            match_length = (token & 15) + 4
            if literal_length == 15:
                literal_length = extension(literal_length)
            if position + literal_length > block_end:
                raise ValueError("Truncated literal")
            if len(output) + literal_length > max_bytes:
                raise ValueError("Output limit")
            output.extend(data[position:position + literal_length])
            position += literal_length
            if position == block_end:
                break
            if position + 2 > block_end:
                raise ValueError("Truncated backreference")
            offset = struct.unpack_from("<H", data, position)[0]
            position += 2
            if not 0 < offset <= len(output):
                raise ValueError("Invalid backreference offset")
            if match_length == 19:
                match_length = extension(match_length)
            if len(output) + match_length > max_bytes:
                raise ValueError("Output limit")
            for _ in range(match_length):
                output.append(output[-offset])
        if position != block_end:
            raise ValueError("Block trailing bytes")
    return bytes(output)


def read(path):
    """Read at most the input cap, including if a file grows after stat()."""
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("Input exceeds 8 MiB probe limit")
    with path.open("rb") as source:
        data = source.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Input exceeds 8 MiB probe limit")
    return data


def wf(path):
    data = read(path)
    raw = decode(data)
    result = {
        "file": path.name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "decodedBytes": len(raw),
        "wrapper": data[0],
    }
    # A marker scan is a research candidate, never proof of scene membership.
    marker = raw.find(b"tria")
    if marker < 0:
        result["airRoute"] = (
            "No airt marker in this decoded file; not a game-wide absence claim"
        )
        return result
    require_range(raw, marker, 24, "candidate route header")
    version, route_count = struct.unpack_from("<II", raw, marker + 4)
    result.update(airtVersion=version, routeCount=route_count)
    if route_count != 1 or raw[marker + 12:marker + 16] != b"csia":
        raise ValueError("Unproved candidate route structure")
    record_version, count = struct.unpack_from("<II", raw, marker + 16)
    start = marker + 24
    if record_version != 4 or not 2 <= count <= 10000:
        raise ValueError("Unproved candidate sector layout/count")
    require_range(raw, start, 64 * count + 36, "candidate sectors/trailer")
    rows = [struct.unpack_from("<14f2I", raw, start + 64 * i)
            for i in range(count)]
    if not all(math.isfinite(value) for row in rows for value in row[:14]):
        raise ValueError("Non-finite candidate sectors")
    points = [row[:3] for row in rows] + [row[3:6] for row in rows]
    widths = [math.dist(row[:3], row[3:6]) for row in rows]
    trailer = raw[start + 64 * count + 32:start + 64 * count + 36]
    result.update(
        aiscVersion=record_version,
        sectors=count,
        candidateStride=64,
        candidateBounds=[
            [min(point[axis] for point in points),
             max(point[axis] for point in points)]
            for axis in range(3)
        ],
        candidateWidthRange=[min(widths), max(widths)],
        trailerMarkerHex=trailer.hex(),
        schemaStatus=(
            "Candidate v4 record found by marker scan; scene membership, "
            "trailing fields and complete scene semantics are not validated"
        ),
    )
    return result


def ams(path):
    data = read(path)
    if data[:4] != b" KAP" or len(data) < 0x130:
        raise ValueError("Invalid BFF header")
    count = struct.unpack_from("<I", data, 8)[0]
    table_size = struct.unpack_from("<I", data, 0x118)[0]
    if count > 10000 or table_size != count * 42:
        raise ValueError("Invalid BFF table count/size")
    require_range(data, 0x130, table_size, "BFF table")
    invalid = 0
    for i in range(count):
        position = struct.unpack_from("<Q", data, 0x130 + 42 * i + 8)[0]
        size = struct.unpack_from("<I", data, 0x130 + 42 * i + 16)[0]
        invalid += int(position + size > len(data))
    return {
        "file": path.name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "count": count,
        "tocBytes": table_size,
        "headerFlags12c12f": data[0x12c:0x130].hex(),
        "plainTocOutOfBounds": invalid,
        "status": (
            "Stock table is not interpretable with the published unencrypted "
            "writer; no geometry decoded"
        ),
    }


def self_test():
    """Exercise decoder bounds entirely with synthetic, non-game data."""
    header = struct.pack("<I4sI", 7, b"hncs", 1)

    def wrapped(block):
        return header + struct.pack("<II", len(block), 0) + block

    assert decode(wrapped(b"\x30abc"))[12:] == b"abc"
    # One literal and an overlapping four-byte backreference.
    assert decode(wrapped(b"\x10a\x01\x00"))[12:] == b"aaaaa"
    hostile = {
        "empty header": b"",
        "unsupported wrapper": b"\x08" + header[1:],
        "truncated prefix": header + b"\x01",
        "block exceeds input": header + struct.pack("<II", 100, 0),
        "zero block": wrapped(b""),
        "truncated literal extension": wrapped(b"\xf0\xff"),
        "truncated literal": wrapped(b"\x30ab"),
        "truncated backreference": wrapped(b"\x00\x01"),
        "zero backreference": wrapped(b"\x00\x00\x00"),
        "oversized backreference": wrapped(b"\x00\xff\xff"),
        "truncated match extension": wrapped(b"\x0f\x01\x00\xff"),
        "input cap": b"x" * (MAX_BYTES + 1),
    }
    for name, data in hostile.items():
        try:
            decode(data)
        except ValueError:
            continue
        raise AssertionError(f"Accepted hostile input: {name}")
    # Lower output caps exercise the same pre-allocation checks cheaply.
    for block in (b"\x30abc", b"\x10a\x01\x00"):
        try:
            decode(wrapped(block), max_bytes=14)
        except ValueError:
            continue
        raise AssertionError("Accepted output beyond cap")
    print("PASS: 2 valid blocks, 12 hostile inputs, literal/match output caps")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--ams2", type=Path)
    parser.add_argument("--wreckfest2", type=Path)
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.ams2 is None or args.wreckfest2 is None:
        parser.error("Provide both --ams2 and --wreckfest2, or use --self-test")
    names = ("route1.scnh", "route1rev.scnh", "track01_1.scne", "track01_1.tcat")
    root = args.wreckfest2 / "data/art/levels/track01_1"
    result = {
        "ams2": ams(args.ams2 / "Pakfiles/Tracks/Adelaide_Modern_Physics.bff"),
        "wreckfest2": [wf(root / name) for name in names],
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
