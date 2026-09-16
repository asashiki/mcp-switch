import Fastify from 'fastify';
import { createMcpHandler, validateHostHeader, validateOriginHeader } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Companion } from './service.js';
import { createServer } from './mcp.js';

export function createHttp(service:Companion) {
  const app=Fastify({bodyLimit:10*1024*1024,logger:false});
  const cfg=service.config;
  const handler=toNodeHandler(createMcpHandler(()=>createServer(service),{legacy:'stateless',responseMode:'auto'}));
  app.addHook('onRequest',async(req,reply)=>{
    const allowed=['127.0.0.1','localhost','[::1]',new URL(cfg.publicUrl).hostname];
    if(!validateHostHeader(req.headers.host,allowed).ok)return reply.code(403).send({error:'Host rejected'});
    const publicMedia=req.url.startsWith('/media/')||req.url.startsWith('/jobs/');
    // Signed, read-only media can be embedded cross-origin. Admin/MCP require same-origin or no Origin.
    if(!publicMedia&&!validateOriginHeader(req.headers.origin,[new URL(cfg.publicUrl).hostname,'localhost','127.0.0.1']).ok)return reply.code(403).send({error:'Origin rejected'});
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    if(publicMedia){reply.header('Access-Control-Allow-Origin','*');reply.header('Cache-Control','private, no-store');}
    if((req.url.startsWith('/api/')||req.url.split('?')[0]==='/mcp')&&cfg.token){
      const got=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??'');const expected=Buffer.from(cfg.token);
      if(got.length!==expected.length||!timingSafeEqual(got,expected))return reply.code(401).send({error:'Bearer token required'});
    }
  });
  app.setErrorHandler((err,req,reply)=>{const error=err as Error;reply.code(400).send({error:error.message});});
  app.get('/health',async()=>({ok:true,service:'companion-mcp'}));
  app.route({method:['GET','POST','DELETE'],url:'/mcp',handler:async(req,reply)=>{await handler(req.raw,reply.raw,req.body);return reply;}});
  app.get('/admin',async(req,reply)=>reply.type('text/html').send(await readFile(new URL('../dist/admin.html',import.meta.url),'utf8')));
  app.get('/stage',async(req,reply)=>reply.type('text/html').send(await readFile(new URL('../dist/stage.html',import.meta.url),'utf8')));
  app.get('/api/config',async()=>({characters:service.getCharacters(),generationEnabled:cfg.generationEnabled,providerConfigured:!!cfg.naiToken,dailyLimit:cfg.dailyLimit}));
  app.put('/api/config',async(req)=>{service.saveCharacters(req.body);return {ok:true};});
  app.post('/api/preview',async(req)=>{
    const a=z.object({characterId:z.string(),expression:z.string(),sceneId:z.string(),outfit:z.string(),action:z.string().max(600),line:z.string().max(2000),composition:z.string().max(1000)}).parse(req.body);
    const c=service.character(a.characterId);
    const s={sessionId:'preview',revision:0,character:c,mode:'avatar' as const,expression:a.expression,sceneId:a.sceneId,outfit:a.outfit,action:a.action,line:a.line};
    if(!Object.hasOwn(c.expressions,a.expression)||!Object.hasOwn(c.scenes,a.sceneId)||!Object.hasOwn(c.outfits,a.outfit))throw new Error('Unknown scene selection');
    const {compilePrompt}=await import('./novelai.js');return {scene:service.view(s),preview:compilePrompt(s,a.composition,123456789)};
  });
  app.addContentTypeParser(['image/png','image/jpeg','image/webp'],{parseAs:'buffer'},(req,body,done)=>done(null,body));
  app.post('/api/assets',async(req)=>{
    const bytes=req.body as Buffer;
    if(!Buffer.isBuffer(bytes))throw new Error('Upload raw PNG, JPEG or WebP bytes');
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg=bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    const webp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
    if(!png&&!jpg&&!webp)throw new Error('Unsupported image data');
    const name=`${createHash('sha256').update(bytes).digest('hex')}.${png?'png':jpg?'jpg':'webp'}`;
    await writeFile(join(cfg.dataDir,'assets',name),bytes,{mode:0o600});return {asset:name,url:service.asset(name)};
  });
  app.get<{Params:{name:string};Querystring:{expires?:string;sig?:string}}>('/media/:name',async(req,reply)=>{
    const name=z.string().regex(/^[a-zA-Z0-9_-]+\.(png|jpg|webp)$/).parse(req.params.name);
    if(!service.verify(`/media/${name}`,req.query.expires,req.query.sig))return reply.code(403).send({error:'Media link expired or invalid; restore the scene'});
    try{return reply.type(name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':'image/webp').send(await readFile(join(cfg.dataDir,'assets',name)));}catch{return reply.code(404).send({error:'Image not found'});}
  });
  app.get<{Params:{id:string};Querystring:{expires?:string;sig?:string}}>('/jobs/:id',async(req,reply)=>{
    const id=z.string().uuid().parse(req.params.id);
    if(!service.verify(`/jobs/${id}`,req.query.expires,req.query.sig))return reply.code(403).send({error:'Job link expired or invalid'});
    return service.jobView(service.store.job('personal',id));
  });
  app.addHook('onClose',async()=>service.close());
  return app;
}
