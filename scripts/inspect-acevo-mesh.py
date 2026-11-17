"""Inspect locally extracted EVO scene-linked asphalt, without changing the game.

Requires the protobuf/numpy/scipy dependencies of verify-acevo-track-pilot.py.
Inputs and generated geometry are proprietary local artifacts; do not commit them.
This is an offline evidence helper, not a runtime reader or physical survey.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import unittest

import numpy as np
from google.protobuf.json_format import MessageToDict

_spec = importlib.util.spec_from_file_location("evo_verifier", Path(__file__).with_name("verify-acevo-track-pilot.py"))
v = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v)


def identity(actor):
    t = actor.transform
    return (not actor.parent_container_guid and
            all(getattr(t.position, k) == 0 and getattr(t.rotation, k) == 0 and
                getattr(t.scale, k) == 1 for k in "xyz"))


def mesh_arrays(lod):
    if not lod.positions or len(lod.positions) % 3 or not lod.indices or len(lod.indices) % 3:
        raise ValueError("Mesh arrays must contain complete vertices and triangles")
    if len(lod.positions) > 3_000_000 or len(lod.indices) > 3_000_000:
        raise ValueError("Evidence helper mesh limit exceeded")
    p = np.asarray(lod.positions, dtype=np.float64).reshape(-1, 3)
    i = np.asarray(lod.indices, dtype=np.int64).reshape(-1, 3)
    if not np.isfinite(p).all() or i.min() < 0 or i.max() >= len(p):
        raise ValueError("Nonfinite vertex or out-of-range triangle index")
    for b in lod.batches:
        if b.startIndex < 0 or b.indexCount < 0 or b.startIndex % 3 or b.indexCount % 3 or b.startIndex + b.indexCount > i.size:
            raise ValueError("Invalid material batch range")
    p[:, 0] *= -1  # Same reader normalization, applied exactly once.
    return p, i



def triangle_grid(triangles, cell_size=20.):
    """Exact bounding-box broad phase; oversized faces stay in every query."""
    low = triangles[:, :, [0, 2]].min(axis=1)-1e-6
    high = triangles[:, :, [0, 2]].max(axis=1)+1e-6
    cells, broad = {}, []
    for i, (a, b) in enumerate(zip(np.floor(low/cell_size), np.floor(high/cell_size))):
        x0, z0 = map(int, a); x1, z1 = map(int, b)
        if (x1-x0+1)*(z1-z0+1) > 4096:
            broad.append(i)
            continue
        for x in range(x0, x1+1):
            for z in range(z0, z1+1):
                cells.setdefault((x, z), []).append(i)
    return {'cells': cells, 'broad': broad, 'size': cell_size,
            'low': low.min(axis=0), 'high': high.max(axis=0)}


def line_candidates(position, direction, grid):
    """All grid cells crossed by an infinite line within the source bounds."""
    lower, upper = -np.inf, np.inf
    for dim in range(2):
        if abs(direction[dim]) < 1e-12:
            if not grid['low'][dim] <= position[dim] <= grid['high'][dim]:
                return np.asarray(grid['broad'], dtype=np.int64)
        else:
            a, b = sorted(((grid['low'][dim]-position[dim])/direction[dim],
                           (grid['high'][dim]-position[dim])/direction[dim]))
            lower, upper = max(lower, a), min(upper, b)
    if lower > upper:
        return np.asarray(grid['broad'], dtype=np.int64)
    times = [lower, upper]
    size = grid['size']
    for dim in range(2):
        if abs(direction[dim]) < 1e-12:
            continue
        start = int(np.floor(grid['low'][dim]/size))+1
        end = int(np.ceil(grid['high'][dim]/size))
        for boundary in range(start, end):
            t = (boundary*size-position[dim])/direction[dim]
            if lower < t < upper:
                times.append(t)
    times.sort()
    found = set(grid['broad'])
    for a, b in zip(times, times[1:]):
        cell = tuple(np.floor((position+direction*((a+b)/2))/size).astype(int))
        found.update(grid['cells'].get(cell, []))
    return np.asarray(sorted(found), dtype=np.int64)


def surface_heights(points, triangles, return_indices=False, spatial=None):
    """Exact planar containment/barycentric Y, with one point's arrays at a time."""
    a = triangles[:, 0][:, [0, 2]]
    b = triangles[:, 1][:, [0, 2]] - a
    c = triangles[:, 2][:, [0, 2]] - a
    lo = triangles[:, :, [0, 2]].min(axis=1) - 1e-6
    hi = triangles[:, :, [0, 2]].max(axis=1) + 1e-6
    det = b[:, 0] * c[:, 1] - b[:, 1] * c[:, 0]
    spatial = spatial or triangle_grid(triangles)
    result = np.full(len(points), np.nan)
    matched = np.full(len(points), -1, dtype=np.int64)
    for n, p in enumerate(points):
        cell = tuple(np.floor(p[[0, 2]]/spatial['size']).astype(int))
        at = np.asarray(spatial['cells'].get(cell, [])+spatial['broad'], dtype=np.int64)
        at = at[np.all((p[[0, 2]] >= lo[at]) & (p[[0, 2]] <= hi[at]), axis=1) & (np.abs(det[at]) > 1e-10)]
        d = p[[0, 2]] - a[at]
        u = (d[:, 0] * c[at, 1] - d[:, 1] * c[at, 0]) / det[at]
        w = (b[at, 0] * d[:, 1] - b[at, 1] * d[:, 0]) / det[at]
        inside = (u >= -1e-6) & (w >= -1e-6) & (u + w <= 1.000001)
        at, u, w = at[inside], u[inside], w[inside]
        if len(at):
            y = triangles[at, 0, 1] * (1-u-w) + triangles[at, 1, 1] * u + triangles[at, 2, 1] * w
            nearest = np.argmin(np.abs(y-p[1]))
            result[n] = y[nearest]
            matched[n] = at[nearest]
    return (result, matched) if return_indices else result


def cross_sections(points, forward, triangles, spatial=None):
    """Intersect actual triangles with source-forward cross sections; merge 2 cm seams."""
    spatial = spatial or triangle_grid(triangles)
    edges = triangles[:, [[0, 1], [1, 2], [2, 0]], :]
    result = []
    for p, f in zip(points, forward):
        f = f / np.linalg.norm(f)
        normal = np.array([f[1], -f[0]])
        candidates = line_candidates(p[[0, 2]], normal, spatial)
        local = triangles[candidates][:, :, [0, 2]] - p[[0, 2]]
        along = local @ f
        selected = np.flatnonzero((along.min(axis=1) <= 0) & (along.max(axis=1) >= 0))
        intervals = []
        for at in selected:
            ab = along[at, [[0, 1], [1, 2], [2, 0]]]
            span = ab[:, 1] - ab[:, 0]
            valid = (ab[:, 0]*ab[:, 1] <= 0) & (np.abs(span) > 1e-10)
            if valid.sum() < 2:
                continue
            t = -ab[valid, 0] / span[valid]
            e = edges[candidates[at]][valid]
            xyz = e[:, 0] + (e[:, 1]-e[:, 0])*t[:, None]
            lateral = (xyz[:, [0, 2]]-p[[0, 2]]) @ normal
            order = np.argsort(lateral)
            intervals.append((float(lateral[order[0]]), float(lateral[order[-1]])))
        merged = []
        for start, end in sorted(intervals):
            if merged and start <= merged[-1][1]+.02:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        containing = [r for r in merged if r[0] <= 0 <= r[1]]
        if not containing:
            result.append(None)
        else:
            low, high = containing[0]
            left = p[[0, 2]] + high*normal
            right = p[[0, 2]] + low*normal
            result.append([*map(float, left), *map(float, right)])
    return result



def segment_crossings(line, across):
    """Exact 2D segment/segment crossing; excludes parallel/collinear segments."""
    a, b = line[:, [0, 2]], np.roll(line[:, [0, 2]], -1, axis=0)
    c, d = across[:, [0, 2]]
    r, q = b-a, d-c
    cross = lambda x, y: x[..., 0]*y[..., 1]-x[..., 1]*y[..., 0]
    det = cross(r, q)
    valid = np.abs(det) > 1e-12
    t = np.full(len(a), np.nan); u = t.copy()
    t[valid] = cross(c-a[valid], q)/det[valid]
    u[valid] = cross(c-a[valid], r[valid])/det[valid]
    at = np.flatnonzero(valid & (t >= 0) & (t <= 1) & (u >= 0) & (u <= 1))
    return [(int(i), float(t[i])) for i in at]


def timing_evidence(pool, path, source, points, laps):
    scene = v.decode(pool, 'SceneData', path)
    output = {'path': str(path), 'sha256': v.digest(path), 'zones': [], 'limitations': [
        'Timelines message carries no explicit finish flag or sector IDs in this schema',
        'Third-strip finish designation is inferred from historical lap boundaries',
        'Polygon center crossing is a geometric reference; exact engine enter/exit firing edge is unverified']}
    for actor in scene.scene_actors:
        if actor.actor.WhichOneof('actorType') != 'zones' or not any(i.WhichOneof('type') == 'timelines' for i in actor.actor.zones.data.instances):
            continue
        tr = actor.transform
        if actor.parent_container_guid or any(getattr(tr.rotation, k) != 0 or getattr(tr.scale, k) != 1 for k in 'xyz'):
            raise ValueError('Timing transform needs rotation/parent proof')
        translation = np.array([tr.position.x, tr.position.y, tr.position.z])
        for index, geometric in enumerate(actor.actor.zones.data.geometrics):
            p = np.array([[n.position.x, n.position.y, n.position.z] for n in geometric.points])+translation
            p[:, 0] *= -1
            if len(p) != 4:
                raise ValueError('Timing reference currently requires a four-point strip')
            lengths = np.linalg.norm(np.roll(p, -1, axis=0)-p, axis=1)
            short = int(np.argmin(lengths))
            across = np.array([(p[short]+p[(short+1)%4])/2, (p[(short+2)%4]+p[(short+3)%4])/2])
            crossings = []
            for i, t in segment_crossings(points, across):
                nxt = (i+1)%len(points)
                begin = source.spline_data.points[i].point_length
                end = source.spline_data.points[nxt].point_length if nxt else source.spline_data.length
                crossings.append({'sourceIndex': i, 'fraction': t, 'sourceDistanceM': begin+(end-begin)*t,
                                  'position': (points[i]*(1-t)+points[nxt]*t).tolist()})
            lap_ends = []
            for lap in sorted(laps.glob('acevo*.xlap.gz')):
                h, data = v.columns(lap, b'XLAP'); c = data['lap']
                ends = np.column_stack([-c['x'][[0,-1]], c['y'][[0,-1]], c['z'][[0,-1]]])
                a, b = across[:, [0,2]]; vec = b-a
                offset = np.clip(((ends[:,[0,2]]-a)@vec)/(vec@vec), 0, 1)
                dist = np.linalg.norm(ends[:,[0,2]]-(a+offset[:,None]*vec), axis=1)
                lap_ends.append({'file': lap.name, 'firstLastDistanceToStripCenterM': dist.tolist(),
                                 'firstLastDistChannelM': c['dist'][[0,-1]].tolist()})
            output['zones'].append({'geometricIndex': index, 'actorTranslation': translation.tolist(),
                                    'normalizedPolygon': p.tolist(), 'crossStripCenterLine': across.tolist(),
                                    'aiCenterLineCrossings': crossings, 'lapBoundaryDistances': lap_ends})
    return output



def compare_runtime(runtime_path, triangles, labels, normalized_points, normalized_forward):
    """Independent dynamic-protobuf geometry versus the manual Rust wire decoder."""
    tri = triangles[np.isin(labels, ['ASPH_OLD', 'ASPH_MID'])].copy()
    tri[:, :, 0] *= -1
    grid = triangle_grid(tri)
    points = normalized_points.copy()
    points[:, 0] *= -1
    forwards = normalized_forward.copy()
    forwards[:, 0] *= -1
    rows, gaps, ys = [], [], []
    for point, forward in zip(points, forwards):
        forward /= np.linalg.norm(forward)
        normal = np.array([forward[1], -forward[0]])
        ids = line_candidates(point[[0, 2]], normal, grid)
        faces = tri[ids]
        along = (faces[:, :, [0, 2]]-point[[0, 2]]) @ forward
        chosen = np.flatnonzero((along.min(1) <= 0) & (along.max(1) >= 0))
        intervals = []
        for i in chosen:
            ab = along[i, [[0, 1], [1, 2], [2, 0]]]
            span = ab[:, 1]-ab[:, 0]
            valid = (ab[:, 0]*ab[:, 1] <= 0) & (np.abs(span) > 1e-10)
            if valid.sum() < 2:
                continue
            fraction = -ab[valid, 0]/span[valid]
            edges = faces[i, [[0, 1], [1, 2], [2, 0]]][valid]
            xyz = edges[:, 0]+(edges[:, 1]-edges[:, 0])*fraction[:, None]
            lateral = (xyz[:, [0, 2]]-point[[0, 2]]) @ normal
            order = np.argsort(lateral)
            first, last = order[0], order[-1]
            low, high = float(lateral[first]), float(lateral[last])
            low_y, high_y = float(xyz[first, 1]), float(xyz[last, 1])
            if low > 64 or high < -64 or abs(low_y-point[1]) > 1 or abs(high_y-point[1]) > 1:
                continue
            intervals.append([low, high, low_y, high_y])
        merged = []
        for low, high, low_y, high_y in sorted(intervals, key=lambda q: q[0]):
            if merged and low <= merged[-1][1]+.0001 and abs(low_y-merged[-1][3]) <= 1:
                if high > merged[-1][1]:
                    merged[-1][1], merged[-1][3] = high, high_y
            else:
                merged.append([low, high, low_y, high_y])
        candidates = [q for q in merged if max(q[0], -q[1], 0) <= 3]
        if not candidates:
            rows.append([np.nan]*4)
            gaps.append(np.nan)
            ys.append(np.nan)
            continue
        low, high, low_y, high_y = min(candidates, key=lambda q: max(q[0], -q[1], 0))
        left = point[[0, 2]]+normal*high
        right = point[[0, 2]]+normal*low
        rows.append([*left, *right])
        gaps.append(max(low, -high, 0))
        ys.append((low_y+high_y)/2)
    if runtime_path.stat().st_size > 64*1024*1024:
        raise ValueError('Runtime evidence JSON exceeds bound')
    runtime = json.loads(runtime_path.read_text())
    if len(runtime) != len(points):
        raise ValueError('Runtime/source point counts differ')
    raw = np.array([q['asphalt'] for q in runtime], dtype=float)
    y = np.array([q['midpointY'] for q in runtime], dtype=float)
    gap = np.array([q['referenceGapM'] for q in runtime], dtype=float)
    delta = np.linalg.norm((np.array(rows)-raw).reshape(-1, 2), axis=1)
    report = {'rows': len(rows), 'asphaltTriangles': len(tri),
              'maxBoundaryFloat32ErrorM': float(np.nanmax(delta)),
              'boundaryErrorM': v.quantiles(delta[np.isfinite(delta)]),
              'maxMidpointYErrorM': float(np.nanmax(np.abs(np.array(ys)-y))),
              'maxReferenceGapErrorM': float(np.nanmax(np.abs(np.array(gaps)-gap))),
              'positiveAsphaltReferenceGaps': int(np.sum(gap > 0)),
              'maximumReferenceGapM': float(np.nanmax(gap)),
              'unknownRows': int(np.isnan(raw).any(1).sum()),
              'runtimeSha256': v.digest(runtime_path)}
    if not np.array_equal(np.isnan(np.array(rows)), np.isnan(raw)):
        raise ValueError('Runtime/source unknown rows differ')
    for field in ['maxBoundaryFloat32ErrorM', 'maxMidpointYErrorM', 'maxReferenceGapErrorM']:
        if report[field] >= .0001:
            raise ValueError('Runtime/source geometry difference exceeds 0.1 mm: '+field)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['descriptor', 'scene', 'layout_scene', 'ideal', 'out']:
        parser.add_argument('--'+name.replace('_', '-'), required=True, type=Path)
    parser.add_argument('--extracted', required=True, type=Path)
    parser.add_argument('--runtime-json', type=Path, help='Only compare a raw Rust surface dump with independently decoded main asphalt')
    parser.add_argument('--surface-types', default='0', help='Comma-separated recovered surface enums, e.g. 0,1,2,5')
    parser.add_argument('--timing-scene', type=Path)
    parser.add_argument('--controls', type=Path)
    parser.add_argument('--laps', type=Path, default=Path('xpeed-sim/fixtures/laps'))
    args = parser.parse_args()
    pool = v.message_pool(args.descriptor)
    scene = v.decode(pool, 'SceneData', args.scene)
    definitions = {s.surfaceId: s for a in scene.scene_actors if a.actor.WhichOneof('actorType') == 'surfaces' for s in a.actor.surfaces.SurfaceDefinitionData}
    types = {int(x) for x in args.surface_types.split(',')}
    if not types or not types <= {0, 1, 2, 3, 4, 5}:
        raise ValueError('Unknown surface enum')
    meshes, triangle_sets, surface_labels, missing = [], [], [], []
    for a in scene.scene_actors:
        if a.actor.WhichOneof('actorType') != 'static_mesh':
            continue
        m = a.actor.static_mesh
        # Asphalt is enum zero in the recovered proto3 schema: an omitted field is meaningful.
        definition = definitions.get(m.surface_id)
        if definition is None or definition.collisionCategory != 1 or definition.surface_type not in types:
            continue
        path = args.extracted.joinpath(*m.mesh_path.split('\\'))
        if not path.is_file():
            missing.append(m.mesh_path)
            continue  # Report scope as selected extracted meshes, never all road.
        if not a.enabled or not identity(a):
            raise ValueError('Nonidentity/disabled/parented asphalt actor requires separate transform proof')
        mesh = v.decode(pool, 'MeshData', path)
        if not mesh.lods:
            raise ValueError('Mesh has no LOD')
        vertices, indices = mesh_arrays(mesh.lods[0])
        triangles = vertices[indices]
        triangle_sets.append(triangles)
        surface_labels.extend([m.surface_id] * len(triangles))
        meshes.append({'path': m.mesh_path, 'sha256': v.digest(path), 'actor': a.name, 'surfaceId': m.surface_id,
                       'surfaceType': definition.surface_type, 'colliderType': m.collider.type, 'colliderMeshOverride': m.collider.meshOverride, 'physicsOnly': m.physics_only, 'actorIdentityTransform': True, 'meshType': mesh.type,
                       'vertices': len(vertices), 'triangles': len(indices), 'elevationM': [float(vertices[:, 1].min()), float(vertices[:, 1].max())],
                       'batches': [MessageToDict(b, preserving_proto_field_name=True) for b in mesh.lods[0].batches]})
    if not triangle_sets:
        raise ValueError('No scene-linked extracted asphalt meshes')
    triangles = np.concatenate(triangle_sets)
    labels = np.asarray(surface_labels)
    spatial = triangle_grid(triangles)
    source = v.decode(pool, 'AISplineData', args.ideal)
    points = np.array([[-p.point.x, p.point.y, p.point.z] for p in source.spline_data.points])
    forward = np.array([[-p.forwardVector.x, p.forwardVector.z] for p in source.payloads])
    if len(points) != len(forward) or not np.isfinite(points).all() or not np.isfinite(forward).all() or np.any(np.linalg.norm(forward, axis=1) == 0):
        raise ValueError('Invalid source point/forward correspondence')
    if args.runtime_json:
        report = compare_runtime(args.runtime_json, triangles, labels, points, forward)
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out/'runtime-independent-comparison.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
        return
    def evidence(p):
        y, at = surface_heights(p, triangles, return_indices=True, spatial=spatial)
        valid = np.isfinite(y)
        names, counts = np.unique(labels[at[valid]], return_counts=True)
        return {'nearestHeightSurfaceCounts': dict(zip(names.tolist(), map(int, counts))), 'uncontainedIndices': np.flatnonzero(~valid).tolist(), 'samples': len(p), 'insideSelectedSurfaces': int(valid.sum()), 'insideShare': float(valid.mean()),
                'heightErrorM': v.quantiles(np.abs(p[valid, 1]-y[valid])) if valid.any() else None}
    layout = v.decode(pool, 'SceneData', args.layout_scene)
    splines = []
    for a in layout.scene_actors:
        if a.actor.WhichOneof('actorType') == 'spline':
            p = np.array([[n.transform.position.x, n.transform.position.y, n.transform.position.z] for n in a.actor.spline.data.nodes])
            splines.append({'name': a.name, 'points': len(p), 'closed': a.actor.spline.data.is_closed,
                            'identityTransform': identity(a), 'elevationM': [float(p[:, 1].min()), float(p[:, 1].max())],
                            'polylineLength3dM': float(np.linalg.norm(np.roll(p, -1, axis=0)-p, axis=1).sum())})
    report = {'surfaceTypeSelection': sorted(types), 'steamBuild': '25170311', 'sceneSha256': v.digest(args.scene), 'layoutSceneSha256': v.digest(args.layout_scene),
              'descriptorSha256': v.digest(args.descriptor), 'idealSha256': v.digest(args.ideal), 'meshes': meshes,
              'surfaceDefinitions': [MessageToDict(s, preserving_proto_field_name=True) for s in definitions.values()],
              'missingSceneLinkedAsphaltMeshes': missing, 'triangleCount': len(triangles), 'ideal': evidence(points), 'layoutSplines': splines, 'laps': [],
              'limitations': ['Selected collision-surface enums only; unselected classes reduce containment',
                              'Scene surface/collision metadata establishes category; surface enum Asphalt also includes concrete/runoff',
                              'No white-line or timing origin certification; no live raw-reader acceptance',
                              'Historical lap X reflected in memory exactly once; source assets and fixtures unchanged',
                              'Local proprietary geometry; redistribution permission not established']}
    for path in sorted(args.laps.glob('acevo*.xlap.gz')):
        h, data = v.columns(path, b'XLAP'); c = data['lap']
        p = np.column_stack([-c['x'], c['y'], c['z']])
        report['laps'].append({'file': path.name, 'sha256': v.digest(path), 'valid': h['lap']['valid'], **evidence(p),
                               'reportedLengthM': h['track'].get('lengthM')})
    boundaries = cross_sections(points, forward, triangles, spatial=spatial)
    report['crossSections'] = {'count': len(boundaries), 'containingIdeal': sum(r is not None for r in boundaries), 'seamMergeToleranceM': .02}
    widths = np.array([np.linalg.norm(np.array(r[:2])-r[2:]) if r is not None else np.nan for r in boundaries])
    good = np.isfinite(widths)
    ai_widths = np.array([p.sides_0+p.sides_1 for p in source.payloads])
    report['crossSections']['selectedSurfaceWidthM'] = v.quantiles(widths[good])
    report['crossSections']['absoluteDifferenceVsAIEnvelopeWidthM'] = v.quantiles(np.abs(widths[good]-ai_widths[good]))
    high = int(np.argmax(points[:, 1]))
    report['elevationEvidence'] = {'highestIdealIndex': high, 'highestIdealPosition': points[high].tolist(),
                                   'asphaltHeightAtHighestIdealM': float(surface_heights(points[high:high+1], triangles)[0]),
                                   'allSelectedAsphaltElevationM': [float(triangles[:, :, 1].min()), float(triangles[:, :, 1].max())]}
    if args.controls:
        controls = v.decode(pool, 'TrackControlPoints', args.controls)
        cp = np.array([[-c.ideal_line_position.x, c.ideal_line_position.z] for c in controls.control_points])
        _, at = v.cKDTree(points[:, [0, 2]]).query(cp)
        differences = np.array([[abs(c.side_right-source.payloads[i].sides_1), abs(c.side_left-source.payloads[i].sides_0)] for c, i in zip(controls.control_points, at)])
        row, side = np.unravel_index(np.argmax(differences), differences.shape)
        c, i = controls.control_points[row], int(at[row])
        report['controlAnomaly'] = {'controlsSha256': v.digest(args.controls), 'controlIndex': int(row), 'idealIndex': i,
                                    'control': MessageToDict(c, preserving_proto_field_name=True),
                                    'aiSourceSides': [source.payloads[i].sides_0, source.payloads[i].sides_1],
                                    'meshCrossSectionWidthM': float(widths[i]) if good[i] else None,
                                    'sourceSideDifferenceM': float(differences[row, side])}

    if args.timing_scene:
        report['timingEvidence'] = timing_evidence(pool, args.timing_scene, source, points, args.laps)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out/'mesh-evidence.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    (args.out/('asphalt-cross-sections.json' if types == {0} else 'surface-cross-sections.json')).write_text(json.dumps({'provenance': report, 'columns': ['left_x','left_z','right_x','right_z'], 'rows': boundaries}, separators=(',', ':')), encoding='utf-8')
    summary = {k: report[k] for k in ['triangleCount','ideal','layoutSplines','laps','crossSections']}
    summary['ideal'] = {k: value for k, value in report['ideal'].items() if k != 'uncontainedIndices'}
    summary['laps'] = [{k: value for k, value in row.items() if k != 'uncontainedIndices'} for row in report['laps']]
    print(json.dumps(summary, indent=2))


class GeometryTests(unittest.TestCase):
    def test_timing_segment_crossing_preserves_source_fraction(self):
        line = np.array([[-1., 0., -1.], [1., 0., 1.], [1., 0., -1.]])
        across = np.array([[-2., 0., 0.], [2., 0., 0.]])
        self.assertEqual(segment_crossings(line, across), [(0, .5), (1, .5)])

    def test_grid_handles_negative_coordinates_and_boundary_lines(self):
        tri = np.array([[[-40., 0., -40.], [40., 0., -40.], [40., 0., 40.]],
                        [[-40., 0., -40.], [40., 0., 40.], [-40., 0., 40.]]])
        grid = triangle_grid(tri)
        for direction in [[0., 1.], [1., 0.], [1., 1.]]:
            np.testing.assert_array_equal(line_candidates(np.array([0., 0.]), np.array(direction), grid), [0, 1])
        np.testing.assert_allclose(surface_heights(np.array([[-20., 1., -20.], [20., 1., 20.]]), tri), [0., 0.])

    def test_triangle_contains_and_interpolates_height(self):
        tri = np.array([[[0., 1., 0.], [2., 3., 0.], [0., 1., 2.]]])
        result = surface_heights(np.array([[.5, 1.5, .5], [3., 0., 3.]]), tri)
        self.assertAlmostEqual(result[0], 1.5)
        self.assertTrue(np.isnan(result[1]))

    def test_cross_section_comes_from_triangle(self):
        tri = np.array([[[-2., 0., -1.], [2., 0., -1.], [0., 0., 1.]]])
        row = cross_sections(np.array([[0., 0., 0.]]), np.array([[0., 1.]]), tri)[0]
        np.testing.assert_allclose(row, [1., 0., -1., 0.])

    def test_rejects_bad_indices_and_nonfinite(self):
        from types import SimpleNamespace as S
        for positions, indices in [([0., 0., 0.], [0, 1, 0]), ([float('nan'), 0., 0.], [0, 0, 0]), ([0., 0.], [0, 0, 0])]:
            with self.assertRaises(ValueError):
                mesh_arrays(S(positions=positions, indices=indices, batches=[]))


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['--self-test']:
        unittest.main(argv=[sys.argv[0]])
    else:
        main()
