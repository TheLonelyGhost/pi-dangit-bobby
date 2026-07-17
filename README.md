# pi-dangit-bobby

Forked from [`pi-bob@0.2.0`](https://www.npmjs.com/package/pi-bob).

Pi provider package for authorized IBM Bob-compatible enterprise model endpoints.

The package registers Bob through Pi's built-in compatible provider APIs, discovers the currently exposed model catalog from Bob's authenticated `/inference/v1/model/info` endpoint, and optionally signs requests with an operator-provisioned secret. It does not scrape Bob, extract browser/session credentials, embed signing keys, or bypass IBM-approved access paths.

## Discovered local Bob Shell settings

From the installed `bobshell@1.0.6` package and the local redacted Bob configuration:

- Bob Shell CLI: `/opt/homebrew/bin/bob`
- Bob Shell package: `/opt/homebrew/lib/node_modules/bobshell`
- Installed auth method: `sso`
- Default Bob API host: `https://api.us-east.bob.ibm.com`
- OpenAI-compatible chat base URL: `https://api.us-east.bob.ibm.com/inference/v1`
- Chat completions route used by Bob Shell: `/inference/v1/chat/completions`
- Model-info route used by Bob Shell: `/inference/v1/model/info`
- Default model alias used by Bob Shell: `premium`
- Other visible aliases/constants in the installed client: `pro`, `flash`, `flash-lite`, `bob-3-pro-preview`
- Installed Bob Shell contains a broad ~1M context-window default, but the observed `premium` backend route maps to Claude Sonnet 4.5 with `Max Input Tokens=200000`.
- Default context window advertised to Pi: `200000`, so Pi compacts before Bob rejects oversized requests.
- Default max output token constant in the installed client: `8192`

Bob Shell sends non-secret instance/team routing headers. This extension reads only these non-secret fields from `~/.bob/settings.json` by default:

- `ibm.instanceId` -> `x-instance-id`
- `ibm.teamId` -> `x-team-id`

It intentionally ignores Bob's stored SSO secrets.

## What it supports

Set `IBM_BOB_API` to one of Pi's compatible API adapters:

- `openai-completions` — default; OpenAI Chat Completions-compatible routes.
- `openai-responses` — OpenAI Responses-compatible routes.
- `anthropic-messages` — Anthropic Messages-compatible routes.

The extension registers provider id `ibm-bob`. It uses an isolated `ibm-bob-compatible` Pi API adapter internally, then delegates serialization and streaming to the selected built-in adapter. This prevents Bob-specific authentication rules from affecting other providers.

Request signing is supported for the default `openai-completions` adapter. When a signing secret is configured, the final serialized payload is signed before the request is delegated to Pi's OpenAI adapter. The extension fails instead of silently sending unsigned requests if signing is configured with another API adapter.

## Dynamic model discovery

Model discovery is enabled by default:

- With `IBM_BOB_API_KEY` or `IBM_BOB_KEY`, the extension fetches `/inference/v1/model/info` during Pi's async extension startup. This makes current models available to `--list-models` and `/model` immediately.
- With `/login ibm-bob`, the extension fetches the catalog after login and on each token refresh. A sanitized, non-secret copy is cached with Pi's OAuth credentials so the models can be restored on later startups.
- Entries returned by the authenticated catalog are registered when `model_info.exposed` is omitted or `true`. Routes explicitly marked `exposed: false` are ignored.
- HTTP failures, timeouts, malformed responses, empty catalogs, and catalogs with no visible models retain the previous SSO catalog or fall back to `IBM_BOB_MODELS`. Bob still enforces route access during inference.

Discovered context limits, output limits, vision support, reasoning support, backend identifiers, and token prices are mapped into Pi model definitions. Bob reports prices per token; Pi displays prices per million tokens, so the extension performs that conversion.

## Quick start for the discovered Bob endpoint

Use Bob SSO through Pi:

```bash
pi -e ./pi-dangit-bobby
# inside Pi:
#   /login ibm-bob
#   /model ibm-bob/premium
```

Pi stores the resulting Bob SSO access/refresh tokens in Pi's normal auth store (`~/.pi/agent/auth.json`). This extension obtains those tokens only through Bob's browser SSO endpoints; it does not read Bob Shell's stored SSO secrets.

For non-interactive use with an approved Bob API key, run:

```bash
export IBM_BOB_API_KEY="..." # IBM_BOB_KEY is also accepted; do not commit either

pi -e ./pi-dangit-bobby --list-models
pi -e ./pi-dangit-bobby --model ibm-bob/premium
```

API keys use Bob's `Authorization: Apikey ...` scheme by default. If your approved credential is instead a bearer token, set `IBM_BOB_AUTH_SCHEME=Bearer`. Pi resolves credentials in this order: runtime `--api-key`, a stored credential (including SSO), then the provider's environment-key fallback. The model catalog follows stored SSO metadata when SSO remains configured. Run `/logout ibm-bob` before switching from SSO to either `IBM_BOB_API_KEY` or runtime `--api-key`; runtime-only keys cannot drive startup discovery.

Defaults are already set to:

```bash
IBM_BOB_BASE_URL="https://api.us-east.bob.ibm.com/inference/v1"
IBM_BOB_API="openai-completions"
IBM_BOB_DISCOVER_MODELS="true"
IBM_BOB_MODELS="premium"                  # fallback catalog
IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS="5000"
```

Discovered metadata is used unless a corresponding metadata override is set. Without a discovered catalog, fallback models use a 200,000-token context window and 8,192-token output limit.

For SSO, do **not** copy a token out of Bob's local credential store unless IBM policy explicitly permits it. Use `/login ibm-bob` instead.

If your IBM gateway deployment requires request signing, inject `IBM_BOB_REQUEST_SIGNING_SECRET` through your approved secret manager or process supervisor. Do not place it in source files, shell history, checked-in `.env` files, or Pi configuration. Set `IBM_BOB_REQUIRE_REQUEST_SIGNING=true` to fail closed when the secret is unavailable.

## Configuration

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_BASE_URL` | `https://api.us-east.bob.ibm.com/inference/v1` | Approved Bob/IBM endpoint base URL. For `anthropic-messages`, a trailing `/inference/v1` is normalized so the adapter sends requests to `/inference/v1/messages` rather than `/inference/v1/v1/messages`. |
| `IBM_BOB_MODELS` | `premium` | Comma-separated fallback model IDs used when discovery is unavailable. |
| `IBM_BOB_API_KEY` | unset | Approved API key/token. Keep it out of repo files. |
| `IBM_BOB_KEY` | unset | Alias for `IBM_BOB_API_KEY`, matching Bob/OpenCode configuration. |
| `IBM_BOB_API` | `openai-completions` | One of `openai-completions`, `openai-responses`, `anthropic-messages`. |
| `IBM_BOB_DISCOVER_MODELS` | `true` | Discover visible models from `/model/info`; entries explicitly marked `exposed: false` are excluded. |
| `IBM_BOB_MODEL_DISCOVERY_TIMEOUT_MS` | `5000` | Startup/login discovery timeout in milliseconds. |
| `IBM_BOB_TOKEN_REQUEST_TIMEOUT_MS` | `10000` | SSO token exchange and refresh timeout in milliseconds. |

### Bob routing headers

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_READ_BOBSHELL_SETTINGS` | `true` | Read non-secret `instanceId`/`teamId` from `~/.bob/settings.json`. |
| `IBM_BOB_INSTANCE_ID` | Bob setting | Override `x-instance-id`. |
| `IBM_BOB_TEAM_ID` | Bob setting | Override `x-team-id`. |
| `IBM_BOB_VERSION` | installed `bob --version`; fallback `1.0.6` | Override the Bob Shell version reported in the fixed `bobshell/<version>` User-Agent. The value must be a semantic version. |

The User-Agent is always formatted as `bobshell/<version>`. Version resolution uses `IBM_BOB_VERSION` first, then the installed `bob --version`, and finally `1.0.6` when Bob is unavailable. Invalid environment overrides are rejected to prevent malformed headers.

### Auth headers

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_AUTH_SCHEME` | `Apikey` for environment API keys | Override with `Bearer` when the environment credential is a bearer token. SSO always uses Bearer automatically. |
| `IBM_BOB_HEADERS_JSON` | unset | JSON object of extra headers. Values may use Pi env interpolation such as `"$IBM_BOB_API_KEY"`. |

### Request signing

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_REQUEST_SIGNING_SECRET` | unset | Operator-provisioned HMAC-SHA256 key. It must contain at least 32 bytes and must not have leading or trailing whitespace. Keep it outside source control. |
| `IBM_BOB_REQUIRE_REQUEST_SIGNING` | `false` | Fail closed when no signing secret is available. Accepts standard boolean values such as `true`/`false` and `1`/`0`; invalid values are rejected. |

For signed requests, the extension sends `x-request-timestamp` and `x-request-signature`. The signature covers the uppercase HTTP method, path and query, canonical UTC timestamp, and SHA-256 digest of the exact request body. Existing static values for either signing header are removed before fresh values are added.

Signing currently covers model discovery and OpenAI Chat Completions requests. SSO token exchange remains authenticated by the authorization-code/refresh-token flow. `openai-responses` and `anthropic-messages` remain available only when request signing is not configured.

### Model metadata

| Variable | Default | Description |
| --- | --- | --- |
| `IBM_BOB_CONTEXT_WINDOW` | discovered; fallback `200000` | Override the context window for every Bob model. Keep it at or below the backend limit so Pi compacts before Bob rejects the request. |
| `IBM_BOB_MAX_TOKENS` | discovered; fallback `8192` | Override maximum output tokens for every Bob model. |
| `IBM_BOB_INPUT` | discovered; fallback `text` | Override input types with `text` or `text,image`. |
| `IBM_BOB_REASONING` | discovered; fallback `false` | Explicitly enable or disable reasoning for all models. |
| `IBM_BOB_REASONING_MODELS` | empty | Comma-separated model IDs to mark as reasoning-capable. |

Discovered pricing comes from Bob's model-info response and is converted to Pi's per-million-token units. Fallback models retain zero pricing.

### OpenAI compatibility toggles

```bash
export IBM_BOB_SUPPORTS_DEVELOPER_ROLE=false
export IBM_BOB_SUPPORTS_REASONING_EFFORT=false
export IBM_BOB_SUPPORTS_USAGE_IN_STREAMING=true
export IBM_BOB_SUPPORTS_STRICT_MODE=false
export IBM_BOB_MAX_TOKENS_FIELD=max_tokens
```

Bob's OpenAI-compatible route currently rejects `tools[].function.strict`, so `IBM_BOB_SUPPORTS_STRICT_MODE=false` is the default.

## Validation performed

Bob Shell SSO itself works locally:

```bash
bob --auth-method sso -m premium -p 'Reply with exactly: bob-ok' --hide-intermediary-output --output-format json
```

The response included `bob-ok` and successful usage stats for model `premium`.

The unauthenticated Bob model-info endpoint responds as expected when called with a normal User-Agent:

```bash
curl -H 'User-Agent: bobshell/1.0.6' \
  https://api.us-east.bob.ibm.com/inference/v1/model/info
```

Result: HTTP `401` with `Authentication required`, confirming the discovered route exists and requires auth.

The Bob SSO endpoint flow was smoke-tested independently: browser SSO callback succeeded, token exchange succeeded, and `GET /inference/v1/model/info` returned HTTP `200` using the fresh SSO token.

The Pi provider registers with fallback settings when no authenticated catalog is available:

```bash
pi -e . --list-models | grep ibm-bob
```

Automated tests cover deterministic HMAC vectors, secret validation, header replacement, payload construction, payload-hook ordering, and an end-to-end local signed streaming request through Pi's OpenAI adapter:

```bash
npm test
npm run check
```

`npm run check` performs a TypeScript check and verifies that Pi can load the provider.

A dummy-token Pi request reaches the Bob endpoint and fails with the expected auth error:

```bash
IBM_BOB_API_KEY=dummy IBM_BOB_AUTH_SCHEME=Apikey \
  pi -e . --model ibm-bob/premium -p 'Say hi'
```

Result: HTTP `401 unauthorized`.

End-to-end smoke with a fresh Bob SSO token succeeded:

```text
pi -e . --model ibm-bob/premium -p 'Reply with exactly: dangit, bobby!'
```

Result:

```text
dangit, bobby!
```

## Install options

Temporary test load:

```bash
pi -e ./pi-dangit-bobby
```

Install as a local Pi package:

```bash
pi install ./pi-dangit-bobby
```

Remove later:

```bash
pi remove ./pi-dangit-bobby
```

## Next steps

The compatible provider, `/login ibm-bob`, and dynamic model discovery are implemented. Next useful improvements:

1. Add a `/bob-status` command that checks auth, model-info, selected instance, and selected team without printing secrets.
2. Run periodic compatibility smoke tests against representative Claude, GPT, and Gemini routes exposed by Bob.
