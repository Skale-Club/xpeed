import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { circle, gzipBytes, makeLayout, packLayout } from '@/test/track-fixture';
import { TrackReadError } from './read-track-file';
import { addTrackFile, findTrack, listTracks, removeTracks, subscribeTrackLibrary, summarizeTrack } from './track-library';
import { trackKey, unpackTrack } from './track-file';

let idb: FakeIdb;
beforeEach(() => {
  idb = installFakeIndexedDb();
});
afterEach(() => idb.uninstall());

const layout = (over: Partial<Parameters<typeof makeLayout>[0]> = {}) =>
  makeLayout({ points: circle(80, 50), width: 7, closed: true, ideal: true, name: 'Monza', variant: 'GP', ...over });
const rawFile = (over?: Parameters<typeof layout>[0], name = 'monza.xtrk') => new File([packLayout(layout(over))], name);
const gzFile = async (over?: Parameters<typeof layout>[0], name = 'monza.xtrk.gz') => new File([await gzipBytes(packLayout(layout(over)))], name);

describe('the fixture writer', () => {
  it('writes what the strict reader accepts, and reads back the same layout', () => {
    const original = layout({ pit: [[0, 90], [40, 90]] });
    const back = unpackTrack(packLayout(original));
    expect(back.header).toEqual(original.header);
    expect([...back.centerline.x]).toEqual([...original.centerline.x]);
    expect([...back.centerline.left]).toEqual([...original.centerline.left]);
    expect([...back.pitlane!.z]).toEqual([...original.pitlane!.z]);
  });
});

describe('keeping a track layout', () => {
  it('keeps a gzipped or an unpacked file and gives the layout back, found by the name a lap uses', async () => {
    const { id, replaced } = await addTrackFile('ana', await gzFile());
    expect(replaced).toBe(false);
    expect(id).toBe('ana|ac|monza|gp');
    const found = await findTrack('ana', 'AC', 'monza', 'GP');
    expect(found && trackKey(found)).toBe('ac|monza|gp');
    expect(found!.centerline.x).toHaveLength(50);

    await addTrackFile('ana', rawFile({ name: 'Spa', variant: undefined }, 'spa.xtrk'));
    expect(await findTrack('ana', 'ac', 'Spa')).not.toBeNull();
  });

  it('lists what each one says about itself, without opening the points', async () => {
    await addTrackFile('ana', await gzFile());
    const [entry] = await listTracks('ana');
    expect(entry).toMatchObject({ id: 'ana|ac|monza|gp', fileName: 'monza.xtrk.gz', summary: summarizeTrack(layout()) });
    expect(entry.summary).toMatchObject({ trackName: 'Monza', variant: 'GP', hasIdealLine: true, hasPitLane: false, hasEdges: true });
  });

  it('replaces the layout of the same track, so the newest file is the one used', async () => {
    await addTrackFile('ana', await gzFile({ width: 7 }));
    const second = await addTrackFile('ana', await gzFile({ width: 11 }));
    expect(second.replaced).toBe(true);
    expect(await listTracks('ana')).toHaveLength(1);
    expect((await findTrack('ana', 'ac', 'Monza', 'GP'))!.centerline.left[0]).toBe(11);
  });

  it('keeps layouts apart by account', async () => {
    await addTrackFile('ana', await gzFile());
    expect(await findTrack('bia', 'ac', 'Monza', 'GP')).toBeNull();
    expect(await listTracks('bia')).toEqual([]);
    await removeTracks('bia', ['ana|ac|monza|gp']);
    expect(await listTracks('ana')).toHaveLength(1);
  });

  it('forgets one, and says when the list changes', async () => {
    const listener = vi.fn();
    const stop = subscribeTrackLibrary(listener);
    const { id } = await addTrackFile('ana', await gzFile());
    await removeTracks('ana', [id]);
    expect(await listTracks('ana')).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it('refuses a file that is not a track layout, and keeps nothing', async () => {
    const error = await addTrackFile('ana', new File([new Uint8Array(200)], 'x.xtrk')).catch((e) => e);
    expect(error).toBeInstanceOf(TrackReadError);
    expect(error.reason).toBe('not_a_track');
    expect(await listTracks('ana')).toEqual([]);
  });

  it('finds nothing when no layout was kept for the track', async () => {
    expect(await findTrack('ana', 'ac', 'Nowhere')).toBeNull();
  });
});
