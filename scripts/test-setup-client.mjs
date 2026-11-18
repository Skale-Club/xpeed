// Setup snapshot/client contracts at a simulated RPC boundary. No network or AI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require=createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT??'.','package.json')));
const {build}=require('esbuild');
test('private setup client requires explicit actions and preserves version/parameter semantics',async(t)=>{
  const state={user:{id:'driver'},calls:[],demo:false,error:null};globalThis.__setupClient=state;
  const parameters=[{name:'Front pressure',value:'27.5',unit:'psi'},{name:'Brake bias',value:'54',unit:'%'}];
  const version={id:'version-a',label:'Baseline',notes:'',parameters,parentId:null,createdAt:'2026-11-18T12:00:00Z',runs:[]};
  state.library={versions:[version],selectedVersionId:null,limit:20};
  state.rpc=async(name,args)=>{state.calls.push({name,args});return{data:name==='sim_setup_versions'?state.library:name==='sim_setup_create'?'version-b':true,error:state.error}};
  const built=await build({stdin:{contents:"export * from './src/lib/sim/setup-client.ts';export * from './src/lib/sim/setup-types.ts';",resolveDir:process.cwd(),loader:'ts'},
    bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent',plugins:[{name:'setup-boundary',setup(b){
      b.onResolve({filter:/^@\/integrations\/supabase\/client$/},()=>({path:'db',namespace:'stub'}));
      b.onResolve({filter:/^@\/lib\/auth\/session$/},()=>({path:'auth',namespace:'stub'}));
      b.onResolve({filter:/^\.\/demo\/mode$/},()=>({path:'demo',namespace:'stub'}));
      b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:{db:'export const supabase={rpc:(name,args)=>globalThis.__setupClient.rpc(name,args)};',
        auth:'export const getCurrentUser=async()=>{const s=globalThis.__setupClient;return{data:{user:s.users?.length?s.users.shift():s.user}}};',
        demo:'export const DEMO_USER_ID="demo";export const isDemoMode=()=>globalThis.__setupClient.demo;'}[a.path],loader:'js'}));
    }}]});
  try{
    const api=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
    await t.test('normalizes bounded string parameters and rejects duplicates/control data',()=>{
      const draft={label:' Base ',notes:' Notes ',parameters:[{name:' Front pressure ',value:' 27.5 ',unit:' psi '}],parentId:null};
      assert.deepEqual(api.normalizeSetupDraft(draft),{label:'Base',notes:'Notes',parameters:[parameters[0]],parentId:null});
      for(const bad of[[],[parameters[0],{...parameters[0],name:'front pressure'}],[{...parameters[0],value:'x\ninjected'}],Array.from({length:33},(_,i)=>({...parameters[0],name:'P'+i}))])
        assert.equal(api.normalizeSetupDraft({...draft,parameters:bad}),null);
    });
    await t.test('diffs preserve units and distinguish changes, removals and additions',()=>{
      const previous=JSON.stringify(parameters);
      assert.deepEqual(api.compareSetupParameters(parameters,[{name:'front pressure',value:'190',unit:'kPa'},{name:'Wing',value:'3',unit:'clicks'}]),[
        {name:'front pressure',before:'27.5 psi',after:'190 kPa'},{name:'Brake bias',before:'54 %',after:null},{name:'Wing',before:null,after:'3 clicks'}]);
      assert.equal(JSON.stringify(parameters),previous);
    });
    await t.test('viewing and creating do not attach a setup; private fields are dropped',async()=>{
      state.library={...state.library,versions:[{...version,secret:'MUST_NOT_ESCAPE'}]};
      const library=await api.listSetupVersions('driver','session');assert.equal(library.selectedVersionId,null);assert(!JSON.stringify(library).includes('MUST_NOT_ESCAPE'));
      assert.equal(await api.createSetupVersion('driver','session',{label:' Revision ',notes:'',parameters,parentId:'version-a'}),'version-b');
      assert.deepEqual(state.calls.at(-1),{name:'sim_setup_create',args:{p_session_id:'session',p_label:'Revision',p_notes:'',p_parameters:parameters,p_parent_id:'version-a'}});
      assert(!state.calls.some(c=>c.name==='sim_setup_attach'));
    });
    await t.test('only explicit attach, detach and delete use their mutation RPCs',async()=>{
      await api.attachSetupVersion('driver','session','version-b');assert.deepEqual(state.calls.at(-1),{name:'sim_setup_attach',args:{p_session_id:'session',p_version_id:'version-b'}});
      await api.attachSetupVersion('driver','session',null);assert.equal(state.calls.at(-1).args.p_version_id,null);
      await api.deleteSetupVersion('driver','version-b');assert.deepEqual(state.calls.at(-1),{name:'sim_setup_delete',args:{p_id:'version-b'}});
    });
    await t.test('demo, wrong or signed-out accounts and prior cancellation spend no work',async()=>{
      const before=state.calls.length;state.user=null;await assert.rejects(api.listSetupVersions('driver','session'));
      state.user={id:'other'};await assert.rejects(api.attachSetupVersion('driver','session','version-b'));
      state.user={id:'driver'};state.demo=true;await assert.rejects(api.deleteSetupVersion('driver','version-b'));state.demo=false;
      const abort=new AbortController();abort.abort();await assert.rejects(api.listSetupVersions('driver','session',abort.signal));assert.equal(state.calls.length,before);
    });
    await t.test('late account responses and raw database errors cannot escape',async()=>{
      state.users=[{id:'driver'},{id:'other'}];await assert.rejects(api.listSetupVersions('driver','session'),e=>e.kind==='unavailable');
      for(const kind of['invalid_setup','setup_limit','session_not_found']){state.error={message:kind};await assert.rejects(api.listSetupVersions('driver','session'),e=>e.kind===kind);}
      state.error={message:'private internal SQL details'};await assert.rejects(api.listSetupVersions('driver','session'),e=>e.message==='unavailable');state.error=null;
    });
  }finally{delete globalThis.__setupClient;}
});
