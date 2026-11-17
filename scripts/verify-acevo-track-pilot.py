"""Validate a local EVO extraction against its own source and recorded laps.

Requires Python 3.11, protobuf, numpy, scipy and matplotlib. Game assets and
generated descriptors stay local. This checks sampled AI geometry, not meshes
or the accuracy of the shared-memory reader. Never writes into the game.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct

import numpy as np
from scipy.spatial import cKDTree
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def message_pool(path):
    descriptors = descriptor_pb2.FileDescriptorSet.FromString(Path(path).read_bytes())
    pending = {f.name: f for f in descriptors.file}
    pool = descriptor_pool.DescriptorPool()
    while pending:
        progress = False
        for name, fd in list(pending.items()):
            if any(dep in pending for dep in fd.dependency):
                continue
            pool.Add(fd)
            del pending[name]
            progress = True
        if not progress:
            raise ValueError("Unresolved descriptor dependencies")
    return pool


def decode(pool, name, path):
    cls = message_factory.GetMessageClass(pool.FindMessageTypeByName(name))
    return cls.FromString(Path(path).read_bytes())


def columns(path, magic):
    raw = Path(path).read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    if raw[:4] != magic:
        raise ValueError("Unexpected file magic")
    size = struct.unpack_from("<I", raw, 8)[0]
    header = json.loads(raw[12:12 + size])
    offset = 12 + size
    sections = header.get("sections", [{"id": "lap", "count": header.get("sampleCount"), "channels": [c["id"] for c in header.get("channels", [])]}])
    data = {}
    for section in sections:
        count = section["count"]
        data[section["id"]] = {}
        for channel in section["channels"]:
            data[section["id"]][channel] = np.frombuffer(raw, dtype="<f4", count=count, offset=offset).astype(float)
            offset += 4 * count
    if offset != len(raw):
        raise ValueError("File length disagrees with columns")
    return header, data


def quantiles(values):
    return dict(zip(("median", "p95", "p99", "max"), map(float, np.quantile(values, [.5, .95, .99, 1]))))


def nearest_segments(points, line):
    """Exact planar segment projection; batches bound temporary memory."""
    a = line[:, [0, 2]]
    v = np.roll(a, -1, axis=0) - a
    norm = np.sum(v * v, axis=1)
    norm[norm == 0] = 1
    indices, fractions, distances = [], [], []
    for batch in np.array_split(points, math.ceil(len(points) / 256)):
        delta = batch[:, None, :] - a[None, :, :]
        t = np.clip(np.sum(delta * v, axis=2) / norm, 0, 1)
        dist = np.sum((delta - t[:, :, None] * v) ** 2, axis=2)
        at = np.argmin(dist, axis=1)
        indices.extend(at)
        fractions.extend(t[np.arange(len(batch)), at])
        distances.extend(np.sqrt(dist[np.arange(len(batch)), at]))
    return np.array(indices), np.array(fractions), np.array(distances)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("descriptor", "ideal", "controls", "track", "out"):
        parser.add_argument("--" + arg, required=True, type=Path)
    parser.add_argument("--laps", type=Path, default=Path("xpeed-sim/fixtures/laps"))
    parser.add_argument("--steam-build", required=True)
    args = parser.parse_args()
    pool = message_pool(args.descriptor)
    source = decode(pool, "AISplineData", args.ideal)
    controls = decode(pool, "TrackControlPoints", args.controls)
    p = np.array([[-v.point.x, v.point.y, v.point.z] for v in source.spline_data.points])
    forward = np.array([[-v.forwardVector.x, v.forwardVector.z] for v in source.payloads])
    normal = np.column_stack([forward[:, 1], -forward[:, 0]])
    normal /= np.linalg.norm(normal, axis=1)[:, None]
    # The x reflection changes handedness: source side 1 is stored left.
    sides = np.array([[v.sides_1, v.sides_0] for v in source.payloads])
    left = p[:, [0, 2]] + normal * sides[:, :1]
    right = p[:, [0, 2]] - normal * sides[:, 1:]
    header, exported = columns(args.track, b"XTRK")
    edges = exported["boundaries"]
    stored_left = np.column_stack([edges["left_x"], edges["left_z"]])
    stored_right = np.column_stack([edges["right_x"], edges["right_z"]])
    edge_error = np.r_[np.linalg.norm(left - stored_left, axis=1), np.linalg.norm(right - stored_right, axis=1)]
    cp = np.array([[-c.ideal_line_position.x, c.ideal_line_position.z] for c in controls.control_points])
    cp_distance, cp_indices = cKDTree(p[:, [0, 2]]).query(cp)
    cp_sides = np.array([[c.side_right, c.side_left] for c in controls.control_points])
    cp_error = np.abs(cp_sides - sides[cp_indices])
    gap = np.linalg.norm(np.roll(p, -1, axis=0) - p, axis=1)
    report = {
        "game": "acevo", "steamBuild": args.steam_build, "identity": header["track"],
        "sourceSha256": digest(args.ideal), "controlsSha256": digest(args.controls),
        "descriptorSha256": digest(args.descriptor), "exportSha256": digest(args.track),
        "pointCount": len(p), "controlPointCount": len(cp),
        "sourceLengthM": source.spline_data.length,
        "horizontalPolylineLengthM": float(np.linalg.norm(np.roll(p[:, [0, 2]], -1, axis=0) - p[:, [0, 2]], axis=1).sum()),
        "elevationRangeM": [float(p[:, 1].min()), float(p[:, 1].max())],
        "maxSourceStep3dM": float(gap.max()), "closingStep3dM": float(gap[-1]),
        "signedSideNonpositiveCounts": np.sum(sides <= 0, axis=0).tolist(),
        "boundaryExportErrorM": quantiles(edge_error),
        "controlPositionErrorM": quantiles(cp_distance), "controlSideErrorM": quantiles(cp_error),
        "limitations": ["AI side samples, not verified mesh or white-line limits", "Historical lap x reflected explicitly; files unchanged", "Edge elevation and banking unverified; centerline y preserved", "Source distance origin is not proven to be timing start/finish", "Local use only; redistribution permission not established"],
        "laps": [],
    }
    passed = bool(edge_error.max() < .001 and cp_distance.max() < .01 and np.median(cp_error) < .05 and gap.max() < 10)
    plot_lap = None
    for path in sorted(args.laps.glob("acevo*.xlap.gz")):
        h, data = columns(path, b"XLAP")
        c = data["lap"]
        lap = np.column_stack([-c["x"], c["z"]])
        i, t, distance = nearest_segments(lap, p)
        nxt = (i + 1) % len(p)
        blend = lambda values: values[i] * (1 - t[:, None]) + values[nxt] * t[:, None]
        l, r = blend(left), blend(right)
        across = l - r
        width = np.linalg.norm(across, axis=1)
        lateral = np.sum((lap - r) * across, axis=1) / width
        outside = np.maximum(np.maximum(-lateral, lateral - width), 0)
        y = p[i, 1] * (1 - t) + p[nxt, 1] * t
        height_error = np.abs(c["y"] - y)
        result = {"file": path.name, "sha256": digest(path), "valid": h["lap"]["valid"],
                  "samples": len(lap), "distanceToIdealM": quantiles(distance),
                  "outsideRoadM": quantiles(outside), "outsideOverHalfMetreShare": float(np.mean(outside > .5)),
                  "heightErrorM": quantiles(height_error), "reportedLengthM": h["track"].get("lengthM")}
        report["laps"].append(result)
        if h["lap"]["valid"]:
            passed &= bool(np.mean(outside > .5) < .02 and np.quantile(height_error, .95) < .5)
            plot_lap = lap
    if plot_lap is None:
        passed = False
    report["acceptancePassed"] = bool(passed)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import PolyCollection
    fig, axes = plt.subplots(1, 2, figsize=(13, 8), gridspec_kw={"width_ratios": [2, 1]})
    quads = np.stack([left, np.roll(left, -1, axis=0), np.roll(right, -1, axis=0), right], axis=1)
    ax = axes[0]
    ax.add_collection(PolyCollection(quads, facecolors="#424a55", edgecolors="none", antialiaseds=False))
    for e in (left, right):
        ring = np.vstack([e, e[0]])
        ax.plot(*ring.T, color="#8a929d", lw=.5)
    if plot_lap is not None:
        ax.plot(*plot_lap.T, color="#00b6ca", lw=1, label="Historical valid lap (x corrected)")
    ax.plot(*p[:, [0, 2]].T, color="#dfad3c", lw=.5, label="EVO ideal line")
    ax.autoscale_view(); ax.set_aspect("equal"); ax.invert_yaxis(); ax.legend(fontsize=7)
    ax.set_title("Laguna Seca — native EVO AI side samples"); ax.set_xlabel("Normalized X (m)"); ax.set_ylabel("Z (m)")
    axes[1].plot(np.arange(len(p)), p[:, 1]); axes[1].set_title("Source elevation"); axes[1].set_ylabel("World Y (m)")
    axes[1].set_xlabel("Source sample")
    fig.text(.05, .02, "Local extraction pilot; AI-side semantics checked against 52 control points. Mesh/white-line and live-game acceptance pending.", fontsize=8)
    fig.tight_layout(rect=[0, .04, 1, 1]); fig.savefig(args.out / "native-overlay.png", dpi=150); plt.close(fig)
    print(json.dumps(report, indent=2))
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
