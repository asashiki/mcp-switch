import { randomInt } from "node:crypto";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Scene, Store, Job } from "./store.js";
import type { Config } from "./config.js";

export function compilePrompt(s: Scene, composition: string, seed: number) {
  const c = s.character,
    g = c.generation;
  const base = [c.stylePrompt, c.scenes[s.sceneId]!.prompt, composition]
    .filter(Boolean)
    .join(", ");
  const character = [
    c.characterPrompt,
    c.outfits[s.outfit],
    c.expressions[s.expression]!.prompt,
    s.action,
  ]
    .filter(Boolean)
    .join(", ");
  const full = [base, character].filter(Boolean).join(", ");
  return {
    input: full,
    model: g.model,
    action: "generate",
    parameters: {
      params_version: 3,
      width: g.width,
      height: g.height,
      steps: g.steps,
      scale: g.scale,
      sampler: g.sampler,
      noise_schedule: g.noiseSchedule,
      seed,
      n_samples: 1,
      image_format: "png",
      qualityToggle: false,
      ucPreset: 0,
      negative_prompt: [c.negativePrompt, c.characterNegativePrompt]
        .filter(Boolean)
        .join(", "),
      v4_prompt: {
        caption: {
          base_caption: base,
          char_captions: [
            { char_caption: character, centers: [{ x: 0.5, y: 0.5 }] },
          ],
        },
        use_coords: false,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: {
          base_caption: c.negativePrompt,
          char_captions: [
            {
              char_caption: c.characterNegativePrompt,
              centers: [{ x: 0.5, y: 0.5 }],
            },
          ],
        },
        use_coords: false,
        use_order: true,
      },
      legacy: false,
      sm: false,
      sm_dyn: false,
      dynamic_thresholding: false,
      cfg_rescale: 0,
    },
  };
}
export const newSeed = () => randomInt(0, 0x100000000);
export async function generate(
  token: string,
  request: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const response = await fetcher(
    "https://image.novelai.net/ai/generate-image",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(
      `NovelAI HTTP ${response.status}; request was not automatically retried`,
    );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("NovelAI did not return negotiated JSON images");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("NovelAI returned an empty body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 20 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("NovelAI response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    images?: Array<{ image?: string }>;
  };
  const encoded = body.images?.[0]?.image;
  if (typeof encoded !== "string")
    throw new Error("NovelAI response has no image");
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("NovelAI did not return PNG data");
  return bytes;
}
export class Worker {
  private active?: Promise<void>;
  constructor(
    private store: Store,
    private config: Config,
    private provider = generate,
  ) {
    // Never replay a request whose remote billing outcome is unknown.
    for (const j of store.jobs())
      if (j.status === "running") {
        j.status = "interrupted";
        j.error =
          "Service stopped during generation; outcome unknown. No automatic retry.";
        store.updateJob(j);
      }
  }
  kick() {
    if (!this.active)
      this.active = this.run().finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  async idle() {
    await this.active;
  }
  private async run() {
    if (!this.config.generationEnabled || !this.config.naiToken) return;
    for (;;) {
      const job = this.store.jobs().find((j) => j.status === "queued");
      if (!job) return;
      job.status = "running";
      this.store.updateJob(job);
      try {
        const bytes = await this.provider(this.config.naiToken, job.request);
        const name = `${job.id}.png`;
        const target = join(this.config.dataDir, "assets", name);
        await writeFile(`${target}.tmp`, bytes, { mode: 0o600 });
        await rename(`${target}.tmp`, target);
        job.asset = name;
        job.status = "succeeded";
      } catch (e) {
        job.status = "failed";
        job.error =
          e instanceof Error && e.message.startsWith("NovelAI ")
            ? e.message
            : "Generation failed; no automatic retry. Check provider connectivity.";
      }
      this.store.updateJob(job);
    }
  }
}
export function publicJob(job: Job) {
  const { request, ...publicFields } = job;
  return publicFields;
}
