# OpenSEO on the MCAG Hostinger VPS

Self-hosted OpenSEO, built from this fork, behind the existing cloudflared
tunnel with Cloudflare Access as the auth gate.

- **Public URL:** https://seo.momentumcag.com
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
