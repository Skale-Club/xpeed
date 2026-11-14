/* eslint-disable react-refresh/only-export-components */
import { Children, createContext, isValidElement, useContext, type ReactNode } from 'react';

// A stand-in for Recharts in the jsdom tests (it cannot measure a chart there): a chart is a figure that says how many points it has, and a Bar is one button per
// point, so a test can click a bar the way a person would. Used as `vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock)`.

const Rows = createContext<Array<Record<string, unknown>>>([]);

const chart = ({ data, children }: { data: Array<Record<string, unknown>>; children: ReactNode }) => (
  <figure data-testid="chart" data-points={data.length}>
    <Rows.Provider value={data}>{Children.toArray(children).filter((child) => !(isValidElement(child) && child.type === 'defs'))}</Rows.Provider>
  </figure>
);

function Bar({ onClick }: { onClick?: (row: Record<string, unknown>, index: number) => void }) {
  const rows = useContext(Rows);
  return (
    <div data-testid="bars">
      {rows.map((row, index) => (
        <button key={String(row.id ?? index)} type="button" data-testid="bar" data-lap={String(row.lap)} data-kind={String(row.kind)} data-pit={row.pit ? String(row.pit) : undefined} onClick={() => onClick?.(row, index)}>
          {`Lap ${String(row.lap)}`}
        </button>
      ))}
    </div>
  );
}

const nothing = () => null;

export const rechartsMock = {
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: chart,
  ComposedChart: chart,
  Bar,
  Cell: nothing,
  Line: nothing,
  XAxis: nothing,
  YAxis: nothing,
  CartesianGrid: nothing,
  Tooltip: nothing,
  ReferenceLine: nothing,
};
