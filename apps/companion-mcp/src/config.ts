import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const tags = z.string().max(6000);
const asset = z.string().regex(/^[a-zA-Z0-9_-]+\.(png|jpg|webp)$/);
export const characterSchema = z.object({
  id, name: z.string().min(1).max(80), persona: tags.default(''),
  characterPrompt: tags.min(1), stylePrompt: tags.default(''), negativePrompt: tags.default(''),
  characterNegativePrompt: tags.default(''), defaultExpression: id.default('neutral'), defaultScene: id,
  expressions: z.record(id, z.object({prompt: tags, asset: asset.optional()})),
  scenes: z.record(id, z.object({name: z.string().max(80), prompt: tags, background: asset.optional()})),
  outfits: z.record(id, tags), defaultOutfit: id,
  generation: z.object({
    model: z.string().min(1).max(100).default('nai-diffusion-4-5-full'),
    width: z.number().int().min(64).max(1536).multipleOf(64).default(1216),
    height: z.number().int().min(64).max(1536).multipleOf(64).default(832),
    steps: z.number().int().min(1).max(28).default(28), scale: z.number().min(0).max(10).default(5),
    sampler: z.enum(['k_euler_ancestral','k_euler','k_dpmpp_2m','k_dpmpp_sde']).default('k_euler_ancestral'),
    noiseSchedule: z.enum(['karras','native','exponential']).default('karras')
  }).default({model:'nai-diffusion-4-5-full',width:1216,height:832,steps:28,scale:5,sampler:'k_euler_ancestral',noiseSchedule:'karras'})
}).superRefine((c, ctx) => {
  for (const [field, collection] of [['defaultExpression','expressions'],['defaultScene','scenes'],['defaultOutfit','outfits']] as const) {
    if (!Object.hasOwn(c[collection], c[field])) ctx.addIssue({code:'custom',message:`${field} must exist in ${collection}`,path:[field]});
  }
  if(c.generation.width*c.generation.height>1_048_576) ctx.addIssue({code:'custom',message:'Maximum one megapixel in v0.1',path:['generation']});
});
export type Character = z.infer<typeof characterSchema>;
export function loadCharacters(file: string): Character[] {
  const chars = z.array(characterSchema).min(1).parse(JSON.parse(readFileSync(file,'utf8')));
  if (new Set(chars.map(c=>c.id)).size !== chars.length) throw new Error('Duplicate character ID');
  return chars;
}
export function loadConfig(env = process.env) {
  const port = z.coerce.number().int().min(1).max(65535).parse(env.COMPANION_PORT ?? '4588');
  const publicUrl = new URL(env.COMPANION_PUBLIC_URL || `http://127.0.0.1:${port}`).origin;
  if (!['http:','https:'].includes(new URL(publicUrl).protocol)) throw new Error('Invalid public URL');
  const host = env.COMPANION_HOST || '127.0.0.1';
  if (!['127.0.0.1','localhost','::1'].includes(host) && !env.COMPANION_TOKEN) throw new Error('COMPANION_TOKEN required for non-loopback binding');
  return {port,host,publicUrl,token:env.COMPANION_TOKEN || '',naiToken:env.NOVELAI_API_TOKEN || '',
    dataDir:resolve(env.COMPANION_DATA_DIR || './data/companion'),
    charactersFile:resolve(env.COMPANION_CHARACTERS || './examples/characters.json'),
    dailyLimit:z.coerce.number().int().min(0).max(100).parse(env.COMPANION_DAILY_LIMIT ?? '10'),
    generationEnabled:env.COMPANION_GENERATION_ENABLED === 'true'};
}
export type Config = ReturnType<typeof loadConfig>;
