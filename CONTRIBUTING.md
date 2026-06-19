# Contributing to MCP Switch

Thanks for your interest! MCP Switch is a small, self-hosted MCP aggregation gateway.
Contributions — bug reports, fixes, docs, translations — are welcome.

## Development setup

```bash
pnpm install
cp .env.example .env          # leave MCP_PUBLIC_URL empty for an anonymous local /mcp
pnpm dev                      # gateway :4200 + console :5173
```

Monorepo layout: `apps/{mcp-gateway,console-web}`, `packages/{schemas,config}`.

## Before opening a PR

```bash
pnpm typecheck     # all packages must pass
pnpm test          # gateway test suite (incl. an upstream→gateway e2e)
pnpm build         # must build clean
```

Please keep PRs focused, match the surrounding code style, and add a test when you
fix a bug or add behavior.

## Translations

The console UI ships English / 简体中文 / 日本語. Strings live in
`apps/console-web/src/i18n/locales.ts` — one key per UI string, with `en` as the
fallback. To add or fix a language, edit that file; no other wiring is needed.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, and the
`mcp-switch` version / commit. For anything security-sensitive (auth, OAuth, token
handling), please disclose privately rather than in a public issue.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
