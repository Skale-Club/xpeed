import { expect, it, vi } from 'vitest';
import { readCheckpointSamples } from './checkpoint-samples';

it('restores a long trip in ordered batches instead of a serial network waterfall', async () => {
  const names = Array.from({ length: 96 }, (_, i) => `${String(i).padStart(9, '0')}.json`).reverse();
  let active = 0, peak = 0;
  const read = vi.fn(async (name: string) => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    const offset = parseInt(name);
    return { offset, samples: [{ t: offset, values: { speed: 30 } }] };
  });
  const samples = await readCheckpointSamples([...names, 'meta.json'], read);
  expect(samples.map(sample => sample.t)).toEqual(Array.from({ length: 96 }, (_, i) => i));
  expect(peak).toBe(8);
  expect(read).toHaveBeenCalledTimes(96);
});

it('rejects missing chunks and incomplete final recordings', async () => {
  await expect(readCheckpointSamples(['000000001.json'], async () => ({ offset: 1, samples: [{ t: 1, values: {} }] }))).rejects.toThrow('Checkpoint gap');
  await expect(readCheckpointSamples(['000000000.json'], async () => ({ offset: 0, samples: [{ t: 0, values: {} }] }), 90, 2)).rejects.toThrow('Checkpoint gap');
});

it('keeps the final cutoff when parked samples were backed up before the trip ended', async () => {
  const samples = await readCheckpointSamples(['000000000.json'], async () => ({ offset: 0, samples: [0, 60, 90, 120].map(t => ({ t, values: {} })) }), 90, 3);
  expect(samples.map(sample => sample.t)).toEqual([0, 60, 90]);
});
