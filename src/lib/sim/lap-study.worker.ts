import { handleStudyRequest, type StudyRequest } from '@/lib/sim/lap-study-core';

// The Web Worker of the lap analysis: a 500,000-sample lap is read here, off the page's thread. See lap-study-client.ts.
const scope = self as unknown as { onmessage: ((event: { data: StudyRequest }) => void) | null; postMessage(message: unknown): void };
scope.onmessage = (event) => scope.postMessage(handleStudyRequest(event.data));
