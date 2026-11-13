import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import LegacySimRedirect from './LegacySimRedirect';

const Where = () => {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{pathname + search + hash}</p>;
};

const open = (from: string) =>
  render(
    <MemoryRouter initialEntries={[from]}>
      <Routes>
        <Route path="/sim" element={<LegacySimRedirect />} />
        <Route path="/sim/*" element={<LegacySimRedirect />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

describe('old /sim addresses', () => {
  afterEach(cleanup);
  it.each([
    ['/sim/connect/req-1', '/companion/connect/req-1'],
    ['/sim/connect/req-1?code=7&x=y', '/companion/connect/req-1?code=7&x=y'],
    ['/sim/app', '/virtual/companion'],
    ['/sim/app?tab=1', '/virtual/companion?tab=1'],
    ['/sim/sessions', '/virtual/sessions'],
    ['/sim/compare?a=l1&b=l2', '/virtual/compare?a=l1&b=l2'],
    ['/sim/tracks', '/virtual/tracks'],
    ['/sim/cars', '/virtual/cars'],
    ['/sim', '/virtual'],
    ['/sim?x=1', '/virtual?x=1'],
  ])('%s redirects to %s', (from, to) => {
    open(from);
    expect(screen.getByTestId('where').textContent).toBe(to);
  });
});
