# Third-party notices — dsh-unslop

This plugin vendors the unslop skill from **heydamir/unslop**:

- Source: https://github.com/heydamir/unslop
- Author: Damir Sokolovsky ([@heydamir](https://x.com/heydamir), https://heydamir.design/unslop)
- License: **CC BY 4.0** — see `LICENSE-unslop-CC-BY-4.0.txt`

Vendored verbatim under `skills/unslop/`:

- `SKILL.md` (the workflow method)
- `references/signs.md`, `tokens.md`, `visuals.md`, `refs.md`, `effects.md`, `rtl.md`
- `scripts/snapshot.mjs`, `scripts/story.mjs`, `scripts/story-path.mjs`

The MCP server (`mcp/server.mjs`), the host bridge (`host/index.js`, `host/mcp-client.js`) and the
packaging around it are original to this plugin (MIT). Per CC BY 4.0, the unslop credit
(`unslop by @heydamir`) is kept in the skill, the generated story videos, and this notice.

Attribution requirement: any redistribution or adaptation of the unslop skill content must credit
Damir Sokolovsky and link back to the repository above.
