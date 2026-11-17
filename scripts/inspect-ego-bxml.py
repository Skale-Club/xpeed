"""Bounded read-only EGO little-endian BXML schema probe (not a track importer).

Format reference: EgoEngineModding/Ego-Engine-Modding,
src/EgoEngineLibrary/Xml/XmlBinaryReader.cs and XmlFile.cs.
Proprietary inputs and optional decoded trees stay in ignored local storage.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import struct
import sys

MAX_BYTES = 4 * 1024 * 1024
MAX_NODES = 100_000
MAX_DEPTH = 32
MAX_STRING = 16_384
LOCAL = Path(__file__).resolve().parent.parent / '.codex-local'


def parse(data):
    if len(data) > MAX_BYTES or data[:5] != b'\x01BXML':
        raise ValueError('Expected bounded little-endian BXML')
    at = 5
    nodes = 0

    def take(n):
        nonlocal at
        if n < 0 or at + n > len(data):
            raise ValueError('Truncated BXML record')
        result = data[at:at+n]
        at += n
        return result

    def string():
        nonlocal at
        end = data.find(b'\0', at, min(len(data), at + MAX_STRING + 1))
        if end < 0:
            raise ValueError('Unterminated or excessive BXML string')
        result = data[at:end].decode('utf-8')
        at = end + 1
        return result

    def node(depth):
        nonlocal nodes
        nodes += 1
        if depth > MAX_DEPTH or nodes > MAX_NODES:
            raise ValueError('BXML node/depth bound')
        start = at
        length, kind, pad, count = struct.unpack('<hBBh', take(6))
        if pad or length < 4 or count < 0 or count > 1024:
            raise ValueError('Invalid BXML record header')
        if kind == 5:
            if length != 4 or count:
                raise ValueError('Invalid BXML close record')
            return None
        if kind == 1:
            if count:
                raise ValueError('Text node has attributes')
            result = {'text': string()}
        elif kind == 0:
            name = string()
            attributes = {}
            for _ in range(count):
                key, value = string(), string()
                if not key or key in attributes:
                    raise ValueError('Invalid or duplicate BXML attribute')
                attributes[key] = value
            if not name:
                raise ValueError('Empty BXML element name')
            result = {'tag': name, 'attributes': attributes, 'children': []}
        else:
            raise ValueError('Unsupported BXML node type')
        if at != start + 2 + length:
            raise ValueError('BXML record length disagrees with its fields')
        if kind == 0:
            while True:
                child = node(depth + 1)
                if child is None:
                    break
                result['children'].append(child)
        return result

    root = node(0)
    # XmlFile.Write appends two explicit end-of-document records.
    eof = struct.pack('<hBBh', 4, 6, 0, 0) * 2
    if root is None or 'tag' not in root or data[at:] != eof:
        raise ValueError('BXML root lacks the exact double document terminator or has trailing bytes')
    return root


def summary(root):
    tags = Counter()
    attributes = defaultdict(set)
    def walk(node):
        if 'tag' in node:
            tags[node['tag']] += 1
            attributes[node['tag']].update(node['attributes'])
            for child in node['children']:
                walk(child)
    walk(root)
    return {'root': root['tag'], 'rootAttributes': root['attributes'],
            'tagCounts': dict(sorted(tags.items())),
            'attributeNames': {k: sorted(v) for k, v in sorted(attributes.items())}}


def self_test():
    close = struct.pack('<hBBh', 4, 5, 0, 0)
    def element(name, attrs, children=b''):
        body = struct.pack('<BBh', 0, 0, len(attrs)) + name.encode() + b'\0'
        for key, value in attrs:
            body += key.encode() + b'\0' + value.encode() + b'\0'
        return struct.pack('<h', len(body)) + body + children + close
    valid = b'\x01BXML' + element('track', [('name', 'synthetic')], element('position', [('x', '1'), ('y', '2'), ('z', '3')])) + struct.pack('<hBBh', 4, 6, 0, 0)*2
    root = parse(valid)
    assert root['children'][0]['attributes'] == {'x': '1', 'y': '2', 'z': '3'}
    malformed = [valid[:-1], valid+b'x', b'bad', b'\x01BXML'+element('track', [('a', '1'), ('a', '2')]),
                 b'\x01BXML'+struct.pack('<hBBh', 4, 2, 0, 0), valid[:5]+b'\xff\x7f'+valid[7:]]
    nested = element('leaf', [])
    for _ in range(MAX_DEPTH+1):
        nested = element('branch', [], nested)
    malformed.append(b'\x01BXML'+nested)
    for bad in malformed:
        try:
            parse(bad)
        except (ValueError, UnicodeError):
            pass
        else:
            raise AssertionError('Malformed BXML accepted')
    print('8 bounded BXML checks passed')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', nargs='?')
    p.add_argument('--out')
    p.add_argument('--self-test', action='store_true')
    args = p.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.input:
        p.error('input required')
    source = Path(args.input)
    with source.open('rb') as handle:
        data = handle.read(MAX_BYTES+1)
    tree = parse(data)
    report = dict(summary(tree), bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                  scope='Schema only; source units, coordinates, boundaries and telemetry alignment unverified')
    if args.out:
        output = Path(args.out).resolve()
        if not output.is_relative_to(LOCAL.resolve()):
            raise ValueError('Decoded proprietary tree output must stay under ignored .codex-local')
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('x', encoding='utf-8') as handle:
            json.dump({'summary': report, 'tree': tree}, handle, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, UnicodeError, struct.error) as error:
        sys.exit(str(error))
