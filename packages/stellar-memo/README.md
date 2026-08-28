# Stellar memo

Dependency-free parsing and canonical formatting for Stellar memo values. This
package performs no transaction construction, persistence, or network access.

Canonical strings are `none`, `text:<UTF-8 text>`, `id:<unsigned decimal>`,
`hash:<64 lowercase hex characters>`, and `return:<64 lowercase hex characters>`.
Text values are limited to 28 UTF-8 bytes and hash values are always 32 bytes.

```ts
import { formatMemo, parseMemo } from "@guildpass/stellar-memo";

const memo = parseMemo("text:GuildPass");
formatMemo(memo); // "text:GuildPass"
```
