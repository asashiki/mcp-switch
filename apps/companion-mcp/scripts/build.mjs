import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/server.ts'],outfile:'dist/server.js',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external'});
for(const name of ['stage','admin']) {
  const result=await build({entryPoints:[`web/${name}.ts`],bundle:true,platform:'browser',format:'iife',target:'es2022',write:false,minify:true});
  const html=await readFile(`web/${name}.html`,'utf8');
  await writeFile(`dist/${name}.html`,html.replace('<!-- SCRIPT -->',()=>`<script>${result.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`));
}
