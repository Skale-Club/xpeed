import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import handler from '../../api/fuel';

const h = vi.hoisted(() => ({ files: new Map<string,string>(), attempts: [] as string[] }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  auth:{getUser:async()=>({data:{user:{id:'00000000-0000-4000-8000-000000000001'}},error:null})},
  from:()=>{const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:{id:'00000000-0000-4000-8000-000000000002'},error:null})};return query;},
  storage:{from:()=>({
    upload:async(path:string,body:string)=>{h.attempts.push(path);if(h.files.has(path))return {error:{message:'Already exists'}};h.files.set(path,body);return {error:null};},
    download:async(path:string)=>({error:h.files.has(path)?null:{message:'Not found'},data:{text:async()=>h.files.get(path) || ''}}),
  })},
}) }));
beforeEach(()=>{h.files.clear();h.attempts=[];vi.stubEnv('VITE_SUPABASE_URL','https://example.supabase.co');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','test-placeholder');});
afterEach(()=>vi.unstubAllEnvs());
const entry={kind:'fill',at:'2026-10-01T12:00:00Z',litres:10,pricePerLitre:4,totalPaid:40,currency:'USD',odometerKm:null,fullTank:false,source:'receipt',region:'',sourceUrl:'',note:''};
const request=(over={},intent='00000000-0000-4000-8000-000000000003')=>new Request('https://example.test/api/fuel?carId=00000000-0000-4000-8000-000000000002',{method:'POST',headers:{Authorization:'Bearer test-placeholder','Idempotency-Key':intent},body:JSON.stringify({...entry,...over})});
it('a retry after a lost response returns the existing fill without doubling spending',async()=>{
  const first=await handler(request());
  const second=await handler(request());
  expect(first.status).toBe(201);expect(second.status).toBe(200);
  expect(await second.json()).toEqual(await first.json());
  expect(h.files.size).toBe(1);
});
it('concurrent retries have one immutable result and changed contents cannot replace it',async()=>{
  const results=await Promise.all([handler(request()),handler(request())]);
  expect(results.map(item=>item.status).sort()).toEqual([200,201]);
  expect((await handler(request({note:'Changed after save'}))).status).toBe(409);
  expect(h.files.size).toBe(1);
  expect((await handler(request({},'invalid'))).status).toBe(400);
});
