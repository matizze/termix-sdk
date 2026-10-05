# termix-sdk spec-gen report

Generated from tag `release-2.9.0-tag` (commit `unknown`) on 2026-10-05T17:47:50.299Z.

## Route counts

- Total route registrations: **580** (6 of which are `X.use()` method catch-alls, listed under `x-any-method-routes` instead of `paths`)
- Unresolved routes (origin never reached an express() app): **0**

| Service | Port | Routes | Global auth |
|---|---|---|---|
| database | 30001 | 224 | no (per-route) |
| plugin-acme-ssl | 30001 | 2 | yes (from line null) |
| plugin-ai | 30001 | 15 | yes (from line null) |
| plugin-alerts | 30001 | 18 | yes (from line null) |
| plugin-automations | 30001 | 13 | yes (from line null) |
| plugin-docker | 30001 | 13 | yes (from line null) |
| plugin-file-manager | 30001 | 50 | yes (from line null) |
| plugin-fleets | 30001 | 16 | yes (from line null) |
| plugin-homepage | 30001 | 14 | yes (from line null) |
| plugin-host-metrics | 30001 | 38 | yes (from line null) |
| plugin-ldap | 30001 | 4 | yes (from line null) |
| plugin-network-topology | 30001 | 2 | yes (from line null) |
| plugin-opkssh | 30001 | 5 | yes (from line null) |
| plugin-proxmox | 30001 | 5 | yes (from line null) |
| plugin-remote-desktop | 30001 | 6 | yes (from line null) |
| plugin-secret-sources | 30001 | 5 | yes (from line null) |
| plugin-session-recording | 30001 | 4 | yes (from line null) |
| plugin-session-sharing | 30001 | 25 | yes (from line null) |
| plugin-snippets | 30001 | 21 | yes (from line null) |
| plugin-ssh-terminal | 30001 | 10 | yes (from line null) |
| plugin-sso | 30001 | 9 | yes (from line null) |
| plugin-step-ca | 30001 | 1 | yes (from line null) |
| plugin-tailscale | 30001 | 3 | yes (from line null) |
| plugin-telemetry | 30001 | 6 | yes (from line null) |
| plugin-termix-identity | 30001 | 19 | yes (from line null) |
| plugin-tmux-monitor | 30001 | 12 | yes (from line null) |
| plugin-totp | 30001 | 5 | yes (from line null) |
| plugin-tunnels | 30001 | 10 | yes (from line null) |
| plugin-vault | 30001 | 6 | yes (from line null) |
| plugin-wake-on-lan | 30001 | 1 | yes (from line null) |
| plugin-web-endpoint | 30001 | 2 | yes (from line null) |
| plugin-webauthn | 30001 | 5 | yes (from line null) |
| plugin-workspaces | 30001 | 11 | yes (from line null) |

## Drizzle schema

- Tables: **40**
- Columns: **406**

## Handler analysis coverage

- Routes with a resolvable handler: **570/580**
- Opaque handlers (could not be statically resolved): **10**
- Routes with no documented 2xx/3xx response: **10**
- Routes whose every response is `x-confidence: unknown`: **3**

### Request body completeness (docs/spec-generation-strategy-v2.md)

- POST/PUT/PATCH routes: **292**, of which **114** (39%) have an `application/json` body with every top-level field typed
- Routes where no body field was found at all: **61**
- Routes with a body but no `application/json` variant (e.g. streamed uploads): **3**
- Top-level `application/json` fields still `unknown`: **261**

### Request body field confidence (all nodes, all content types — includes nested fields)

| Confidence | Count |
|---|---|
| handler-literal | 42 |
| frontend-type | 178 |
| matched-type | 225 |
| inferred | 536 |
| unknown | 340 |

### Response field confidence

| Confidence | Count |
|---|---|
| repository-type | 2277 |
| handler-literal | 3583 |
| inferred | 245 |
| unknown | 532 |

### Opaque handlers (worth a manual look)

- GET /plugin-api/automations/maintenance/:hostId — `plugins/automations/src/backend/maintenance-routes.ts:113` (handlerKind: property-handler)
- POST /plugin-api/automations/maintenance/:hostId — `plugins/automations/src/backend/maintenance-routes.ts:150` (handlerKind: property-handler)
- * /plugin-api/proxmox/stats — `plugins/proxmox/src/backend/stats-service.ts:85` (handlerKind: named-function)
- GET /plugin-api/termix-identity/u/:handle/:algo — `plugins/termix-identity/src/backend/routes.ts:124` (handlerKind: property-handler)
- GET /plugin-api/termix-identity/u/:handle/ca — `plugins/termix-identity/src/backend/routes.ts:77` (handlerKind: property-handler)
- GET /plugin-api/termix-identity/u/:handle — `plugins/termix-identity/src/backend/routes.ts:98` (handlerKind: property-handler)
- POST /plugin-api/tunnels/disconnect — `plugins/tunnels/src/backend/routes.ts:356` (handlerKind: property-handler)
- POST /plugin-api/tunnels/cancel — `plugins/tunnels/src/backend/routes.ts:382` (handlerKind: property-handler)
- * /plugin-api/vault/profiles — `plugins/vault/src/backend/routes.ts:119` (handlerKind: property-handler)
- * /plugin-assets — `src/backend/database/database.ts:1544` (handlerKind: property-handler)

### Routes with no documented success response

- GET /plugin-api/alerts/stream — `plugins/alerts/src/backend/routes.ts:136`
- GET /plugin-api/automations/maintenance/:hostId — `plugins/automations/src/backend/maintenance-routes.ts:113`
- POST /plugin-api/automations/maintenance/:hostId — `plugins/automations/src/backend/maintenance-routes.ts:150`
- GET /plugin-api/sso/callback — `plugins/sso/src/backend/routes.ts:143`
- POST /plugin-api/sso/callback — `plugins/sso/src/backend/routes.ts:144`
- GET /plugin-api/termix-identity/u/:handle/:algo — `plugins/termix-identity/src/backend/routes.ts:124`
- GET /plugin-api/termix-identity/u/:handle/ca — `plugins/termix-identity/src/backend/routes.ts:77`
- GET /plugin-api/termix-identity/u/:handle — `plugins/termix-identity/src/backend/routes.ts:98`
- POST /plugin-api/tunnels/disconnect — `plugins/tunnels/src/backend/routes.ts:356`
- POST /plugin-api/tunnels/cancel — `plugins/tunnels/src/backend/routes.ts:382`

## Test suite examples (Phase 6)

- Examples mined: **33**, covering **14** route(s) from **5** test file(s).
- Statuses a test proved but static analysis missed: **2** (added to the OpenAPI output with `x-confidence: test`)
  - PATCH /users/branding → 401, from `src/backend/tests/database/routes/branding-routes.test.ts` ("rejects an unauthenticated request and persists nothing")
  - PATCH /users/branding → 403, from `src/backend/tests/database/routes/branding-routes.test.ts` ("rejects a non-admin request and persists nothing")

## Frontend client cross-check (Phase 7)

- Frontend calls matched to a route: **163**, covering **148** route(s).
- Responses where the frontend's return type filled a gap the backend analysis left `unknown`: **5**
- Frontend/backend request-body field mismatches worth a look: **2**
  - PUT /host-sidebar/preferences (`src/ui/api/host-sidebar-preferences-api.ts:24`, saveHostSidebarPreferences) — frontend body type has 3 field(s) not seen in the backend's own destructuring: version, groupKey, openFolders
  - PUT /user-preferences (`src/ui/api/open-tabs-api.ts:151`, saveUserPreferences) — frontend body type has 4 field(s) not seen in the backend's own destructuring: showHostTags, hostTrayOnClick, compactHostView, statusColorScheme

## Existing @openapi text reuse (Phase 8)

- `@openapi` JSDoc blocks parsed: **580**. Their `summary`/`description`/`tags`/parameter descriptions are reused verbatim when present; `requestBody`/`responses` from them are never used as a schema source.

## Golden route regression check (docs/spec-generation-strategy-v2.md, Passo 0)

**2 regression(s) found** — a field that had a concrete type before now has a different one or reverted to `unknown`:

- `POST /host/db/host`.`tunnelConnections`: was `array` (inferred), now `unknown` (unknown)
- `POST /host/db/host`.`quickActions`: was `array` (inferred), now `unknown` (unknown)

## Diff against the official spec (Phase 10, criterion 4)

Not available: could not regenerate the official openapi.json (see the [official-diff] log line above)

## OpenAPI lint (@redocly/cli)

- Errors: **0**
- Warnings: **838**
- Ignored: **0**

Spec is structurally valid OpenAPI 3.1.
