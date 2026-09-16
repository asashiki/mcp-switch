import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { characterSchema, type Character, type Config } from "./config.js";
import { Store, type Scene, type Job } from "./store.js";
import { Worker, compilePrompt, publicJob } from "./novelai.js";

export class Companion {
  readonly store: Store;
  readonly worker: Worker;
  private key: string;
  constructor(
    readonly config: Config,
    private characters: Character[],
    provider?: ConstructorParameters<typeof Worker>[2],
  ) {
    this.store = new Store(config.dataDir);
    const saved = this.store.setting("characters");
    if (saved) this.characters = characterSchema.array().parse(saved);
    this.key =
      (this.store.setting("media-key") as string) ||
      randomBytes(32).toString("hex");
    this.store.setSetting("media-key", this.key);
    this.worker = new Worker(this.store, config, provider);
  }
  catalog() {
    return this.characters.map((c) => ({
      id: c.id,
      name: c.name,
      expressions: Object.keys(c.expressions),
      scenes: Object.entries(c.scenes).map(([id, s]) => ({ id, name: s.name })),
      outfits: Object.keys(c.outfits),
    }));
  }
  getCharacters() {
    return this.characters;
  }
  saveCharacters(input: unknown) {
    const chars = characterSchema.array().min(1).parse(input);
    if (new Set(chars.map((c) => c.id)).size !== chars.length)
      throw new Error("Duplicate character ID");
    this.store.setSetting("characters", chars);
    this.characters = chars;
  }
  character(id: string) {
    const c = this.characters.find((c) => c.id === id);
    if (!c) throw new Error("Character not found");
    return c;
  }
  signed(path: string) {
    const expires = String(Math.floor(Date.now() / 1000) + 7 * 86400);
    const sig = createHmac("sha256", this.key)
      .update(`${path}:${expires}`)
      .digest("hex");
    return `${this.config.publicUrl}${path}?expires=${expires}&sig=${sig}`;
  }
  verify(path: string, expires: unknown, sig: unknown) {
    if (
      typeof expires !== "string" ||
      typeof sig !== "string" ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() / 1000 ||
      !/^[a-f0-9]{64}$/.test(sig)
    )
      return false;
    const want = createHmac("sha256", this.key)
      .update(`${path}:${expires}`)
      .digest();
    return timingSafeEqual(want, Buffer.from(sig, "hex"));
  }
  asset(name?: string) {
    return name && existsSync(join(this.config.dataDir, "assets", name))
      ? this.signed(`/media/${name}`)
      : undefined;
  }
  view(s: Scene) {
    const c = s.character,
      expression = c.expressions[s.expression]!;
    const scene = c.scenes[s.sceneId]!;
    const spriteUrl = this.asset(expression.asset);
    const defaultUrl = this.asset(c.expressions[c.defaultExpression]?.asset);
    return {
      sessionId: s.sessionId,
      revision: s.revision,
      name: c.name,
      mode: s.mode,
      expression: s.expression,
      sceneId: s.sceneId,
      sceneName: scene.name,
      outfit: s.outfit,
      line: s.line,
      spriteUrl: spriteUrl ?? defaultUrl,
      backgroundUrl: this.asset(scene.background),
      fallback: !spriteUrl
        ? "No approved image for this expression; using default portrait or text."
        : null,
    };
  }
  sceneResult(s: Scene) {
    const view = this.view(s);
    const chosen = s.character.expressions[s.expression]?.asset;
    const filename =
      chosen && existsSync(join(this.config.dataDir, "assets", chosen))
        ? chosen
        : s.character.expressions[s.character.defaultExpression]?.asset;
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: JSON.stringify(view) }];
    if (filename && existsSync(join(this.config.dataDir, "assets", filename))) {
      const bytes = readFileSync(join(this.config.dataDir, "assets", filename));
      if (bytes.length < 2 * 1024 * 1024)
        content.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType: filename.endsWith(".jpg")
            ? "image/jpeg"
            : filename.endsWith(".webp")
              ? "image/webp"
              : "image/png",
        });
    }
    return { structuredContent: view, content };
  }
  jobView(job: Job) {
    return {
      ...publicJob(job),
      imageUrl: this.asset(job.asset),
      pollUrl: this.signed(`/jobs/${job.id}`),
    };
  }
  illustrationResult(owner: string, job: Job) {
    const scene = this.view(
      this.store.scene(owner, job.sessionId, job.revision),
    );
    const data = { scene, job: this.jobView(job) };
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: JSON.stringify(data) }];
    if (job.status === "succeeded" && job.asset) {
      const bytes = readFileSync(
        join(this.config.dataDir, "assets", job.asset),
      );
      if (bytes.length < 2 * 1024 * 1024)
        content.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType: "image/png",
        });
      else
        content.push({
          type: "text",
          text: `Scene illustration: ${data.job.imageUrl}`,
        });
    }
    return { content, structuredContent: data };
  }
  request(
    owner: string,
    input: {
      sessionId: string;
      revision: number;
      eventId: string;
      composition: string;
      seed?: number;
      generate: boolean;
    },
  ) {
    const s = this.store.scene(owner, input.sessionId, input.revision);
    // Stable seed derives from the event when absent, so a lost response can be safely retried.
    const seed =
      input.seed ??
      Number.parseInt(
        createHmac("sha256", this.key)
          .update(`${input.sessionId}:${input.eventId}`)
          .digest("hex")
          .slice(0, 8),
        16,
      );
    const request = compilePrompt(s, input.composition, seed);
    if (!input.generate)
      return {
        scene: this.view(s),
        preview: request,
        generationEnabled: this.config.generationEnabled,
        providerConfigured: !!this.config.naiToken,
      };
    if (!this.config.generationEnabled || !this.config.naiToken)
      throw new Error(
        "Generation is disabled or NOVELAI_API_TOKEN is missing; use generate=false to preview",
      );
    const job = this.store.enqueue(
      owner,
      input.eventId,
      s,
      request,
      this.config.dailyLimit,
    );
    void this.worker.kick();
    return { scene: this.view(s), job: this.jobView(job) };
  }
  async close() {
    await this.worker.idle();
    this.store.close();
  }
}
