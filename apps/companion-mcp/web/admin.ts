import type { Character } from '../src/config.js';
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const val=(id:string)=>$<HTMLInputElement>(id).value;
let token='',characters:Character[]=[],current=0;
async function api(path:string,options:RequestInit={}){const response=await fetch(path,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers}});if(response.status===401){$('login').hidden=false;$('editor').hidden=true;throw new Error('请输入正确的访问密钥');}const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败');return result;}
function options(id:string,items:Array<[string,string]>,value:string){const select=$<HTMLSelectElement>(id);select.replaceChildren(...items.map(([id,name])=>{const o=document.createElement('option');o.value=id;o.textContent=name;return o;}));select.value=value;}
function fill(){const c=characters[current]!;for(const key of ['name','persona','characterPrompt','stylePrompt','negativePrompt','characterNegativePrompt'] as const)$<HTMLInputElement>(key).value=c[key];$<HTMLInputElement>('model').value=c.generation.model;
 options('expression',Object.keys(c.expressions).map(k=>[k,k]),c.defaultExpression);options('scene',Object.entries(c.scenes).map(([k,s])=>[k,s.name]),c.defaultScene);options('outfit',Object.keys(c.outfits).map(k=>[k,k]),c.defaultOutfit);$<HTMLTextAreaElement>('advanced').value=JSON.stringify(characters,null,2);}
function collect(){const c=characters[current]!;for(const key of ['name','persona','characterPrompt','stylePrompt','negativePrompt','characterNegativePrompt'] as const)c[key]=val(key);c.generation.model=val('model');}
async function preview(){const result=await api('/api/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({characterId:characters[current]!.id,expression:val('expression'),sceneId:val('scene'),outfit:val('outfit'),line:val('line'),action:val('action'),composition:val('composition')})});
 $('prompt').textContent=JSON.stringify(result.preview,null,2);$<HTMLIFrameElement>('preview').contentWindow?.postMessage({type:'companion-local-preview',result},location.origin);}
async function load(){const result=await api('/api/config');characters=result.characters;options('character',characters.map(c=>[c.id,c.name]),characters[0]!.id);current=0;fill();$('provider').textContent=`${result.providerConfigured?'NAI 凭据已配置':'尚未配置 NAI 凭据'} · ${result.generationEnabled?'已开启生成':'生成尚未开启'} · 每日上限 ${result.dailyLimit} 张`;$('login').hidden=true;$('editor').hidden=false;await preview();}
async function run(fn:()=>Promise<void>){try{await fn();}catch(e){$('status').textContent=e instanceof Error?e.message:'操作失败';$('login-status').textContent=$('status').textContent;}}
$('connect').onclick=()=>{token=val('token');$<HTMLInputElement>('token').value='';void run(load);};
$('character').onchange=()=>{collect();current=characters.findIndex(c=>c.id===val('character'));fill();void run(preview);};
$('save').onclick=()=>void run(async()=>{collect();await api('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(characters)});$<HTMLTextAreaElement>('advanced').value=JSON.stringify(characters,null,2);await preview();$('status').textContent='已保存。新开启的对话会使用这份配置；已有对话保持原来的人物设定。';});
for(const id of ['expression','scene','outfit'])$(id).onchange=()=>void run(preview);
for(const [input,kind] of [['portrait','expressions'],['background','scenes']] as const)$(input).onchange=()=>void run(async()=>{
 const file=$<HTMLInputElement>(input).files?.[0];if(!file)return;const result=await api('/api/assets',{method:'POST',headers:{'Content-Type':file.type},body:file});
 const c=characters[current]!;if(kind==='expressions')c.expressions[val('expression')]!.asset=result.asset;else c.scenes[val('scene')]!.background=result.asset;
 $('status').textContent='素材已上传。点击“保存并预览”将其绑定到当前表情或场景。';
});
$('export').onclick=()=>{collect();const url=URL.createObjectURL(new Blob([JSON.stringify(characters,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='characters.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('import-button').onclick=()=>$('import').click();
async function apply(input:unknown){await api('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});await load();$('status').textContent='角色配置已更新。';}
$('import').onchange=()=>void run(async()=>{const file=$<HTMLInputElement>('import').files?.[0];if(file)await apply(JSON.parse(await file.text()));});
$('apply-advanced').onclick=()=>void run(()=>apply(JSON.parse(val('advanced'))));
$<HTMLIFrameElement>('preview').onload=()=>{if(characters.length)void run(preview);};
void run(load);
