// A small Server-Sent Events parser, as a pure function: `fetch` gives the page the bytes of `/api/sim/live/stream` (EventSource cannot send the
// Authorization header), so the page reads the lines itself. Follows the WHATWG rules the stream needs: `\n`, `\r\n` and `\r` line ends, comment
// lines (`: ping`), `event`, `data` (several lines join with `\n`), `retry`, `id`, and an event only ends at a blank line.

export interface SseEvent {
  event: string;
  data: string;
}

export interface SseState {
  /** The part of the last chunk that is not a whole line yet. */
  buffer: string;
  event: string;
  data: string[];
}

export const emptySse = (): SseState => ({ buffer: '', event: '', data: [] });

export interface SseResult {
  state: SseState;
  events: SseEvent[];
  /** The last `retry:` (ms) the chunk carried, if any. */
  retry?: number;
}

/** Feeds a chunk of text; returns the new state and the events it completed. The state passed in is not changed. */
export function feedSse(previous: SseState, chunk: string): SseResult {
  const text = previous.buffer + chunk;
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\n') {
      lines.push(text.slice(start, i));
      start = i + 1;
    } else if (c === '\r') {
      // A `\r` at the very end may be the first half of `\r\n`: wait for the next chunk.
      if (i === text.length - 1) break;
      lines.push(text.slice(start, i));
      if (text[i + 1] === '\n') i += 1;
      start = i + 1;
    }
  }

  let { event, data } = previous;
  data = [...data];
  const events: SseEvent[] = [];
  let retry: number | undefined;
  for (const line of lines) {
    if (line === '') {
      if (data.length > 0) events.push({ event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }
  return { state: { buffer: text.slice(start), event, data }, events, retry };
}
