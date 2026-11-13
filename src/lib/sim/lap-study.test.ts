import { describe, expect, it } from 'vitest';
import { StudyClient, type WorkerLike } from '@/lib/sim/lap-study-client';
import { compareStudy, handleStudyRequest, slimLap, type StudyRequest } from '@/lib/sim/lap-study-core';
import { sessionInsights } from '@/lib/sim/insights';
import { buildSyntheticLap, exampleCorners, type SynthCorner } from '@/lib/sim/synthetic-lap';

const lapWith = (patch: (corners: SynthCorner[]) => SynthCorner[] = (c) => c, hz = 20) => buildSyntheticLap({ lengthM: 4200, corners: patch(exampleCorners()), hz }).lap;
const reference = lapWith();
const study = lapWith((corners) => corners.map((c, i) => (i === 1 ? { ...c, brakeDist: c.brakeDist - 15 } : i === 5 ? { ...c, minSpeedKmh: c.minSpeedKmh - 8 } : c)));

/**
 * A Web Worker without a browser: messages cross by structured clone both ways, as they do for a real worker, and are answered by
 * the very function the worker file runs (`handleStudyRequest`). Whatever is not cloneable would fail here.
 */
class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  received: StudyRequest[] = [];
  postMessage(message: unknown) {
    const request = structuredClone(message) as StudyRequest;
    this.received.push(request);
    queueMicrotask(() => this.onmessage?.({ data: structuredClone(handleStudyRequest(request)) }));
  }
  terminate() {
    this.terminated = true;
  }
}

describe('the analysis off the page', () => {
  it('a worker gives exactly what the page computes itself', async () => {
    const worker = new FakeWorker();
    const viaWorker = await new StudyClient(() => worker).compare(study, reference);
    const direct = compareStudy(study, reference);
    expect(viaWorker).toEqual(direct);
    expect(viaWorker.comparison.comparable).toBe(true);
    expect(viaWorker.comparison.corners.length).toBeGreaterThan(3);
    expect(viaWorker.insights.length).toBeGreaterThan(0);
    expect(worker.received).toHaveLength(1);
  });

  it('without a worker the page computes it, with the same result', async () => {
    const client = new StudyClient(() => null);
    expect(client.usesWorker).toBe(false);
    expect(await client.compare(study, reference)).toEqual(await new StudyClient(() => new FakeWorker()).compare(study, reference));
  });

  it('only the channels the analysis reads are sent to the worker', async () => {
    const worker = new FakeWorker();
    const heavy = { ...study, data: { ...study.data, rpm: new Float32Array(study.data.t.length), fuel: new Float32Array(study.data.t.length) } };
    await new StudyClient(() => worker).compare(heavy, reference);
    const sent = worker.received[0];
    expect(sent.kind === 'compare' && Object.keys(sent.study.data).sort()).toEqual(Object.keys(slimLap(study).data).sort());
    expect(sent.kind === 'compare' && 'rpm' in sent.study.data).toBe(false);
  });

  it('a set of laps is the same through a worker and on the page', async () => {
    const laps = [0, 6, -5, 3, 8, -2].map((shift) => lapWith((corners) => corners.map((c, k) => (k === 1 ? { ...c, brakeDist: c.brakeDist + shift } : c)), 10));
    const viaWorker = await new StudyClient(() => new FakeWorker()).session(laps);
    const onPage = await new StudyClient(() => null).session(laps);
    expect(viaWorker).toEqual(onPage);
    expect(viaWorker).toEqual(JSON.parse(JSON.stringify(sessionInsights(laps.map(slimLap)))));
    expect(viaWorker.mostVariableCorner).not.toBeNull();
  });

  it('answers many questions at once, each with its own answer', async () => {
    const client = new StudyClient(() => new FakeWorker());
    const [first, second] = await Promise.all([client.compare(study, reference), client.compare(reference, study)]);
    expect(first.comparison.lapDelta).toBeGreaterThan(0);
    expect(second.comparison.lapDelta).toBeLessThan(0);
  });

  it('falls back to the page when the worker breaks', async () => {
    const broken = new FakeWorker();
    broken.postMessage = () => queueMicrotask(() => broken.onerror?.({}));
    const client = new StudyClient(() => broken);
    expect(await client.compare(study, reference)).toEqual(compareStudy(study, reference));
    expect(broken.terminated).toBe(true);
    // And the next question goes straight to the page.
    expect(await client.compare(study, reference)).toEqual(compareStudy(study, reference));
  });

  it('a request that fails is an answer, not a crash', () => {
    const answer = handleStudyRequest({ id: 7, kind: 'compare', study: { ...study, data: {} }, reference });
    expect(answer.id).toBe(7);
    // No channels: the library says the laps cannot be compared; it does not throw.
    expect(answer.ok ? answer.kind === 'compare' && answer.result.comparison.comparable : false).toBe(false);
    const broken = handleStudyRequest({ id: 8, kind: 'session', laps: [null as never] });
    expect(broken).toMatchObject({ id: 8, ok: false });
  });
});
