import { act, fireEvent, screen, within } from '@testing-library/react';

/**
 * Helpers for the app's drop-down (Radix Select, see components/ui/option-select.tsx) in a test. A native `<select>` was driven with
 * `fireEvent.change`; this one is a button that opens a list, so a test opens it the way a keyboard does (jsdom has no real pointer) and clicks the entry.
 * The jsdom pieces Radix needs are in src/test/setup.ts.
 */

/** Opens the drop-down behind `trigger` and returns its list. */
export function openSelect(trigger: HTMLElement): HTMLElement {
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('listbox');
}

/** The entries of the drop-down behind `trigger`, in order, as written. It leaves the list closed. */
export function selectOptions(trigger: HTMLElement): string[] {
  const list = openSelect(trigger);
  const labels = within(list).getAllByRole('option').map((option) => option.textContent ?? '');
  fireEvent.keyDown(list, { key: 'Escape' });
  return labels;
}

/** Opens the drop-down behind `trigger` and picks the entry with this accessible name (a string is an exact match). */
export function chooseOption(trigger: HTMLElement, optionName: string | RegExp): void {
  const list = openSelect(trigger);
  fireEvent.click(within(list).getByRole('option', { name: optionName }));
}

/**
 * Waits until the entries of a drop-down (it may still be loading them) satisfy `accept`, and returns them. Do not write this as
 * `waitFor(() => selectOptions(...))`: opening the list changes the page, `waitFor` runs again on every change, and the loop never lets the data arrive.
 * This one looks every 30 ms instead.
 */
export async function waitForOptions(getTrigger: () => HTMLElement, accept: (labels: string[]) => boolean, timeoutMs = 4000): Promise<string[]> {
  const end = Date.now() + timeoutMs;
  let last: string[] = [];
  for (;;) {
    try {
      last = selectOptions(getTrigger());
      if (accept(last)) return last;
    } catch {
      // the control is not there yet, or not open-able yet (disabled while it loads)
    }
    if (Date.now() > end) throw new Error(`The entries of the drop-down never matched; the last ones seen: ${JSON.stringify(last)}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}
