// Real Companion/device endpoints with simulated identity, DB and shared AI boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require=createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT??'.','package.json'))),{build}=require('esbuild');
const id=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner=id(1),device=id(2),session=id(3),conversation=id(4),nonce=id(5),other=id(6);
test('Companion admission is device-scoped, optional and cannot duplicate paid dispatch',async(t)=>{
 const state={};globalThis.__companionCoach=state;const oldEnv=process.env.NODE_ENV;process.env.NODE_ENV='production';
 const reset=()=>Object.assign(state,{device:true,permission:true,google:owner,reads:[],updates:[],questions:new Map(),bodyReads:0,aiCalls:0,rate:0,
  providerStatus:200,providerReply:'Compare two clean laps.',failure:null,forcedStatus:null,history:{conversationId:conversation,messages:[]}});
 state.db={rpc:async(name,args)=>{
  state.reads.push({name,args});if(state.failure===name)return{data:null,error:{message:'simulated storage failure'}};
  let data;
  if(name==='sim_authenticate_device')data=state.device?{user_id:owner,device_id:device}:null;
  else if(name==='sim_companion_coach_allowed')data=state.permission;
  else if(name==='sim_rate_hit')data=state.rate;
  else if(name==='sim_companion_coach_sessions')data=[{id:session,game:'ac',track:'Monza',car:'GT3',kind:'practice',startedAt:'2026-11-18T12:00:00Z'}];
  else if(name==='sim_companion_coach_history')data=state.history;
  else if(name==='sim_companion_coach_begin'){
   const stored=state.questions.get(args.p_message_id);
   if(state.forcedStatus)data={status:state.forcedStatus};
   else if(stored)data={status:stored.reply?'replied':stored.failed?'failed':'pending',conversationId:conversation,reply:stored.reply};
   else{state.questions.set(args.p_message_id,{message:args.p_message});data={status:'created',conversationId:conversation};}
  }else if(name==='sim_companion_coach_finish'){
   const stored=state.questions.get(args.p_message_id);if(stored){stored.reply=args.p_reply;stored.failed=args.p_reply===null;}data=true;
  }return{data,error:null};
 },from:table=>{
  const filters=[];let values;
  const q={update:v=>{values=v;return q},eq:(column,value)=>{filters.push([column,value]);return q},is:()=>q,
   select:async()=>{state.updates.push({table,values,filters});return{data:filters.some(([k,v])=>k==='user_id'&&v===owner)?[{id:device}]:[],error:null}}};return q;
 }};
 const built=await build({stdin:{contents:"export {default as coach} from './api/sim/coach.ts';export {default as devices} from './api/sim/devices.ts';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent',plugins:[{name:'companion-boundaries',setup(b){
  b.onResolve({filter:/^zod$/},()=>({path:require.resolve('zod')}));
  b.onResolve({filter:/^\.\.\/_backend$/},()=>({path:'backend',namespace:'stub'}));
  b.onResolve({filter:/chat-handler\.ts$/},()=>({path:'chat',namespace:'stub'}));
  b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:a.path==='backend'?
   'export const openBackend=()=>({service:globalThis.__companionCoach.db,userId:async token=>token==="google-owner"?globalThis.__companionCoach.google:null});':
   `export const createChatHandler=authenticate=>async req=>{const s=globalThis.__companionCoach;s.aiCalls++;s.chat={actor:await authenticate(req.headers.get('Authorization')),body:await req.json()};return new Response(JSON.stringify(s.providerStatus===200?{reply:s.providerReply}:{code:'personal_credits_exhausted'}),{status:s.providerStatus})};`,loader:'js'}));
 }}]});
 try{
  const api=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  const call=(body,options={})=>{
   const req=new Request('https://xpeed.test/api/sim/coach'+(options.query??''),{method:body===undefined?'GET':'POST',headers:options.noToken?{}:{Authorization:'Bearer dummy-device-token'},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
   const original=req.text.bind(req);req.text=()=>{state.bodyReads++;return original()};return api.coach(req);
  };
  const body=()=>({sessionId:session,idempotencyKey:nonce,message:'What should I practise?',language:'pt-BR'});
  await t.test('invalid or disabled devices stop before body/private history/provider reads',async()=>{
   reset();assert.equal((await call(body(),{noToken:true})).status,401);state.device=false;assert.equal((await call(body())).status,401);
   state.device=true;state.permission=false;assert.equal((await call(body())).status,403);assert.equal(state.bodyReads,0);assert.equal(state.aiCalls,0);
   assert(!state.reads.some(r=>r.name==='sim_companion_coach_begin'));
  });
  await t.test('development refuses paid sends before question admission',async()=>{
   reset();process.env.NODE_ENV='development';assert.equal((await call(body())).status,503);assert.equal(state.questions.size,0);assert.equal(state.aiCalls,0);process.env.NODE_ENV='production';
  });
  await t.test('session discovery and history share only verified owner/device context without AI',async()=>{
   reset();assert.equal((await call()).status,200);assert.equal((await call(undefined,{query:'?sessionId='+session})).status,200);
   const queries=state.reads.filter(r=>r.name.startsWith('sim_companion_coach_'));assert(queries.every(r=>r.args.p_user===owner&&r.args.p_device===device));
   assert.equal(state.aiCalls,0);assert.equal(state.bodyReads,0);assert.equal((await call(undefined,{query:'?sessionId=bad'})).status,400);
   state.history=null;assert.equal((await call(undefined,{query:'?sessionId='+session})).status,404);
  });
  await t.test('the server pins owner/session/question and uses the same persisted chat boundary',async()=>{
   reset();const response=await call(body());assert.equal(response.status,200);assert.deepEqual(await response.json(),{conversationId:conversation,reply:state.providerReply});
   assert.equal(state.aiCalls,1);assert.equal(state.chat.actor,owner);assert.deepEqual(state.chat.body,{mode:'virtual',accountId:owner,
    sessionId:session,conversationId:conversation,messageId:nonce,message:body().message,language:'pt-BR'});
   assert(!JSON.stringify(state.chat).includes('dummy-device-token'));
   assert(state.reads.some(r=>r.name==='sim_authenticate_device'&&r.args.p_token_hash.length===64));
  });
  await t.test('retrying a completed UUID returns the cached reply without a second AI call',async()=>{
   const response=await call(body());assert.equal(response.status,200);assert.equal(state.aiCalls,1);assert.equal((await response.json()).reply,state.providerReply);
  });
  await t.test('pending/failed admissions never dispatch again or invent a fallback',async()=>{
   for(const status of['pending','busy','failed']){reset();state.forcedStatus=status;assert.equal((await call(body())).status,409);assert.equal(state.aiCalls,0);}
   for(const [status,expected] of[['disabled',403],['not_found',404],['invalid',400]]){reset();state.forcedStatus=status;assert.equal((await call(body())).status,expected);assert.equal(state.aiCalls,0);}
  });
  await t.test('quota or provider failures mark the persisted request failed and hide billing internals',async()=>{
   for(const status of[429,402,503]){reset();state.providerStatus=status;const response=await call(body());assert.equal(response.status,status===429?429:503);
    assert(!JSON.stringify(await response.json()).includes('personal'));assert.equal(state.questions.get(nonce).failed,true);
    assert.equal((await call(body())).status,409);assert.equal(state.aiCalls,1);}
  });
  await t.test('malformed/context-inflating input and unavailable rate storage spend nothing',async()=>{
   for(const input of['{',JSON.stringify({...body(),history:['forged']}),JSON.stringify({...body(),message:'x'.repeat(2001)}),'x'.repeat(17000)]){
    reset();assert.equal((await call(input)).status,400);assert.equal(state.aiCalls,0);assert.equal(state.questions.size,0);
   }
   for(const rate of[30,null,-1,NaN]){reset();state.rate=rate;assert.equal((await call(body())).status,rate===30?429:503);assert.equal(state.aiCalls,0);}
  });
  await t.test('permission toggles require Google owner identity and cannot be self-enabled by the device',async()=>{
   const change=(token,accountId,enabled=true)=>api.devices(new Request('https://xpeed.test/api/sim/devices?id='+device,{method:'PATCH',headers:{Authorization:'Bearer '+token},body:JSON.stringify({accountId,enabled})}));
   reset();assert.equal((await change('dummy-device-token',owner)).status,401);assert.equal(state.updates.length,0);
   assert.equal((await change('google-owner',other)).status,401);assert.equal(state.updates.length,0);
   assert.equal((await change('google-owner',owner)).status,200);assert.deepEqual(state.updates[0].values,{companion_coach_enabled:true});
   assert(state.updates[0].filters.some(([k,v])=>k==='user_id'&&v===owner));
   state.google=other;assert.equal((await change('google-owner',other)).status,404);
  });
 }finally{if(oldEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldEnv;delete globalThis.__companionCoach;}
});

test('browser device permission transport is account-bound, cancellable and never manages provider keys',async(t)=>{
 const state={user:{id:owner},demo:false,calls:[],enabled:true};globalThis.__coachPermission=state;
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{state.calls.push({url,options});return new Response(JSON.stringify({enabled:state.enabled}),{status:200})};
 const built=await build({entryPoints:['src/lib/sim/companion-coach.ts'],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent',plugins:[{name:'permission-client-boundary',setup(b){
  const modules={
   '@/lib/auth/session':'export const getCurrentUser=async()=>{const s=globalThis.__coachPermission;if(s.authHook)return s.authHook();return{data:{user:s.users?.length?s.users.shift():s.user}}};',
   '@/lib/auth/google':'export const getAccessToken=async()=>"simulated-google-token";',
   '@/lib/trips':'export const publicAppUrl=()=>"https://xpeed.test";',
   './demo/mode':'export const isDemoMode=()=>globalThis.__coachPermission.demo;',
  };
  b.onResolve({filter:/^(@\/|\.\/demo\/mode$)/},a=>a.path in modules?{path:a.path,namespace:'stub'}:undefined);
  b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:modules[a.path],loader:'js'}));
 }}]});
 try{
  const api=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  await t.test('only the desired boolean and displayed actor are sent',async()=>{
   assert.equal(await api.setCompanionCoachPermission(owner,device,true),true);
   const call=state.calls.at(-1);assert.equal(call.options.method,'PATCH');assert.deepEqual(JSON.parse(call.options.body),{accountId:owner,enabled:true});
   assert(!call.options.body.includes('apiKey'));assert(call.url.endsWith('/api/sim/devices?id='+device));
  });
  await t.test('signed-out, stale, demo and prior cancellation stop before the network',async()=>{
   const count=state.calls.length;state.user=null;await assert.rejects(api.setCompanionCoachPermission(owner,device,true));
   state.user={id:other};await assert.rejects(api.setCompanionCoachPermission(owner,device,true));state.user={id:owner};
   state.demo=true;await assert.rejects(api.setCompanionCoachPermission(owner,device,true));state.demo=false;
   const abort=new AbortController();abort.abort();await assert.rejects(api.setCompanionCoachPermission(owner,device,true,abort.signal));assert.equal(state.calls.length,count);
  });
  await t.test('account changes and mismatched responses are discarded with safe errors',async()=>{
   state.users=[{id:owner},{id:owner},{id:other}];await assert.rejects(api.setCompanionCoachPermission(owner,device,true),e=>e.message==='companion_permission_unavailable');
   state.enabled=false;await assert.rejects(api.setCompanionCoachPermission(owner,device,true));
  });
  await t.test('cancellation releases the view even if identity resolution never answers',async()=>{
   let started; const ready=new Promise(resolve=>{started=resolve});
   state.authHook=()=>{started();return new Promise(()=>{})};
   const controller=new AbortController(),pending=api.setCompanionCoachPermission(owner,device,true,controller.signal);
   await ready;controller.abort();await assert.rejects(pending,e=>e.message==='companion_permission_unavailable');state.authHook=null;
  });
 }finally{globalThis.fetch=oldFetch;delete globalThis.__coachPermission;}
});
