import { expect, it, vi } from 'vitest';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { useOpenProblems, useVehicleIssues, notifyProblemsChanged } from './use-open-problems';
import type { VehicleIssue } from '@/lib/db-issues';

const h=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('@/lib/db-issues',()=>({getIssuesForCar:h.read}));
it('shares the list and invalidates the bell, badge and Problems consumers together',async()=>{
  h.read.mockResolvedValue([]);
  const first=renderHook(()=>useOpenProblems('car'));
  const second=renderHook(()=>useOpenProblems('car'));
  const full=renderHook(()=>{const query=useVehicleIssues('car');return {data:query.data,isSuccess:query.isSuccess};});
  await waitFor(()=>expect(full.result.current.isSuccess).toBe(true));
  expect(h.read).toHaveBeenCalledTimes(1);
  h.read.mockResolvedValue([{id:'problem',status:'active'}] as VehicleIssue[]);
  act(()=>notifyProblemsChanged());
  await waitFor(()=>expect(first.result.current.problems).toHaveLength(1));
  expect(second.result.current.problems).toHaveLength(1);
  await waitFor(()=>expect(full.result.current.data).toHaveLength(1));
  expect(h.read).toHaveBeenCalledTimes(2);
  cleanup();
});
