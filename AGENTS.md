# AGENTS.md

Guidance for AI coding agents working in this repo.

## Worktrees: only when the user asks

Work in the current checkout and branch by default. **Use a git worktree only when the user explicitly says so** (e.g. "do this in a worktree"). When asked, create it as the very first step, before reading code or making any change:

```bash
git worktree add ../myapp-<short-feature-name> -b <feature-branch-name> main
```

- Not enforced by a hook — the `require-worktree` `PreToolUse` hook was removed from `.claude/settings.json`. Don't re-add it or create worktrees unprompted.
- If the task needs uncommitted files that only exist in the primary checkout, don't move the work to a worktree — stay in place, or ask the user.
- Details (merging back, conflicts) are under "Worktree workflow" below.

## Git

### Safety

- **Never use `git stash`.** Use a branch or worktree instead.
- For read-only history questions, use `git show HEAD:<path>`, `git diff HEAD -- <path>`, or `git log -p <path>` — never `git reset`/`checkout --`/`clean`.
- To discard uncommitted changes, `git reset --hard HEAD` the whole project, not per-file. Confirm with the user first.
- Use an isolated `git worktree` when the user asks for one — see "Worktrees: only when the user asks" above.
- `git add` a newly-created file immediately, before doing anything else with it.
- Before every commit, check `git status` and confirm every staged file is one you intend to commit — not just that your target file is staged.

### Worktree workflow

Applies when the user asks for a worktree. Create as a **sibling directory**, not nested inside the repo.

```bash
git worktree add ../myapp-<short-feature-name> -b <feature-branch-name> main
```

Right after creating the worktree, copy the gitignored env files (`.env*`, `.dev.vars*`) from the primary checkout into it (`cp -n`) — never symlink, never overwrite existing files. Without them the worktree has no `VITE_*` vars or worker secrets and e2e tests fail.

To merge back: no PRs. The user approves a plan before the feature starts; write and run e2e + UI tests that verify that plan, then — only once lint, build, unit and e2e tests all pass — merge the branch into `main` yourself (`git merge --no-ff`). Never merge with failing tests; report failures instead.

On merge/rebase conflicts:

1. `git status` to see conflicted files.
2. Resolve conflict markers by understanding both sides' intent — never `--ours`/`--theirs` on code. Exception: regenerate `pnpm-lock.yaml` with `pnpm install` instead of hand-merging.
3. Run lint/build/test before committing. Fix failures now, don't commit broken code — if unclear how, stop and ask.
4. If both sides changed the same logic incompatibly, stop and ask — don't guess.

### Commit scope

Scope each commit to one issue/feature, ≤10 files (ideally <5). Split larger changes into multiple commits.

## Code quality

- Handle common HTTP error codes explicitly (401, 429, 5xx, etc.) — never leak raw exception/response text to the client.
- Add UI tests covering how the UI responds to each handled error case.
- **Always handle errors from tool calls.** Code that executes an LLM tool call (`tool_use` → `tool_result`, e.g. in `runToolUseLoop`) must catch every failure per call — a thrown error, a failed D1/fetch call inside the tool, or malformed arguments from the model — and return it to the model as an `is_error` tool result (`toolError`). Never let a tool exception escape the loop: the visitor would get a 500 and the model could never recover or apologise. Every `tool_use` block must get exactly one `tool_result`, and the text returned to the model must not leak raw exception text either. Add a worker test where the tool throws, and one for malformed arguments, whenever a tool is added or changed.
- Form fields: implement validation, accessibility, and security. Exception: client-only fields holding transient data (search strings, filter params).

## Session handoff

Read `agent/SESSION_LOG.md` at session start. Add a dated entry (most recent first) before ending a session with uncommitted/in-progress work.

See `agent/TODO.md` for planned/optional additions.

## Architecture

Full-stack appointment booking app: single Cloudflare Worker + static assets (SPA).

**Frontend** (`src/`): React 19, React Router v7, Tailwind CSS v4, Auth0 React SDK, Stripe React SDK.

**Backend** (`worker/`): Worker serves the API; `/api/*` handled before falling through to SPA assets.

**Database**: Cloudflare D1, binding `DB` (`wrangler.jsonc`). `wrangler dev`/vite use a local SQLite replica (no `remote: true`); prod uses remote. Create the local schema once per checkout: `pnpm exec wrangler d1 execute myapp --local --file schema/db-schema-setup.sql`.

### Request flow

1. Every request hits `worker/index.ts`.
2. `/api/public/*` — unauthenticated (booking, Stripe intent creation).
3. `/api/appointments` (GET/POST/DELETE) — require Auth0 JWT + scope (`get:appointment`/`post:appointment`/`delete:appointment`).
4. Everything else → `env.ASSETS.fetch(request)` (SPA).

### Auth

- **Frontend**: Auth0 (`@auth0/auth0-react`), configured via `VITE_AUTH0_*` in `.env`. `src/auth-config.ts`'s `hasAuth0Config` — false (vars absent) bypasses auth.
- **Worker**: `worker/auth.ts`'s `requireAuth0Jwt` verifies RS256 JWTs against Auth0's JWKS; scopes enforced per route.

### Payment flow

$1 CAD Stripe deposit required:

1. `POST /api/public/payments/create-deposit-intent` → `clientSecret`.
2. Stripe Elements payment on `/checkout`.
3. `POST /api/public/appointments` with `paymentIntentId` — worker verifies payment before persisting.

### Privacy

`worker/encryption.ts`'s `hashPrivateValue` (HMAC-SHA-256) hashes PII (name/email/meeting contact) before logging; raw values only in D1.

### Environment variables

- `.env` — frontend Vite vars (`VITE_*`), committed (non-secret public keys and Auth0 config).
- `.dev.vars` — worker secrets for local dev (`PRIVACY_SALT_PHRASE`, `STRIPE_SECRET_KEY`), not committed.
- `wrangler.jsonc` `vars` block — non-secret worker vars (`AUTH0_AUDIENCE`, `AUTH0_DOMAIN`, `CONTACT_EMAIL`).
- Prod secrets: `wrangler secret put`.

### Key frontend hooks

- `useCloudflareApi` — wraps `fetch` with Auth0 bearer tokens; silent/popup token acquisition.
- `useAppointmentApi` — authenticated CRUD for appointments (dashboard).
- `usePublicAppointmentApi` — unauthenticated appointment creation (public booking).
- `usePaymentApi` — creates Stripe deposit payment intents.

### Routes

| Path               | Component                                             | Auth           |
| ------------------ | ----------------------------------------------------- | -------------- |
| `/`                | `LandingPage`                                         | Public         |
| `/dashboard`       | `DashboardPage` + `AuthenticatedBookingCalendar`      | Requires Auth0 |
| `/appointments`    | `AppointmentsPage` — tabular list of all appointments | Requires Auth0 |
| `/book`            | `BookingPage` + `PublicBookingCalendar`               | Public         |
| `/checkout`        | `CheckoutPage`                                        | Public         |
| `/payment/success` | `PaymentSuccessPage`                                  | Public         |

### Navigation

Authenticated pages (`/dashboard`, `/appointments`) wrap in `AuthenticatedShell` (`App.tsx`) — renders `BottomNav` (`@repo/ui`), tracks active item via `location.pathname`, navigates via `useNavigate`. New authenticated page: wrap route in `<RequireAuth><AuthenticatedShell>`, add entry to `NAV_ITEMS`.

### Icon system

`src/components/web/Icon.tsx` — typed `<Icon type="..." size={n} />`, used app-wide. Extend for new nav entries.

### `@repo/ui` package

`packages/ui/src/` (repo root). Exports: `Button`, `TextControl`, `BottomNav` (+ `BottomNavItem`). `BottomNav` is router-agnostic — takes `items`, `activeId`, `onItemClick`; caller handles navigation.

### Testing

Vitest, Node environment. Worker tests mock D1's `prepare/bind/run` and `fetch` (JWKS). No integration tests against live D1/Stripe.

## Cloudflare setup notes

### Recommended stack

- Cloudflare Workers — API layer.
- Cloudflare D1 — appointments + chat history, bound as `DB`.

### API endpoints

- `GET /api/public/appointments` — public read
- `POST /api/public/appointments` — public booking (requires verified Stripe deposit)
- `POST /api/public/payments/create-deposit-intent` — creates $1 CAD Stripe PaymentIntent
- `GET /api/appointments` — authenticated read (scope: `get:appointment`)
- `POST /api/appointments` — authenticated create (scope: `post:appointment`)
- `DELETE /api/appointments/:id` — authenticated delete (scope: `delete:appointment`)

### Booking payload

Times stored in UTC; timezone stored separately.

Required: `startAt`, `endAt`, `timezone`, `name`, `email`, `meetingLinkOrPhone`. Optional: `additionalInfo`, `paymentIntentId` (required on public route).

### D1 schema

See `schema/db-schema-setup.sql` for table definitions — not duplicated here (would drift).
