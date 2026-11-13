import { useEffect, useState } from 'react';
import type { SessionInsights } from '@/lib/sim/insights';
import type { LapFile } from '@/lib/sim/lap-file';
import { handleStudyRequest, slimLap, type LapStudy, type StudyRequest, type StudyResponse } from '@/lib/sim/lap-study-core';

/**
 * Runs the lap analysis off the render path. With a Web Worker it runs there (the page never waits on it); without one (tests, an old
 * browser, a blocked worker) it runs on the page after the screen has been painted, with the same functions and so the same answers.
 * The screens ask through `useLapStudy` and `useSessionStudy` and show a loading state until the answer comes.
 */

/** The part of a Worker the client uses (a test gives its own). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** What is asked: a request without the number the client gives it. */
type StudyAsk = { kind: 'compare'; study: LapFile; reference: LapFile } | { kind: 'session'; laps: LapFile[] };

export type WorkerFactory = () => WorkerLike | null;

const realWorker: WorkerFactory = () => {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./lap-study.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
  } catch {
    return null;
  }
};

/** Runs on the page, once the browser has had a chance to paint what it was asked to show first. */
const later = <T>(work: () => T): Promise<T> =>
  new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(work());
      } catch (error) {
        reject(error);
      }
    }, 0),
  );

export class StudyClient {
  private worker: WorkerLike | null | undefined;
  private next = 1;
  private waiting = new Map<number, { resolve: (value: StudyResponse) => void; reject: (error: Error) => void }>();

  constructor(private readonly factory: WorkerFactory = realWorker) {}

  /** True when a worker answers (false: the page computes). */
  get usesWorker(): boolean {
    return !!this.start();
  }

  private start(): WorkerLike | null {
    if (this.worker === undefined) {
      this.worker = this.factory();
      if (this.worker) {
        this.worker.onmessage = (event) => {
          const answer = event.data as StudyResponse;
          this.waiting.get(answer.id)?.resolve(answer);
          this.waiting.delete(answer.id);
        };
        this.worker.onerror = () => this.fallBack();
      }
    }
    return this.worker;
  }

  /** The worker broke (could not load, crashed): everything waiting is answered on the page, and the page does the work from now on. */
  private fallBack() {
    this.worker?.terminate();
    this.worker = null;
    for (const [, pending] of this.waiting) pending.reject(new Error('worker_failed'));
    this.waiting.clear();
  }

  private ask(request: StudyAsk): Promise<StudyResponse> {
    const worker = this.start();
    if (!worker) return later(() => handleStudyRequest({ ...request, id: 0 } as StudyRequest));
    const id = this.next++;
    return new Promise<StudyResponse>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ ...request, id });
    }).catch((error) => {
      if (error instanceof Error && error.message === 'worker_failed') return later(() => handleStudyRequest({ ...request, id: 0 } as StudyRequest));
      throw error;
    });
  }

  async compare(study: LapFile, reference: LapFile): Promise<LapStudy> {
    const answer = await this.ask({ kind: 'compare', study: slimLap(study), reference: slimLap(reference) });
    if (!answer.ok || answer.kind !== 'compare') throw new Error(answer.ok ? 'bad_answer' : answer.error);
    return answer.result;
  }

  async session(laps: LapFile[]): Promise<SessionInsights> {
    const answer = await this.ask({ kind: 'session', laps: laps.map(slimLap) });
    if (!answer.ok || answer.kind !== 'session') throw new Error(answer.ok ? 'bad_answer' : answer.error);
    return answer.result;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
  }
}

let shared: StudyClient | null = null;
let factoryOverride: WorkerFactory | null = null;

/** The client every screen shares (one worker). */
export function studyClient(): StudyClient {
  shared ??= new StudyClient(factoryOverride ?? realWorker);
  return shared;
}

/** Test hook: the next shared client uses this worker factory (or the real one with `null`). */
export function setStudyWorkerFactory(factory: WorkerFactory | null): void {
  factoryOverride = factory;
  shared?.dispose();
  shared = null;
}

export type Study<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error' };

/** The analysis of one lap against a reference; `loading` until it is computed. Nothing is computed with no reference. */
export function useLapStudy(study: LapFile | null, reference: LapFile | null): Study<LapStudy> {
  const [state, setState] = useState<{ study: LapFile | null; reference: LapFile | null; result: Study<LapStudy> } | null>(null);
  useEffect(() => {
    if (!study || !reference) return;
    let live = true;
    studyClient().compare(study, reference).then(
      (value) => live && setState({ study, reference, result: { status: 'ready', value } }),
      () => live && setState({ study, reference, result: { status: 'error' } }),
    );
    return () => {
      live = false;
    };
  }, [study, reference]);
  return state && state.study === study && state.reference === reference ? state.result : { status: 'loading' };
}
