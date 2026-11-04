import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import securityHeaders from './security-headers.json';
import mcp from '../api/mcp';
import fuel from '../api/fuel';
import fuelPrice from '../api/fuel-price';
import vehicleCare from '../api/vehicle-care';
import tripCheckpoints from '../api/trip-checkpoints';
import syncProblems from '../api/sync-problems';
import sharedMedia from '../api/shared-media';
import manifest from '../api/brand/manifest';
import authorizationServer from '../api/wellknown/oauth-authorization-server';
import protectedResource from '../api/wellknown/oauth-protected-resource';
import register from '../api/oauth/register';
import issueCode from '../api/oauth/issue-code';
import token from '../api/oauth/token';
import pg from 'pg';
import { migrate, ensureIdentityProject } from '../db/migrate.mjs';
import { asService, databaseConfigured } from './db';
import { createAccountRoute } from './account-route';
import { createDbRoute } from './db-route';
import { createStorageRoute, storageStatus } from './storage-route';

type Handler = (request: Request) => Response | Promise<Response>;
const routes = new Map<string,Handler>([
  ['/api/mcp',mcp],['/api/fuel',fuel],['/api/fuel-price',fuelPrice],['/api/vehicle-care',vehicleCare],
  ['/api/trip-checkpoints',tripCheckpoints],['/api/sync-problems',syncProblems],['/api/shared-media',sharedMedia],
  ['/api/brand/manifest',manifest],['/manifest.webmanifest',manifest],
  ['/.well-known/oauth-authorization-server',authorizationServer],['/api/wellknown/oauth-authorization-server',authorizationServer],
  ['/.well-known/oauth-protected-resource',protectedResource],['/api/wellknown/oauth-protected-resource',protectedResource],
  ['/api/oauth/register',register],['/api/oauth/issue-code',issueCode],['/api/oauth/token',token],
  ['/api/account',createAccountRoute()],['/api/db',createDbRoute()],
]);
const mime: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.woff2':'font/woff2','.wasm':'application/wasm','.webmanifest':'application/manifest+json'};
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Saving a trip sends its readings in batches and the original CSV: more than the other routes need.
const MAX_DB_BODY_BYTES = 12 * 1024 * 1024;
// Uploads: the largest bucket accepts 50 MB (trip CSV).
const MAX_STORAGE_BODY_BYTES = 52 * 1024 * 1024;
const storageRoute=createStorageRoute();

async function requestBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Uint8Array | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const chunks: Buffer[]=[]; let total=0;
  for await (const chunk of req.iterator({destroyOnReturn:false})) {
    const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); total+=part.length;
    if (total>limit) { req.resume(); throw Object.assign(new Error('Request too large'),{status:413}); }
    chunks.push(part);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function sendResponse(req: IncomingMessage,res: ServerResponse,response: Response) {
  res.statusCode=response.status;
  response.headers.forEach((value,key)=> { if (!['connection','transfer-encoding','keep-alive','set-cookie'].includes(key)) res.setHeader(key,value); });
  const cookies=response.headers.getSetCookie(); if(cookies.length)res.setHeader('Set-Cookie',cookies);
  if(req.method==='HEAD'||!response.body){res.end();return;}
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),res);
}

export function createXpeedServer(options: { staticRoot?: string; origin?: string; trustProxy?: boolean } = {}) {
  const root=resolve(options.staticRoot??'dist');
  const origin=new URL(options.origin??process.env.PUBLIC_APP_URL??'https://xpeed.skale.club');
  const trustProxy=options.trustProxy??process.env.TRUST_PROXY==='true';
  return createServer({requestTimeout:30_000,headersTimeout:15_000,maxHeaderSize:16_384},async(req,res)=>{
    for(const [key,value] of Object.entries(securityHeaders))res.setHeader(key,value);
    try {
      if(!req.url?.startsWith('/')){res.writeHead(400).end();return;}
      const url=new URL(req.url,origin);
      if(url.pathname==='/api/health'){
        if(!['GET','HEAD'].includes(req.method??'')){res.setHeader('Allow','GET, HEAD');res.writeHead(405).end();return;}
        res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
        // The database is reported but never fails the check: a blip must not restart the container.
        const database=databaseConfigured()?await asService(c=>c.query('SELECT 1')).then(()=>'ok',()=>'down'):'off';
        res.end(JSON.stringify({status:'ok',app:'xpeed',version:process.env.SOURCE_COMMIT??'local',database,storage:await storageStatus()}));return;
      }
      const handler=url.pathname.startsWith('/api/storage/')?storageRoute:routes.get(url.pathname.replace(/\/$/,''));
      if(handler){
        const controller=new AbortController();
        req.once('aborted',()=>controller.abort());
        res.once('close',()=>{if(!res.writableFinished)controller.abort();});
        const headers=new Headers();
        for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
        // Traefik appends the real peer after untrusted incoming forwarded values.
        const forwarded=String(req.headers['x-forwarded-for']??'').split(',').at(-1)?.trim();
        const ip=trustProxy&&forwarded&&isIP(forwarded)?forwarded:req.socket.remoteAddress??'';
        headers.set('x-real-ip',ip);headers.set('x-forwarded-for',ip);
        headers.set('host',origin.host);headers.set('x-forwarded-proto',origin.protocol.slice(0,-1));
        const body=await requestBody(req,url.pathname==='/api/db'?MAX_DB_BODY_BYTES:url.pathname.startsWith('/api/storage/')?MAX_STORAGE_BODY_BYTES:MAX_BODY_BYTES);
        const request=new Request(new URL(url.pathname+url.search,origin),{method:req.method,headers,signal:controller.signal,...(body?{body:body.buffer as ArrayBuffer}:{})});
        await sendResponse(req,res,await handler(request));return;
      }
      if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/.well-known/')){
        res.setHeader('Content-Type','application/json');res.writeHead(404).end('{"error":"not_found"}');return;
      }
      if(!['GET','HEAD'].includes(req.method??'')){res.setHeader('Allow','GET, HEAD');res.writeHead(405).end();return;}
      const pathname=decodeURIComponent(url.pathname);
      if(pathname.split(/[\\/]/).some(part=>part.startsWith('.'))){res.writeHead(404).end();return;}
      let file=resolve(root,'.'+pathname);const within=relative(root,file);
      if(within.startsWith('..')||isAbsolute(within)){res.writeHead(404).end();return;}
      let info=await stat(file).catch(()=>null);
      if(!info?.isFile()){
        if(extname(pathname)){res.writeHead(404).end();return;}
        file=resolve(root,'index.html');info=await stat(file);
      }
      res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');
      res.setHeader('Content-Length',info.size);
      res.setHeader('Cache-Control',pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache, no-store, must-revalidate');
      if(req.method==='HEAD'){res.end();return;}
      await pipeline(createReadStream(file),res);
    }catch(error){
      if(res.destroyed)return;
      if(res.headersSent){res.destroy();return;}
      const status=typeof error==='object'&&error&&'status'in error&&error.status===413?413:500;
      console.error(JSON.stringify({event:'http_request_failed',path:req.url?.split('?')[0],status}));
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      if(status===413)res.setHeader('Connection','close');
      res.writeHead(status).end(JSON.stringify({error:status===413?'request_too_large':'unavailable'}));
    }
  });
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  if(!process.env.VITE_SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw Error('Missing runtime database configuration');
  if(databaseConfigured()&&process.env.RUN_MIGRATIONS!=='false'){
    const client=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:false}:undefined});
    await client.connect();
    try{
      const result=await migrate(client,{log:message=>console.log(JSON.stringify({event:'migration',message}))});
      await ensureIdentityProject(client,process.env.FIREBASE_PROJECT_ID??process.env.VITE_FIREBASE_PROJECT_ID);
      console.log(JSON.stringify({event:'migrations_done',applied:result.applied.length,adopted:result.adopted.length}));
    }finally{await client.end();}
  }
  const server=createXpeedServer();
  server.listen(Number(process.env.PORT??8888),'0.0.0.0',()=>console.log(JSON.stringify({event:'server_ready',port:Number(process.env.PORT??8888)})));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),15_000).unref();});
}
