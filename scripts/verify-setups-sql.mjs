// Actual setup migrations and owner RPCs in isolated PostgreSQL, with no server/provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT ?? 'node_modules/.xpeed-audit-tools', 'package.json')));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create();
const id = (n) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user=id(1), other=id(2), source=id(3), foreign=id(4), track=id(5), car=id(6), alternate=id(7);
const parameters=[{name:'Front pressure',value:'27.5',unit:'psi'},{name:'Brake bias',value:'54',unit:'%'}];
let passed=0;
const check=async(name,fn)=>{await fn();passed++;if(process.env.VERBOSE)console.log(name);};
const asUser=async(who,fn,commit=false,role='authenticated')=>{
  await db.exec(`BEGIN; SET LOCAL ROLE ${role}`);
  try{await db.query("SELECT set_config('test.user_id',$1,true)",[who??'']);const result=await fn();await db.exec(commit?'COMMIT':'ROLLBACK');return result;}
  catch(error){await db.exec('ROLLBACK');throw error;}
};
const rpc=(name,args=[],who=user,commit=false)=>asUser(who,async()=>
  (await db.query(`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args)).rows[0].value,commit);
const create=(parent=null,settings=parameters,sessionId=source,who=user,label='Baseline')=>
  rpc('sim_setup_create',[sessionId,label,'Controlled setup experiment',JSON.stringify(settings),parent],who,true);
const list=(sessionId=source,who=user)=>rpc('sim_setup_versions',[sessionId],who);
const session=async(sessionId,owner=user,circuit=track)=>{
  await db.query("INSERT INTO sim_sessions(id,user_id,game,track_id,car_id,kind,started_at,lap_count) VALUES($1,$2,'ac',$3,$4,'practice','2026-11-18T12:00:00Z',3)",[sessionId,owner,circuit,car]);
  for(let i=1;i<=3;i++)await db.query("INSERT INTO sim_laps(user_id,session_id,lap_number,time_ms,valid,plausible,in_lap,out_lap,started_at) VALUES($1,$2,$3,$4,true,true,false,false,'2026-11-18T12:00:00Z')",[owner,sessionId,i,90000+i*100]);
};
try{
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO authenticated,anon,service_role;
    CREATE FUNCTION current_app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.user_id',true),'')::uuid$$;
    CREATE TABLE app_accounts(id uuid PRIMARY KEY);
    CREATE TABLE sim_profiles(user_id uuid PRIMARY KEY REFERENCES app_accounts(id) ON DELETE CASCADE);
    CREATE FUNCTION sim_ensure_profile(p_user uuid) RETURNS void LANGUAGE sql AS $$INSERT INTO public.sim_profiles VALUES(p_user) ON CONFLICT DO NOTHING$$;
    CREATE TABLE sim_sessions(id uuid PRIMARY KEY,user_id uuid,game text,track_id uuid,car_id uuid,kind text,started_at timestamptz,
      lap_count integer,weather text,air_temp_c numeric,track_temp_c numeric);
    CREATE TABLE sim_laps(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,session_id uuid REFERENCES sim_sessions(id) ON DELETE CASCADE,
      lap_number integer,time_ms integer,valid boolean,plausible boolean,in_lap boolean,out_lap boolean,started_at timestamptz);`);
  await db.query('INSERT INTO app_accounts VALUES($1),($2)',[user,other]);
  await session(source);await session(foreign,other);await session(alternate,user,id(8));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261118180000_virtual_training_goals.sql',import.meta.url),'utf8'));
  const sql=readFileSync(new URL('../supabase/migrations/20261118190000_virtual_setup_versions.sql',import.meta.url),'utf8');
  await check('setup migration is repeatable',async()=>{await db.exec(sql);await db.exec(sql);});
  await check('setup tools start empty and do not infer a used setup',async()=>assert.deepEqual(await list(),{versions:[],selectedVersionId:null,limit:20}));
  const base=await create(null,[{name:' Front pressure ',value:' 27.5 ',unit:' psi ',ignored:'not persisted'},parameters[1]]);
  const changed=[{name:'Front pressure',value:'27.2',unit:'psi'},parameters[1]], child=await create(base,changed,source,user,'Revision 2');
  const foreignVersion=await create(null,parameters,foreign,other), otherContext=await create(null,parameters,alternate);
  await check('versions are immutable snapshots and creation never attaches one',async()=>{
    const library=await list(),parent=library.versions.find(v=>v.id===base),revision=library.versions.find(v=>v.id===child);
    assert.deepEqual(parent.parameters,parameters);assert.deepEqual(revision.parameters,changed);assert.equal(revision.parentId,base);
    assert.equal(library.selectedVersionId,null);assert.deepEqual(revision.runs,[]);
  });
  await check('source ownership and matching parent context are mandatory',async()=>{
    await assert.rejects(list(foreign),/session_not_found/);await assert.rejects(create(null,parameters,foreign),/session_not_found/);
    for(const parent of[foreignVersion,otherContext])await assert.rejects(create(parent),/invalid_setup/);
    await assert.rejects(rpc('sim_setup_attach',[foreign,base],user,true),/session_not_found/);
    await assert.rejects(rpc('sim_setup_attach',[source,foreignVersion],user,true),/invalid_setup/);
    await assert.rejects(rpc('sim_setup_attach',[source,otherContext],user,true),/invalid_setup/);
  });
  await check('raw tables and private context cannot be accessed by an ordinary account',async()=>{
    for(const who of[user,other])for(const query of['SELECT * FROM sim_setup_versions','SELECT * FROM sim_session_setups',
      "UPDATE sim_setup_versions SET label='changed'",'DELETE FROM sim_setup_versions',`SELECT sim_setup_context('${user}','${source}')`,
      `SELECT sim_setup_json('${user}','${base}')`])await assert.rejects(asUser(who,()=>db.query(query)),/permission denied/);
    await assert.rejects(asUser(user,()=>db.query('SELECT sim_setup_versions($1)',[source]),false,'anon'),/permission denied/);
    await assert.rejects(list(source,null),/unauthorized/);
  });
  await check('invalid structured parameters and labels fail without creating a partial version',async()=>{
    const invalid=[[],Array.from({length:33},(_,i)=>({name:'Setting '+i,value:'1',unit:''})),[{name:'Name',value:5,unit:''}],
      [{name:'Name',value:'x'}],[{name:'Name',value:'',unit:''}],[{name:'Name\nInjected',value:'1',unit:''}],
      [parameters[0],{...parameters[0],name:'front pressure'}],{},null];
    for(const settings of invalid)await assert.rejects(create(null,settings),/invalid_setup/);
    for(const label of['','  ','x'.repeat(121),'Line\nbreak'])await assert.rejects(create(null,parameters,source,user,label),/invalid_setup/);
    assert.equal((await list()).versions.length,2);
  });
  await check('only an explicit attach changes session usage; detach is reversible',async()=>{
    assert.equal(await rpc('sim_setup_attach',[source,child],user,true),true);assert.equal((await list()).selectedVersionId,child);
    const row=(await list()).versions.find(v=>v.id===child);assert.equal(row.runs[0].sessionId,source);assert.equal(row.runs[0].value,90100);
    await rpc('sim_setup_attach',[source,null],user,true);assert.equal((await list()).selectedVersionId,null);
    await rpc('sim_setup_attach',[source,child],user,true);
  });
  await check('the coach sees only explicitly attached owned snapshots and their own parent',async()=>{
    const read=()=>db.query('SELECT sim_setup_context($1,$2) AS context',[user,source]);
    const context=(await asUser('',read,false,'service_role')).rows[0].context;
    assert.equal(context.version.id,child);assert.equal(context.parent.id,base);
    assert.deepEqual(context.version.parameters,changed);assert.equal(context.version.runs[0].value,90100);
    const mismatch=await asUser('',()=>db.query('SELECT sim_setup_context($1,$2) AS context',[other,source]),false,'service_role');
    assert.equal(mismatch.rows[0].context,null);
  });
  await check('run evidence is owner-scoped, recomputed and capped at three recent sessions',async()=>{
    for(let n=10;n<14;n++){await session(id(n));await db.query('UPDATE sim_sessions SET started_at=$1 WHERE id=$2',[`2026-11-18T13:${n}:00Z`,id(n)]);await rpc('sim_setup_attach',[id(n),child],user,true);}
    const revision=(await list()).versions.find(v=>v.id===child);assert.equal(revision.runs.length,3);assert.equal(revision.runs[0].sessionId,id(13));
    await db.query('DELETE FROM sim_laps WHERE session_id=$1 AND time_ms=90100',[id(13)]);
    assert.equal((await list()).versions.find(v=>v.id===child).runs[0].value,90200);
  });
  await check('an account cannot delete another driver version by a known id',async()=>{
    assert.equal(await rpc('sim_setup_delete',[base],other,true),false);assert.equal((await list()).versions.length,2);
  });
  await check('library limits reject a 21st context version',async()=>{
    for(let i=0;i<18;i++)await create(null,parameters,source,user,'Experiment '+i);
    assert.equal((await list()).versions.length,20);await assert.rejects(create(),/setup_limit/);
  });
  await check('deleting a parent keeps child snapshots but removes associations and the deleted parent link',async()=>{
    await rpc('sim_setup_attach',[source,base],user,true);await rpc('sim_setup_delete',[base],user,true);
    const library=await list();assert.equal(library.selectedVersionId,null);
    const revision=library.versions.find(v=>v.id===child);assert.equal(revision.parentId,null);assert.deepEqual(revision.parameters,changed);
  });
  await check('deleting a session preserves the private library and drops only its association',async()=>{
    await rpc('sim_setup_attach',[source,child],user,true);await db.query('DELETE FROM sim_sessions WHERE id=$1',[source]);
    assert.equal((await list(id(13))).versions.length,19);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM sim_session_setups WHERE session_id=$1',[source])).rows[0].n,0);
  });
  await check('full Virtual profile erasure cascades to the library and associations, leaving the other driver intact',async()=>{
    await db.query('DELETE FROM sim_profiles WHERE user_id=$1',[user]);
    assert.equal((await list(id(13))).versions.length,0);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM sim_session_setups WHERE user_id=$1',[user])).rows[0].n,0);
    assert.equal((await list(foreign,other)).versions.length,1);
  });
  console.log(`Virtual setups SQL: ${passed} contracts passed (private immutable snapshots, explicit usage, bounded evidence and erasure).`);
}catch(error){console.error(`Setup SQL contract ${passed+1} failed: ${error.message}`);process.exitCode=1;}finally{await db.close();}
