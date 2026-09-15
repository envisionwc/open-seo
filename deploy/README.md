# OpenSEO on the MCAG Hostinger VPS

Self-hosted OpenSEO, built from this fork, behind the existing cloudflared
tunnel with Cloudflare Access as the auth gate.

- **Public URL:** https://seo.momentumcag.com — **live**, behind Cloudflare Access
- **Host:** `mcag-vps` (Hostinger, 2 vCPU / 7 GiB)
- **Checkout:** `/root/open-seo`
- **Compose project:** `openseo` (separate from the crew stack's `deploy`)
- **Container:** `open-seo`, bound to `127.0.0.1:3001` only

## The security model, because it is not optional

OpenSEO's Docker path runs `AUTH_MODE=local_noauth`: **no login, no auth
checks, every visitor is auto-admin as `admin@localhost`.** Upstream's own docs
say to expose it only behind your own auth-protected proxy or tunnel.

So the auth boundary is entirely **Cloudflare Access**, not the app:

```
browser → Cloudflare edge → Access policy (allowed emails)
        → tunnel 3e36b140 → 127.0.0.1:3001 → open-seo
```

The container publishes on `127.0.0.1` only, so there is no path to it that
skips the tunnel. Two rules follow:

1. **Never change the port binding to `0.0.0.0`.** That exposes an
   unauthenticated admin panel on the public internet.
2. **Never remove the Access application** while the DNS record exists.
   The tunnel alone is not authentication.

Anyone who reaches the app can spend your DataForSEO balance.

### Current state: live and gated

`seo.momentumcag.com` forwards to the app, with a Cloudflare Access
application (team `wispy-fire-1cac.cloudflareaccess.com`) in front.

Verified 2026-09-15: an unauthenticated request to `/` **and** to `/mcp`
returns `302` to the Access login with `auth_status: NONE` — Cloudflare
intercepts at the edge and the request never reaches the tunnel. No app HTML
is served to an unauthenticated caller.

Re-run that check after any change to the tunnel, the Access app, or DNS:

```sh
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://seo.momentumcag.com/
# expect: 302 https://wispy-fire-1cac.cloudflareaccess.com/cdn-cgi/access/login/...
# a 200 with app HTML means the gate is GONE — re-park the ingress immediately
```

There is also an SSH path that bypasses Access, for when you want the app
without an Access session:

```sh
ssh -N -L 3001:127.0.0.1:3001 mcag-vps   # then http://localhost:3001
```

### Do not add an Access bypass for /mcp

OpenSEO exposes an MCP server at `/mcp`. It is tempting to bypass Access there
so agents can reach it, but in `local_noauth` mode that endpoint resolves a
local admin with **no authentication of its own**
(`src/server/mcp/transport.ts`, `resolveLocalNoAuthContext`). A bypass would be
an unauthenticated, spend-capable hole. Use an Access **service token**, or
reach it over the SSH tunnel.

### To re-park the hostname

```sh
ssh mcag-vps "sed -i 's|service: http://localhost:3001|service: http_status:403|' /etc/cloudflared/config.yml"
ssh mcag-vps "systemctl restart cloudflared"
```

## Integrations

### Already on

- **DataForSEO** — keyword research, rank tracking, backlinks, site audits,
  SERP, AI visibility, Lighthouse. Key is `base64("login:API-password")`.

### The origin gotcha that blocks both Google integrations

The Google OAuth `redirect_uri` is built from the app's computed public origin.
Cloudflare Tunnel sends `x-forwarded-proto: https` but **no**
`x-forwarded-host`, so upstream's resolution fell back to an `http://` origin —
and Google refuses `http://` redirect URIs for non-localhost domains.

Fixed in this fork (`src/server/mcp/public-origin.ts`): an explicit
`PUBLIC_ORIGIN` wins, otherwise the Host header is used when a forwarded
protocol is present. `PUBLIC_ORIGIN=https://seo.momentumcag.com` is set in
`deploy/.env`. **Do not remove it** — the Google flows break silently, showing
only `redirect_uri_mismatch` at Google.

### Google Search Console

1. Google Cloud Console → create/pick a project.
2. Enable the **Google Search Console API**.
3. **OAuth consent screen** → External; add your Google account under
   **Test users** (otherwise sign-in fails with `access_denied`).
4. **Credentials → Create OAuth client ID → Web application**, redirect URI:
   `https://seo.momentumcag.com/api/gsc/oauth/callback`
5. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `deploy/.env`.
   `BETTER_AUTH_SECRET` is already set (it encrypts the stored tokens at rest).
6. `./deploy/deploy.sh --no-build`, then **Integrations → Connect with Google**.

### Do not leave the Google app in "Testing"

Google's OAuth docs: projects in **Testing** with an **External** user type get
refresh tokens that **expire after 7 days** unless only basic profile scopes are
requested. OpenSEO asks for `webmasters.readonly` and `analytics.readonly`, so
the exemption does not apply — every Google connection silently dies weekly.

Note `account.refresh_token_expires_at` is `null` in the database even in
Testing: Google enforces that expiry server-side without declaring it, so the
DB cannot tell you which mode you are in. Check
**Google Auth Platform → Audience**.

Options, in order of preference:

- **Internal** — no verification, no 7-day expiry, no tester list. Only works
  if every authorizing account is in the same Workspace org as the Cloud
  project. Not usable here: accounts from two different domains
  (`momentumcag.com`, `envisionwc.com`) authorize this instance.
- **Publish to Production, unverified** — clears the 7-day expiry. Shows a
  "Google hasn't verified this app" interstitial you click through, and caps at
  100 users. Google explicitly permits this: apps "intended for personal use by
  the developer or a small group of personally known users do not require
  verification." This is the right setting for this deployment.
- Submitting for verification is unnecessary at this scale.

### Google Analytics 4

Reuses the same Google Cloud project and OAuth client.

1. Enable **Google Analytics Admin API** and **Google Analytics Data API**.
2. Add a second redirect URI to the same OAuth client:
   `https://seo.momentumcag.com/api/ga4/oauth/callback`
   (keep the GSC one).
3. No new env vars. Connect under **Project settings → Analytics**.

GA4 needs its own consent grant even though the client is shared.

### SAM, the in-app agent

`OPENROUTER_API_KEY` (plus optional `OPENROUTER_MODEL`) in `deploy/.env`, then
redeploy. **OpenRouter only** — `src/server/lib/openrouter.ts` builds the model
with `createOpenRouter()` and exposes no base-URL override, so Ollama or any
other OpenAI-compatible endpoint would need a code change.

### MCP for agents

The server is at `https://seo.momentumcag.com/mcp`, behind Access like
everything else. Reach it with an Access **service token**:

```sh
claude mcp add --transport http --scope user openseo https://seo.momentumcag.com/mcp \
  --header "CF-Access-Client-Id: <id>.access" \
  --header "CF-Access-Client-Secret: <secret>"
```

Setup is **two** steps, and the second is easy to miss:

1. **Zero Trust → Access → Service Auth** — create the token. This only makes
   the token exist; it grants nothing.
2. On the `seo.momentumcag.com` application, add a **second** policy (keep the
   human one) with **Action: Service Auth** — not Allow — and a
   *Service Token* rule naming the token.

Without step 2, Access ignores the headers entirely and still redirects to the
browser login. The tell is in Access's own redirect: decode the `meta` JWT from
the `Location` header and look for `service_token_status: false` and
`service_token_id: null`.

Verified working: `200` with the headers, `302` without.

Never swap this for an Access bypass on `/mcp` — see the warning above.

Or skip Access entirely over the SSH tunnel:
`http://localhost:3001/mcp`.

## Deploying

```sh
./deploy/deploy.sh            # sync fork → rebuild → recreate → health check
./deploy/deploy.sh --no-build # config-only change, skip the image rebuild
```

The script only ever touches the `openseo` project. It uses no `rsync
--delete`, unlike the crew stack's deploy script.

## Pulling upstream changes

```sh
git fetch upstream
git merge upstream/main     # resolve, keeping deploy/ intact
git push origin main
./deploy/deploy.sh
```

## Secrets

`deploy/.env` exists **only on the VPS** and is gitignored. This fork is
**public** — anything committed here is public. See `deploy/.env.example`.

The DataForSEO value is `base64("login:API-password")`, not the key printed on
the DataForSEO dashboard:

```sh
printf '%s' 'login:password' | base64
```

## Known operational cost: the boot-time build

The entrypoint runs the full Vite SSR build (~7,400 modules, 4 GiB Node heap
via `.npmrc`) at **container start**, not image build, and caches it in the
container's `dist/` keyed by a fingerprint of the build-relevant env.

Consequence: any new container — every image rebuild — rebuilds from scratch,
which takes several minutes on 2 cores. A plain restart of the *existing*
container reuses the build and is fast.

`dist/` is deliberately **not** on a volume. Persisting it would let a code
update reuse a stale build whenever the build-env fingerprint happened to be
unchanged, silently serving old code.

`mem_limit` is 5g to clear the 4 GiB build heap. The host has 7 GiB total and
also hosts the crew stack (limit 6g), so the two peaking together would
contend. Check what is running before raising either.

## Health and troubleshooting

```sh
ssh mcag-vps curl -s http://127.0.0.1:3001/api/health
ssh mcag-vps docker compose -f /root/open-seo/deploy/docker-compose.yml logs -f open-seo
ssh mcag-vps docker compose -f /root/open-seo/deploy/docker-compose.yml ps
```

If every request 403s, `ALLOWED_HOST` does not match the hostname cloudflared
forwards — Vite preview rejects unknown `Host` headers.

Tunnel ingress lives at `/etc/cloudflared/config.yml`; edits need
`systemctl restart cloudflared`.
