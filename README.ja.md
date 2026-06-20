<div align="center">

# MCP Switch

**1 つの MCP エンドポイントで、ローカルとリモートのすべての MCP を集約。**

セルフホスト型のゲートウェイ。ローカル**と**リモートの MCP サーバーを、
OAuth で保護された 1 つのエンドポイントに集約し、MCP を話せるあらゆる AI
（claude.ai、ChatGPT など）へ公開します。

![license](https://img.shields.io/badge/license-MIT-e96ba8)
![node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)
![status](https://img.shields.io/badge/status-beta-8b8bef)

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語**

🔗 **[ライブコンソールデモ](https://show.asashiki.com/console/)** · 📖 **[ユーザーマニュアル](docs/manual.md)**

</div>

---

## なぜ

Web/App の AI は**リモート** MCP にしか接続できず、しかもカスタムコネクタの枠は
たいてい**1 つ**だけ。一方で便利な MCP の多くは**ローカル**の stdio プロセス
（`npx`/`uvx`）で、Claude Desktop / CLI からしか起動できません。

MCP Switch はその間に入ります：

```
   ローカル stdio MCP  ─┐
                       ┼──►  MCP Switch  ──►  1 つの OAuth URL  ──►  claude.ai / ChatGPT / …
   リモート HTTP MCP   ─┘     (あなたの VPS)
```

- 任意の数の MCP——リモート（URL）でもローカル（stdio、自分のマシンでホスト）でも——を 1 つのエンドポイントに**集約**。
- **一度つなぐだけ。** AI には 1 つのコネクタだけが見え、その背後にすべてのツールがあります。
- **コンソールで管理**——サーバー追加、ツールのグループ化、agent ごとの表示範囲、監査ログ。
- **純粋な中継。** MCP Switch 自体はツールを持たず、ツール・スキーマ・結果、さらに MCP Apps の UI ウィジェットまでそのまま転送します。

## アーキテクチャ

**単一サービス**（`:4577`）＋ それがホストするコンソール SPA：

| 構成要素 | 役割 |
|---|---|
| MCP ゲートウェイ | 公開 MCP エンドポイント（`/mcp`）、OAuth 2.1、管理コンソール（`/console`） |
| Registry | 上流 MCP サーバーへプロセス内で接続——リモート（HTTP）とローカル（stdio） |
| Store | 1 つの SQLite：agents・OAuth・監査・スキルレジストリ・サーバーレジストリ |

別個のバックエンドもサービス間 HTTP もなし——ゲートウェイが直接上流に接続し集約します。

## クイックスタート（Docker）

```bash
git clone https://github.com/asashiki/mcp-switch.git
cd mcp-switch
cp .env.example .env
# .env を編集 → MCP_PUBLIC_URL を設定すると OAuth + コンソールが有効（空ならローカル匿名）

docker compose -f infra/docker/compose.yaml --env-file .env up -d --build
```

そのあと：

- ヘルスチェック：`curl http://127.0.0.1:4577/health`
- コンソール：`http://127.0.0.1:4577/console` を開く（先にパスワード設定。下記参照）

> リバースプロキシ越し？ `.env` で `MCP_PUBLIC_URL` と `MCP_GATEWAY_BIND_HOST=0.0.0.0` を設定。

### コンソールのパスワード設定

```bash
docker compose -f infra/docker/compose.yaml exec mcp-switch \
  node dist/cli/console-admin.js set admin "あなたのパスワード"
```

## クイックスタート（ローカル開発）

```bash
pnpm install
cp .env.example .env          # MCP_PUBLIC_URL は空のまま → 匿名ローカル /mcp
pnpm dev                      # ゲートウェイ :4577 + コンソール :5173
```

`MCP_PUBLIC_URL` 未設定だと匿名の `/mcp` が提供され、OAuth を組む前のお試しに便利です。

## AI を接続する

claude.ai → 設定 → コネクタ → **カスタムコネクタを追加**、宛先：

```
https://<あなたの MCP_PUBLIC_URL>/mcp
```

OAuth ログインを完了（同意画面で agent ID を選択）。集約されたツールがクライアントに現れます。

## 上流 MCP サーバーを追加

コンソール → **接続**。2 通り：

**リモート（HTTP）。** サーバー URL を貼り付け、必要なら header（API キーなど）や OAuth を追加。例——Context7：

```json
{ "mcpServers": { "context7": {
  "serverUrl": "https://mcp.context7.com/mcp",
  "headers": { "CONTEXT7_API_KEY": "..." }
}}}
```

**ローカル（stdio）。** MCP Switch がサーバー上でプロセスを起動し、リモート公開します。例——`npx` で Steam MCP：

```json
{ "mcpServers": { "steam": {
  "command": "npx",
  "args": ["-y", "steam-mcp-server"],
  "env": { "STEAM_API_KEY": "..." }
}}}
```

どちらの JSON もコンソールのインポート欄に貼るだけで、transport を自動判別してフォームに反映します。
イメージには Node/`npx` が同梱。`uvx`/Python のサーバーを動かすには、対応ランタイムをイメージに追加してください。

## 設定

すべて `.env` 経由（[`.env.example`](.env.example) 参照）：

| 変数 | 用途 |
|---|---|
| `MCP_PUBLIC_URL` | 公開 origin。**設定すると OAuth + コンソールが有効**、空 = 匿名ローカル `/mcp` |
| `MCP_AUTH_DB_PATH` | SQLite ファイル（agents・OAuth・監査・スキル・サーバーレジストリ） |
| `MCP_OAUTH_SCOPE` | クライアントへ広告する OAuth スコープ |
| `REMOTE_MCP_SERVERS_JSON` | 任意：上流サーバーを事前登録（コンソール追加の代わり） |
| `MCP_GATEWAY_BIND_HOST` | リバースプロキシ越しなら `0.0.0.0` |

## ドキュメント

- 📖 [使用マニュアル](docs/manual.md) —— コンソールの手順解説。

## 開発

```bash
pnpm typecheck      # 全パッケージ
pnpm test           # ゲートウェイのテスト（上流→ゲートウェイの e2e を含む）
pnpm build          # 全体ビルド
```

モノレポ：`apps/{mcp-gateway,console-web}`、`packages/{schemas,config}`。

## ライセンス

[MIT](LICENSE)
