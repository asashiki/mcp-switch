import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { loadConfig } from "../src/config.js";
// Exercise production stage code; the SDK callback surface is mocked, not a live host.
const bundle = await build({entryPoints:["web/stage.ts"],bundle:true,write:false,format:"iife",plugins:[{name:"test-host",setup(b){
 b.onResolve({filter:/^@modelcontextprotocol\/ext-apps$/},()=>({path:"host",namespace:"test"}));
 b.onLoad({filter:/.*/,namespace:"test"},()=>({contents:'export class App { constructor(){window.testApp=this;} connect(){return Promise.resolve();} getHostContext(){return {};} } export const applyHostStyleVariables=()=>{};'}));
}}]});
class Element {
 textContent=""; hidden=false; style={}; dataset={}; attrs=new Map<string,string>(); writes=0; onclick?:()=>void;
 classList={add:()=>{},toggle:()=>false};
 set src(value:string){this.writes++;this.attrs.set("src",value);}
 getAttribute(name:string){return this.attrs.get(name);}
 removeAttribute(name:string){this.attrs.delete(name);}
 addEventListener(){} getBoundingClientRect(){return {height:420};}
}
function fixture(){
 const nodes=new Map<string,Element>();
 const listeners=new Map<string,Function>(); const timers=new Map<number,Function>(); let timerId=0;
 const requests:Array<{signal:AbortSignal;resolve:(r:any)=>void}>=[];
 const win:any={parent:{postMessage(){}},addEventListener:(n:string,f:Function)=>listeners.set(n,f),removeEventListener:(n:string)=>listeners.delete(n)};
 const node=(s:string)=>{if(!nodes.has(s))nodes.set(s,new Element());return nodes.get(s)!;};
 const context={window:win,document:{querySelector:node,documentElement:new Element(),body:new Element(),hidden:false},location:{origin:"https://preview.example"},ResizeObserver:class{observe(){}disconnect(){}},AbortController,AbortSignal,
 setTimeout:(f:Function)=>{timers.set(++timerId,f);return timerId;},clearTimeout:(id:number)=>timers.delete(id),
 fetch:(_url:string,opts:any)=>new Promise(resolve=>requests.push({signal:opts.signal,resolve}))};
 vm.runInNewContext(bundle.outputFiles[0]!.text,context);
 return {win,node,listeners,timers,requests,send:(data:any)=>win.testApp.ontoolresult({structuredContent:data}),tick:()=>{const tasks=[...timers.values()];timers.clear();tasks.forEach(f=>f());}};
}
const scene=(revision:number)=>({sessionId:"session",revision,name:"Alice",line:`line ${revision}`,spriteUrl:`https://media.example/${revision}.png`});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test("standard results win over stale legacy events; duplicates preserve images",()=>{
 const f=fixture(); f.listeners.get("openai:set_globals")!({detail:{globals:{toolOutput:scene(1)}}}); f.send(scene(2));
 const writes=f.node(".portrait").writes;
 for(let i=0;i<25;i++){f.listeners.get("openai:set_globals")!({detail:{globals:{toolOutput:scene(1)}}});f.send({...scene(2),catalog:{unused:i}});}
 assert.equal(f.node(".line").textContent,"line 2");assert.equal(f.node(".portrait").writes,writes);
});
test("text JSON tool results render without structuredContent",()=>{
 const f=fixture();f.win.testApp.ontoolresult({content:[{type:"text",text:JSON.stringify(scene(1))}]});assert.equal(f.node(".line").textContent,"line 1");
});
test("new scene aborts old polling and stale completion cannot replace it",async()=>{
 const f=fixture();f.send({scene:scene(1),job:{id:"job",status:"running",pollUrl:"https://media.example/job"}});f.tick();await flush();assert.equal(f.requests.length,1);
 f.send(scene(2));assert.equal(f.requests[0]!.signal.aborted,true);
 f.requests[0]!.resolve({ok:true,json:async()=>({status:"succeeded",imageUrl:"https://media.example/old.png"})});await flush();
 assert.equal(f.node(".cg").getAttribute("src"),undefined);assert.equal(f.node(".line").textContent,"line 2");
});
test("teardown cancels pending polling and subsequent renders",async()=>{
 const f=fixture();f.send({scene:scene(1),job:{id:"job",status:"running",pollUrl:"https://media.example/job"}});assert.equal(f.timers.size,1);
 f.win.testApp.onteardown();assert.equal(f.timers.size,0);f.send(scene(2));f.tick();await flush();assert.equal(f.requests.length,0);assert.equal(f.node(".line").textContent,"line 1");
});
test("remote media config rejects silent path stripping and implicit localhost",()=>{
 assert.throws(()=>loadConfig({COMPANION_PUBLIC_URL:"https://media.example/path"}),/origin/);
 assert.throws(()=>loadConfig({COMPANION_HOST:"0.0.0.0",COMPANION_TOKEN:"test"}),/PUBLIC_URL required/);
 assert.equal(loadConfig({COMPANION_PUBLIC_URL:"https://media.example/"}).publicUrl,"https://media.example");
});
