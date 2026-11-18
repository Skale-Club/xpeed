// Real migration/claim/finish contracts, without network, provider or app DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require=createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT??'node_modules/.xpeed-audit-tools','package.json')));
const {PGlite}=require('@electric-sql/pglite');const db=await PGlite.create();
const id=n=>`80000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner=id(1),other=id(2),device=id(3),otherDevice=id(4),secondDevice=id(5),source=id(6),foreign=id(7),secondSource=id(8),track=id(9),car=id(10);
let passed=0;const check=async(name,fn)=>{await fn();passed++;if(process.env.VERBOSE)console.log(name)};
const query=async(name,args=[])=> (await db.query(`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args)).rows[0].value;
const begin=(messageId,message='What should I practise?',options={})=>query('sim_companion_coach_begin',[options.owner??owner,options.device??device,options.session??source,options.conversation??null,messageId,message]);
const asRole=async(role,who,fn)=>{await db.exec(`BEGIN;SET LOCAL ROLE ${role}`);try{await db.query("SELECT set_config('test.user_id',$1,true)",[who]);return await fn()}finally{await db.exec('ROLLBACK')}};
try{
 await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role BYPASSRLS;GRANT USAGE ON SCHEMA public TO authenticated,anon,service_role;
  CREATE FUNCTION current_app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.user_id',true),'')::uuid$$;
  CREATE TABLE app_accounts(id uuid PRIMARY KEY);
  CREATE TABLE sim_devices(id uuid PRIMARY KEY,user_id uuid REFERENCES app_accounts(id) ON DELETE CASCADE,token_hash text,revoked_at timestamptz);
  ALTER TABLE sim_devices ENABLE ROW LEVEL SECURITY;CREATE POLICY own_device ON sim_devices FOR SELECT TO authenticated USING(user_id=current_app_user_id());
  CREATE TABLE sim_track_catalog(id uuid PRIMARY KEY,name text);CREATE TABLE sim_car_catalog(id uuid PRIMARY KEY,name text);
  CREATE TABLE sim_sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES app_accounts(id) ON DELETE CASCADE,track_id uuid,car_id uuid,
   game text DEFAULT 'ac',kind text DEFAULT 'practice',started_at timestamptz DEFAULT now());
  CREATE TABLE sim_laps(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid REFERENCES sim_sessions(id) ON DELETE CASCADE,user_id uuid,device_id uuid);
  CREATE TABLE chat_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES app_accounts(id) ON DELETE CASCADE,
   title text,mode text,sim_session_id uuid REFERENCES sim_sessions(id) ON DELETE CASCADE,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
  CREATE TABLE chat_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES chat_conversations(id) ON DELETE CASCADE,
   role text,parts jsonb,created_at timestamptz DEFAULT now());`);
 await db.query('INSERT INTO app_accounts VALUES($1),($2)',[owner,other]);
 await db.query('INSERT INTO sim_devices(id,user_id,token_hash) VALUES($1,$2,$3),($4,$5,$6),($7,$2,$8)',[device,owner,'dummy-hash',otherDevice,other,'other-hash',secondDevice,'second-hash']);
 await db.query("INSERT INTO sim_track_catalog VALUES($1,'Monza')",[track]);await db.query("INSERT INTO sim_car_catalog VALUES($1,'Test GT3')",[car]);
 for(const[s,u,d]of[[source,owner,device],[foreign,other,otherDevice],[secondSource,owner,secondDevice]]){
  await db.query('INSERT INTO sim_sessions(id,user_id,track_id,car_id) VALUES($1,$2,$3,$4)',[s,u,track,car]);
  await db.query('INSERT INTO sim_laps(session_id,user_id,device_id) VALUES($1,$2,$3)',[s,u,d]);
 }
 const sql=readFileSync(new URL('../supabase/migrations/20261118200000_companion_coach.sql',import.meta.url),'utf8');
 await check('migration is repeatable and assistant permission starts off',async()=>{
  await db.exec(sql);await db.exec(sql);assert.equal(await query('sim_companion_coach_allowed',[owner,device]),false);
  assert.deepEqual(await query('sim_companion_coach_sessions',[owner,device]),[]);assert.equal((await begin(id(20))).status,'disabled');
 });
 await check('ordinary accounts may read only their own capability, never hashes or change the flag directly',async()=>{
  const own=await asRole('authenticated',owner,()=>db.query('SELECT companion_coach_enabled FROM sim_devices'));
  assert.equal(own.rows.length,2);assert(own.rows.every(r=>r.companion_coach_enabled===false));
  await assert.rejects(asRole('authenticated',owner,()=>db.query('SELECT token_hash FROM sim_devices')),/permission denied/);
  await assert.rejects(asRole('authenticated',owner,()=>db.query('UPDATE sim_devices SET companion_coach_enabled=true')),/permission denied/);
 });
 await db.query('UPDATE sim_devices SET companion_coach_enabled=true');
 await check('session discovery is owner/device scoped and requires permission',async()=>{
  const sessions=await query('sim_companion_coach_sessions',[owner,device]);assert.equal(sessions.length,1);assert.equal(sessions[0].id,source);
  assert.equal(sessions[0].track,'Monza');assert(!JSON.stringify(sessions).includes('hash'));
  assert.equal(await query('sim_companion_coach_history',[owner,device,foreign]),null);
  assert.equal(await query('sim_companion_coach_history',[owner,device,secondSource]),null);
  assert.equal((await begin(id(21),'Question',{session:foreign})).status,'not_found');
 });
 await check('private claim/history/billing admission RPCs are inaccessible to browser database roles',async()=>{
  for(const role of['anon','authenticated'])for(const sql of[`SELECT sim_companion_coach_allowed('${owner}','${device}')`,
   `SELECT sim_companion_coach_history('${owner}','${device}','${source}')`,
   `SELECT sim_companion_coach_begin('${owner}','${device}','${source}',null,'${id(22)}','Question')`])
   await assert.rejects(asRole(role,owner,()=>db.query(sql)),/permission denied/);
 });
 let conversation;
 await check('admission creates one persisted Virtual question and reuses it without another dispatch',async()=>{
  const first=await begin(id(30));assert.equal(first.status,'created');conversation=first.conversationId;
  for(let i=0;i<3;i++){const retry=await begin(id(30));assert.equal(retry.status,'pending');assert.equal(retry.conversationId,conversation);}
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM chat_messages WHERE id=$1',[id(30)])).rows[0].n,1);
  assert.equal((await db.query('SELECT mode FROM chat_conversations WHERE id=$1',[conversation])).rows[0].mode,'virtual');
 });
 await check('history restores the admitted UUID and exact original question after a native restart',async()=>{
  const history=await query('sim_companion_coach_history',[owner,device,source]);
  assert.deepEqual(history.pendingRequest,{idempotencyKey:id(30),conversationId:conversation,message:'What should I practise?'});
 });
 await check('altered nonce payloads and known foreign conversation ids cannot be substituted',async()=>{
  assert.equal((await begin(id(30),'Changed question')).status,'invalid');
  assert.equal((await begin(id(30),undefined,{conversation:id(99)})).status,'invalid');
  assert.equal((await begin(id(31))).status,'busy');
 });
 await check('finish is atomic and repeated completion cannot duplicate the assistant reply',async()=>{
  for(let i=0;i<2;i++)assert.equal(await query('sim_companion_coach_finish',[owner,device,id(30),'Compare two clean laps.']),true);
  const retry=await begin(id(30));assert.equal(retry.status,'replied');assert.equal(retry.reply,'Compare two clean laps.');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM chat_messages WHERE in_reply_to=$1',[id(30)])).rows[0].n,1);
  assert.equal(await query('sim_companion_coach_finish',[other,otherDevice,id(30),'Foreign answer']),false);
 });
 await check('a provider failure remains a failed request and cannot be charged again by retrying its UUID',async()=>{
  assert.equal((await begin(id(32))).status,'created');assert.equal(await query('sim_companion_coach_finish',[owner,device,id(32),null]),true);
  assert.equal((await begin(id(32))).status,'failed');assert.equal(await query('sim_companion_coach_finish',[owner,device,id(32),'Late answer']),false);
 });
 await check('a Real or foreign thread cannot become native Virtual context',async()=>{
  const real=id(40),alien=id(41);
  await db.query("INSERT INTO chat_conversations(id,user_id,title,mode,sim_session_id) VALUES($1,$2,'Real','real',null),($3,$4,'Foreign','virtual',$5)",[real,owner,alien,other,foreign]);
  for(const thread of[real,alien])assert.equal((await begin(id(42),'Question',{conversation:thread})).status,'not_found');
 });
 await check('history is the shared persisted session thread, with twelve bounded text messages',async()=>{
  for(let i=0;i<16;i++)await db.query("INSERT INTO chat_messages(conversation_id,role,parts,created_at) VALUES($1,'assistant',$2,$3)",
   [conversation,JSON.stringify([{type:'text',text:'x'.repeat(7000)}]),`2026-11-19T13:${String(i).padStart(2,'0')}:00Z`]);
  const history=await query('sim_companion_coach_history',[owner,device,source]);assert.equal(history.conversationId,conversation);
  assert.equal(history.messages.length,12);assert(history.messages.every(m=>m.content.length===1500));
 });
 await check('Virtual export includes only this owner coach chats and never Real-car history or hashes',async()=>{
  const result=await query('sim_companion_export_chat',[owner]);
  assert(result.conversations.some(c=>c.id===conversation));assert(result.messages.some(m=>m.inReplyTo===id(30)));
  assert(!result.conversations.some(c=>c.id===id(40)||c.id===id(41)));assert(!JSON.stringify(result).includes('hash'));
  await assert.rejects(asRole('authenticated',owner,()=>db.query('SELECT sim_companion_export_chat($1)',[other])),/permission denied/);
 });
 await check('revocation or disabling permission blocks cached replies and new admission',async()=>{
  await db.query('UPDATE sim_devices SET companion_coach_enabled=false WHERE id=$1',[device]);
  assert.equal((await begin(id(30))).status,'disabled');assert.equal(await query('sim_companion_coach_history',[owner,device,source]),null);
  await db.query('UPDATE sim_devices SET companion_coach_enabled=true,revoked_at=now() WHERE id=$1',[device]);
  assert.equal(await query('sim_companion_coach_allowed',[owner,device]),false);assert.deepEqual(await query('sim_companion_coach_sessions',[owner,device]),[]);
 });
 await check('session/account erasure removes native questions and replies without affecting another account',async()=>{
  await db.query('DELETE FROM sim_sessions WHERE id=$1',[source]);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM chat_messages WHERE conversation_id=$1',[conversation])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM sim_sessions WHERE id=$1',[foreign])).rows[0].n,1);
 });
 console.log(`Companion coach SQL: ${passed} contracts passed (explicit capability, device scope, persistent idempotency and erasure).`);
}catch(error){console.error(`Companion SQL contract ${passed+1} failed: ${error.message}`);process.exitCode=1;}finally{await db.close();}
