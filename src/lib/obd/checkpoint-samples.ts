import type { ScannerSample } from './session-csv';

/** Read independent cloud chunks with bounded concurrency, then verify their order. */
export async function readCheckpointSamples(
  names: string[],
  read: (name: string) => Promise<{ offset: number; samples: ScannerSample[] }>,
  cutoff = Infinity,
  total?: number,
): Promise<ScannerSample[]> {
  const ordered = names.filter(name => /^\d{9}\.json$/.test(name)).sort();
  const samples: ScannerSample[] = [];
  for (let start = 0; start < ordered.length; start += 8) {
    const chunks = await Promise.all(ordered.slice(start, start + 8).map(read));
    for (const chunk of chunks) {
      if (chunk.offset !== samples.length) throw Error('Checkpoint gap; waiting for remaining samples');
      samples.push(...chunk.samples);
    }
  }
  const kept = samples.filter(sample => sample.t <= cutoff + .001);
  if (total !== undefined && kept.length !== total) throw Error('Checkpoint gap; waiting for remaining samples');
  return kept;
}
