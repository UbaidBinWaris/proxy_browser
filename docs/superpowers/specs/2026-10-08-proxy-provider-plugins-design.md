# Proxy provider plugins — design (Phase 1a)

Status: draft for review · 2026-10-08

## Goal

Let the app use proxy providers other than DataImpulse for geo-targeted, sticky
and rotating launches, with the same exit-IP verification. Success:

- A profile, Quick Launch, QA scenario, and CLI run can each select a provider.
- Adding a provider means adding one dialect file plus its tests. No changes to
  the launcher, browser manager or QA runtime.
- Existing installs upgrade without losing credentials, profiles, history,
  backups or exported CI manifests.

Phase 1b (Docker runner and GitHub Action) and 1c (MCP server) get their own
specs. They come after this one so that both are provider-neutral from the start.

## Non-goals

- Targeting outside the US. `GeoTarget` and the GeoNames catalog stay US-only.
  Capabilities are shaped so that international support can be added later.
- Loading provider code at runtime from npm packages or user folders. Providers
  are built-in modules added through pull requests. A dialect has access to
  credentials, so third-party code must not be loaded into that path.
- Merging QA "custom gateways" (`src/main/qa/gateways.ts`) into the registry.
  They keep working unchanged. Unifying them is a follow-up.
- Anything that evades bot detection (see CONTRIBUTING.md scope).

## Current state

The full coupling map is from the exploration done on 2026-10-08.

- The seam already exists. `ProxyProvider` (`src/main/contracts.ts:246`) is the
  only dependency of `ProxyManager`, `Launcher` and `BrowserManager`, apart from
  three helper imports.
- All DataImpulse syntax is in `src/main/proxy/providers/dataimpulse.ts`.
  Roughly 60% of that class is generic gateway handling: per-pool credentials,
  status, connection and credential tests, IP lookup.
- The hard coupling is in stored formats:
  - `ProxyMode = 'none' | 'dataimpulse-sticky' | 'dataimpulse-rotating'`,
    persisted in SQLite, QA backups and CLI manifests;
  - vault payload v2, keyed only by `ProxyPool`;
  - the fixed `PROXY_POOLS` enum;
  - `proxy_sessions.provider`, hard-coded to `'dataimpulse'`;
  - the global `settings.targetingEncoding`.

## Design

### 1. Dialect plus a shared gateway base

Split the current class into two parts.

**`ProviderDialect`** is pure, stateless and synchronous. It holds only what
differs between providers:

```ts
interface ProviderDialect {
  readonly id: ProviderId                    // 'dataimpulse' | 'brightdata' | …
  readonly displayName: string
  readonly docsUrl: string                   // official parameter docs
  readonly capabilities: ProviderCapabilities
  /** Full connection for a request. Targeting may go in the username OR the password. */
  compose(credentials: ProviderCredentials, request: ProxyRequest): ComposedConnection
  createSession(profileName: string): string
  rotateSession(current: string | null, profileName: string): string
  /** Optional: is this failure worth re-rolling the session (e.g. exhausted location pool)? */
  isRetryableLocationFailure?(error: AppError): boolean
}

// Existing ProxyCredentials with `pool` renamed to `product`, plus provider-specific extras.
interface ProviderCredentials extends Omit<ProxyCredentials, 'pool'> {
  product: ProductKey
  extras: Record<string, string>
}
// ProxyRequest / ProxyConnection: `pool` is renamed to `product` in the same way.

interface ComposedConnection {
  server: string; username: string; password: string
  targetingString: string                    // human-readable, never contains secrets
}
```

**`GatewayProvider`** implements the existing `ProxyProvider` for any dialect.
It contains the code moved unchanged from `DataImpulseProvider`:
- the product → credentials map;
- `setCredentials`, `getConfigStatus`, `testConnection`, `testCredentials`, `getCurrentIp`;
- secret registration.

It registers the **composed** password as a secret too, because some providers
put parameters there.

**`ProviderRegistry`** maps `ProviderId → GatewayProvider`. `ProxyManager`
resolves the provider for each request from `profile.providerId`.
`ProxyProvider.name` widens from `'dataimpulse'` to `ProviderId`.

### 2. Capabilities descriptor

```ts
interface ProviderCapabilities {
  products: { key: string; label: string; billingNote?: string }[]   // replaces fixed PROXY_POOLS
  targetModes: ('country' | 'state' | 'city' | 'zip')[]
  sticky: { supported: boolean; ttlMinutes?: { min: number; max: number }; idPattern: string; idMaxLength: number }
  defaults: { host: string; port: number }
  extraCredentialFields: { key: string; label: string; secret: boolean }[]   // e.g. Bright Data zone
  stateAllowlist?: string[]                  // DataImpulse's published state list
  encodingOptions?: string[]                 // DataImpulse targetingEncoding moves here
}
```

The renderer, launcher warnings ("billed at 2×") and `locations.random()` read
capabilities through IPC instead of constants.

### 3. Data model changes

| Item | Change |
|---|---|
| `ProxyMode` | `'none' \| 'sticky' \| 'rotating'`. A Zod preprocess maps `dataimpulse-*` to the new values when reading the DB, backups and CLI manifests, so old exports keep working. |
| `ProxyPool` | Becomes `ProductKey = string` (`/^[a-z0-9-]{1,32}$/`), validated against the provider's capabilities at runtime. |
| Profile | New `providerId` field, default `'dataimpulse'`. |
| `settings.targetingEncoding` | Moves into per-provider options. The existing value migrates to the DataImpulse options. |
| **DB migration 8** | Rewrite `profiles.proxy_mode` values. Add `profiles.provider_id` and `test_runs.provider`, both `DEFAULT 'dataimpulse'`. Stop hard-coding `proxy_sessions.provider` in the repository. |
| **Vault payload v3** | `{ v: 3, providers: { [id]: { products: { [key]: { host, port, username, password, sessionTemplate, extras } } } } }`. On load, v2 migrates to `providers.dataimpulse`, following the existing legacy-to-v2 precedent at `credential-vault.ts:376`. Before rewriting, the v2 file is copied to `vault.v2.bak`, because older builds cannot read v3. |

### 4. Moving neutral helpers out

`encodePlaceName`, `encodeStateName` and the "not configured" messages are used
by neutral code (`proxy-manager.ts:48`, `locations-service.ts:33`,
`launcher.ts:27`). They move to `src/main/proxy/targeting-text.ts`. DataImpulse
re-exports them for its own use.

User-facing strings that name DataImpulse change to the provider's
`displayName`:
- `ip-checker.ts:57`
- `error-mapping.ts:81`
- `launcher.ts:38`
- about 14 renderer components

### 5. First providers

Ship in this order. Each one is a dialect file plus a golden-table test.
Syntax must be copied from the provider's official docs at implementation time,
not from memory, and the docs URL goes in the file header.

1. **DataImpulse.** Port the existing code with identical output. The existing
   47 username tests must pass unchanged.
2. **Bright Data.** Parameters go in the username. It needs an extra credential
   field (zone).
3. **Oxylabs.** Parameters go in the username.
4. **Decodo (formerly Smartproxy).** Parameters go in the username.
5. **IPRoyal.** Parameters go in the **password**. This proves that `compose`
   returning a full connection is the right shape.

Other providers (SOAX, NetNut, and others) are contributed by the community
through the documented path in CONTRIBUTING.md.

### 6. UI changes

- **Manage proxy keys window.** A provider picker comes first. Product tabs come
  from capabilities, and extra fields (such as the zone) render dynamically.
  Default host and port come from capabilities.
- **Profile editor and Quick Launch.** Add a provider select. Show only products
  that are configured. Hide target modes the provider does not support.
- **Status card, run detail, history.** Show "<Provider> · <product>".

### 7. CLI

| Variable | Meaning |
|---|---|
| `QA_PROVIDER` | Provider id |
| `QA_PROVIDER_PRODUCT` | Product key |
| `QA_PROVIDER_HOST`, `_PORT`, `_USERNAME`, `_PASSWORD` | Connection and credentials |
| `QA_PROVIDER_EXTRA_<KEY>` | Extra credential fields (such as the zone) |

- `DATAIMPULSE_PROXY_*` stays as a documented alias.
- Credentials are still removed from `process.env` before browsers launch.

## Error handling

- An unknown `providerId` on a stored profile fails with `INVALID_INPUT`, naming
  the provider. The profile is never silently switched to another provider.
- A product the provider does not offer fails with `PROXY_NOT_CONFIGURED`, using
  the provider's product label.
- Re-roll on location mismatch keeps the existing loop. The early stop on HTTP
  503 (currently assumed to mean "location pool exhausted") applies only when
  `isRetryableLocationFailure` says so, so DataImpulse behaviour is unchanged.
- If the vault migration fails, the v2 file and the `.bak` copy are left
  untouched and a `VAULT_ERROR` names the backup path.

## Testing

- **Dialect contract suite**, run against every registered dialect:
  - the session id matches `idPattern` and `idMaxLength`;
  - `rotateSession` always returns a different id;
  - `targetingString` never contains the password;
  - `compose` is deterministic;
  - every target mode the dialect declares changes the output.
- **Golden tables per dialect** map request → `{username, password, server}`,
  taken from the provider's documented examples.
- **Migrations:** DB v7 → v8 on a fixture DB; vault v2 → v3, including the
  `.bak` copy and a simulated write failure; v1.3.0 QA backups and CLI
  manifests with `dataimpulse-*` modes still load.
- **Existing suites:** `dataimpulse.test.ts`, `proxy-manager.test.ts` and
  `browser-manager.test.ts` must pass with assertion changes limited to renamed
  types.
- **Live check:** an e2e run with the real DataImpulse account (redacted
  output). Other providers are live-tested only where you have an account. Until
  then they are labelled "community-verified" in the provider picker.

## Rollout

1. Refactor to dialect + `GatewayProvider` + registry, with DataImpulse only.
   Nothing changes for users. Ship as 1.4.0.
2. Add the migrations, the UI picker and the CLI variables. Ship as 1.5.0.
3. Add the other providers one pull request at a time.

## Open questions

- Which non-DataImpulse provider does the company actually hold an account
  with? That one should be implemented and live-verified first.
- What is "JEV"? If it is a proxy provider, it belongs in this list.
