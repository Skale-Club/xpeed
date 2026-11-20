import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { createXpeedServer } from '../build/server/index.mjs';

test('container serves the SPA, API guards, OAuth metadata and bounded requests', async () => {
 const server=createXpeedServer({origin:'https://xpeed.skale.club',trustProxy:true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const health=await fetch(base+'/api/health');assert.equal(health.status,200);assert.equal((await health.json()).app,'xpeed');
  for(const path of ['/','/history','/oauth/authorize']){const r=await fetch(base+path);assert.equal(r.status,200,path);assert.match(r.headers.get('content-type'),/text\/html/);assert.match(r.headers.get('cache-control'),/no-store/);}
  for(const path of ['/.env','/.git/config','/assets/missing.js','/api/not-real','/..%5cpackage.json'])assert.equal((await fetch(base+path)).status,404,path);
  const asset=readdirSync('dist/assets').find(name=>name.endsWith('.js'));
  const staticResponse=await fetch(base+'/assets/'+asset);assert.match(staticResponse.headers.get('cache-control'),/immutable/);
  const head=await fetch(base+'/assets/'+asset,{method:'HEAD'});assert.equal(await head.text(),'');assert.ok(Number(head.headers.get('content-length'))>0);
  const discovery=await fetch(base+'/.well-known/oauth-authorization-server',{headers:{'x-forwarded-proto':'http','x-forwarded-host':'evil.test'}});
  assert.equal((await discovery.json()).issuer,'https://xpeed.skale.club');
  const cors=await fetch(base+'/api/mcp',{method:'OPTIONS'});assert.equal(cors.status,204);assert.equal(cors.headers.get('access-control-allow-origin'),'*');
  assert.equal((await fetch(base+'/api/sync-problems',{method:'POST'})).status,401);
  assert.equal((await fetch(base+'/api/fuel?carId=invalid')).status,400);
  const oversized=await fetch(base+'/api/sync-problems',{method:'POST',body:'x'.repeat(2*1024*1024+1)});assert.equal(oversized.status,413);
  // Track layouts: the routes under /api/sim/tracks/ reach the handler, and its body may be up to 33 MB (not 2 MB).
  assert.equal((await fetch(base+'/api/sim/tracks/00000000-0000-4000-8000-000000000000/file',{method:'OPTIONS'})).status,204);
  assert.notEqual((await fetch(base+'/api/sim/tracks',{method:'POST',headers:{'content-type':'application/gzip'},body:new Uint8Array(3*1024*1024)})).status,413);
  // An upload is authenticated before its body is read, so a stranger sending 33 MB gets 401, never a read of the body
  // (the 413 for an oversized body from a known device is covered in scripts/verify-sim.mjs).
  assert.equal((await fetch(base+'/api/sim/tracks',{method:'POST',headers:{'content-type':'application/gzip'},body:new Uint8Array(33*1024*1024+1)})).status,401);
  // The heartbeat of Xpeed Companion: a stranger is 401 before anything is read, a body over 4 KB is cut off while it is read, only POST.
  assert.equal((await fetch(base+'/api/sim/heartbeat',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(base+'/api/sim/heartbeat',{method:'POST',headers:{authorization:'Bearer xpd_x'},body:'x'.repeat(5000)})).status,413);
  assert.equal((await fetch(base+'/api/sim/heartbeat')).status,405);
  // The reference lap route: a stranger is 401, only GET.
  assert.equal((await fetch(base+'/api/sim/reference?game=lmu&track=T&car=C')).status,401);
  assert.equal((await fetch(base+'/api/sim/reference',{method:'POST',headers:{authorization:'Bearer xpd_x'}})).status,405);
  // The live relay: a stranger is 401 on the device route and on the person's two routes (the stream is never opened), only GET and POST.
  assert.equal((await fetch(base+'/api/sim/live',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(base+'/api/sim/live')).status,401);
  assert.equal((await fetch(base+'/api/sim/live/stream')).status,401);
  assert.equal((await fetch(base+'/api/sim/live',{method:'DELETE'})).status,405);
  // First-party error tracking: Companion's report needs the device key, both reports are cut off over 32 KB while read, and only POST (the browser's also OPTIONS).
  assert.equal((await fetch(base+'/api/sim/companion-errors',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(base+'/api/sim/companion-errors',{method:'POST',headers:{authorization:'Bearer xpd_x'},body:'x'.repeat(40000)})).status,413);
  assert.equal((await fetch(base+'/api/client-errors',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(40000)})).status,413);
  assert.equal((await fetch(base+'/api/client-errors')).status,405);
  assert.equal((await fetch(base+'/api/client-errors',{method:'OPTIONS'})).status,204);
  // /api/health carries the disk of the files volume (percentages, or null where it cannot be read) and never fails over it.
  assert.ok('disk' in await (await fetch(base+'/api/health')).json());
  assert.match(health.headers.get('content-security-policy'),/accounts.google.com/);
  // The app talks only to its own server: Supabase is not allowed to be called from the browser any more.
  assert.doesNotMatch(health.headers.get('content-security-policy'),/supabase/);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
