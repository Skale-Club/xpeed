import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import handler from '../../api/sync-problems';

const h=vi.hoisted(()=>({pending:true,fail:true,issue:false,occurrences:0,scope:''}));
vi.mock('@supabase/supabase-js',()=>({createClient:(_url:unknown,_key:unknown,options:{global:{headers:{Authorization:string}}})=>{
  h.scope=options.global.headers.Authorization;
  return {auth:{getUser:async()=>({data:{user:{id:'user'}},error:null})},from:(table:string)=>{
    let mode='select';
    const q={select:()=>q,eq:()=>q,in:()=>q,lte:()=>q,order:()=>q,limit:()=>q,maybeSingle:()=>q,single:()=>q,
      insert:()=>{mode='insert';return q;},update:()=>q,upsert:()=>{mode='upsert';return q;},delete:()=>{mode='delete';return q;},
      then:(resolve:(v:unknown)=>unknown)=>Promise.resolve().then(()=>{
        if(table==='session_issue_jobs') {
          if(mode==='delete'){h.pending=false;return {data:[{session_id:'trip'}],error:null};}
          return {data:h.pending?[{session_id:'trip',user_id:'user',car_profile_id:'car',version:'v1',reprocessing:false}]:[],error:null};
        }
        if(table==='sessions')return {data:{session_start:'2026-10-01T12:00:00Z',summary:null,active_dtcs:[]},error:null};
        if(table==='session_flags')return {data:[{canonical_key:'coolant_temp',severity:'critical',message:'Hot'}],error:null};
        if(table==='vehicle_issues'){
          if(mode==='insert'){h.issue=true;return {data:{id:'issue'},error:null};}
          return {data:h.issue?{id:'issue',status:'active',severity:'critical',last_seen_at:'2026-10-01T12:00:00Z'}:null,error:null};
        }
        if(table==='vehicle_issue_occurrences') {
          if(h.fail)return {data:null,error:{message:'offline'}};
          h.occurrences++;return {data:null,error:null};
        }
        return {data:null,error:null};
      }).then(resolve),
    };return q;
  }};
}}));
beforeEach(()=>{h.pending=true;h.fail=true;h.issue=false;h.occurrences=0;vi.stubEnv('VITE_SUPABASE_URL','https://example.supabase.co');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','placeholder');});
afterEach(()=>vi.unstubAllEnvs());
const request=()=>new Request('https://example.test/api/sync-problems',{method:'POST',headers:{Authorization:'Bearer owner-token'},body:'{}'});
it('keeps failed derivative work durable and repairs it on a retry using the caller’s scope',async()=>{
  expect(await (await handler(request())).json()).toEqual({synced:0,pending:1});
  expect(h.pending).toBe(true);expect(h.issue).toBe(true);
  h.fail=false;
  expect(await (await handler(request())).json()).toEqual({synced:1,pending:0});
  expect(h.pending).toBe(false);expect(h.occurrences).toBe(1);
  expect(h.scope).toBe('Bearer owner-token');
  expect(await (await handler(request())).json()).toEqual({synced:0,pending:0});
});
