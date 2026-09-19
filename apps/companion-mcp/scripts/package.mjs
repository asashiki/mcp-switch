import { build } from "esbuild";
import { builtinModules } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  rm,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
await import("./build.mjs");
const output = resolve(process.argv[2] || "../../artifacts");
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "companion-package-"));
const stage = join(temp, "companion-mcp");
try {
  await mkdir(join(stage, "dist"), { recursive: true });
  await mkdir(join(stage, "examples"));
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/server.ts"],
    outfile: join(stage, "dist/server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    metafile: true,
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    legalComments: "eof",
  });
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/, "")),
  );
  for (const file of Object.values(result.metafile.outputs))
    for (const item of file.imports)
      if (item.external && !builtins.has(item.path.replace(/^node:/, "")))
        throw new Error(`Runtime dependency not bundled: ${item.path}`);
  for (const name of ["stage.html", "admin.html"])
    await copyFile(join(root, "dist", name), join(stage, "dist", name));
  await copyFile(
    join(root, "examples/characters.json"),
    join(stage, "examples/characters.json"),
  );
  await copyFile(join(root, ".env.example"), join(stage, ".env.example"));
  await copyFile(join(root, "../../LICENSE"), join(stage, "LICENSE"));
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify(
      {
        name: "companion-mcp-runtime",
        private: true,
        type: "module",
        engines: { node: ">=24" },
        scripts: { start: "node --env-file-if-exists=.env dist/server.mjs" },
      },
      null,
      2,
    ) + "\n",
  );
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  await writeFile(
    join(stage, "VERSION.json"),
    JSON.stringify(
      {
        sourceCommit: sha,
        sourceDirty: dirty,
        nodeMinimum: 24,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(stage, "START-HERE.md"),
    `# Companion MCP 运行包\n\n无需安装 npm 依赖或编译；需要 Node.js 24 或更高版本。\n\n1. 复制 .env.example 为 .env，替换 COMPANION_TOKEN。\n2. 在解压目录执行 npm start（或 node --env-file-if-exists=.env dist/server.mjs）。\n3. 打开 http://127.0.0.1:4588/admin，输入访问密钥，设置人设并上传立绘。\n4. Switch 添加 http://127.0.0.1:4588/mcp，Authorization: Bearer <COMPANION_TOKEN>。\n\n真实出图：在本机 .env 填 NOVELAI_API_TOKEN，并设置 COMPANION_GENERATION_ENABLED=true。不会自动读取或上传你的其他凭据。\n远程使用：COMPANION_PUBLIC_URL 填真实 HTTPS origin，由反向代理将该域名转发到 :4588。Docker 网络使用服务名时，在 COMPANION_ALLOWED_HOSTS 配置精确服务名。\n\n所有角色、历史场景和图片保存在 data/companion。更新时停止服务，保留整个 data 目录和 .env，只替换 dist 与其他程序文件。不要用新 examples 覆盖已在设置页保存的角色。\n\n此包没有 NAI Token、用户私聊或角色图片。NAI 真实出图和 ChatGPT / Claude 宿主显示仍需你的连接器实测。\n\n源码与完整部署说明：https://github.com/asashiki/mcp-switch/tree/feat/companion-mcp/apps/companion-mcp\n构建来源：${sha}；构建时工作区有改动：${dirty}\n`,
  );
  const dependencies = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes("node_modules")) continue;
    let directory = dirname(resolve(root, input));
    while (directory !== dirname(directory)) {
      try {
        const pkg = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        if (pkg.name) {
          dependencies.set(`${pkg.name}@${pkg.version}`, { directory, pkg });
          break;
        }
      } catch {}
      directory = dirname(directory);
    }
  }
  let notices = "Bundled dependency notices\n==========================\n";
  for (const [name, { directory, pkg }] of [...dependencies].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    notices += `\n${name}\nDeclared license: ${pkg.license || "See source"}\n`;
    for (const file of await readdir(directory))
      if (/^(licen[sc]e|copying|notice)(\.|$)/i.test(file)) {
        try {
          notices += `\n${file}\n${await readFile(join(directory, file), "utf8")}\n`;
        } catch {}
      }
  }
  await writeFile(join(stage, "THIRD_PARTY_LICENSES.txt"), notices);
  const archive = join(output, "companion-mcp-runtime.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", temp, "companion-mcp"]);
  const hash = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(
    join(output, "SHA256SUMS"),
    `${hash}  ${basename(archive)}\n`,
  );
  console.log(
    JSON.stringify({
      archive,
      sha256: hash,
      sourceCommit: sha,
      sourceDirty: dirty,
    }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
