# Stellar network configuration

`@guildpass/stellar-network-config` parses caller-supplied Stellar network
settings into a small, canonical model. It is deliberately transport-free:
it does not create clients, read environment variables, or perform HTTP/RPC
requests.

```ts
import { parseStellarNetworkConfig, STELLAR_TESTNET_PASSPHRASE } from "@guildpass/stellar-network-config";

const result = parseStellarNetworkConfig({
  passphrase: STELLAR_TESTNET_PASSPHRASE,
  rpcUrl: "https://soroban-testnet.stellar.org/",
});
```

## Canonicalisation rules

- Known passphrases map only to `"testnet"` and `"public"`; hostnames are
  never used to infer a network.
- Custom networks must be requested explicitly with `network: "custom"` and
  a non-empty, non-known passphrase.
- RPC and Horizon URLs may use only `https:` or `http:`. Credentials are
  rejected. Fragments are removed; query strings are preserved.
- Trailing slashes are removed from non-root paths. A root URL retains its
  standard `/` pathname (`https://rpc.example/`).

Failures are returned as structured `StellarNetworkConfigValidationError`
objects, so callers can decide how to surface them without parsing messages.
