function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

function getForwardedProtocol(request: Request) {
  const protocol = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  return protocol === "http" || protocol === "https" ? protocol : null;
}

/**
 * Explicit operator override, highest precedence.
 *
 * Header sniffing cannot cover every fronting setup, and guessing wrong here
 * is not cosmetic: this origin becomes the Google OAuth `redirect_uri`, so a
 * wrong scheme means Google rejects the flow outright. PUBLIC_ORIGIN states
 * the public origin instead of inferring it.
 */
function getConfiguredPublicOrigin() {
  const configured =
    typeof process !== "undefined" ? process.env?.PUBLIC_ORIGIN : undefined;
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    // A malformed override must not take down origin resolution entirely.
    return null;
  }
}

export function getPublicOrigin(request: Request) {
  const configured = getConfiguredPublicOrigin();
  if (configured) {
    return configured;
  }

  const url = new URL(request.url);
  if (url.protocol === "https:") {
    return url.origin;
  }

  const protocol = getForwardedProtocol(request);
  if (!protocol) {
    return url.origin;
  }

  // Fall back to the Host header when the proxy forwards the scheme but not
  // the host. Cloudflare Tunnel does exactly that — it sends
  // x-forwarded-proto: https and preserves Host, but sends no
  // x-forwarded-host — so requiring both produced an http:// origin and broke
  // the Google Search Console / GA4 OAuth redirect_uri for tunnelled
  // self-hosts. Gated on a forwarded protocol being present so a direct,
  // unproxied request still falls through to url.origin below.
  const host =
    firstHeaderValue(request.headers.get("x-forwarded-host")) ?? url.host;

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return url.origin;
  }
}

export function requestWithPublicOrigin(request: Request) {
  const url = new URL(request.url);
  const publicOrigin = getPublicOrigin(request);

  if (url.origin === publicOrigin) {
    return request;
  }

  const publicUrl = new URL(
    `${url.pathname}${url.search}${url.hash}`,
    publicOrigin,
  );
  return new Request(publicUrl, request);
}
