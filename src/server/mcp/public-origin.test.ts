import { afterEach, describe, expect, it } from "vitest";
import { getPublicOrigin, requestWithPublicOrigin } from "./public-origin";

describe("getPublicOrigin", () => {
  afterEach(() => {
    delete process.env.PUBLIC_ORIGIN;
  });

  it("uses the forwarded protocol with the Host header when the proxy sends no x-forwarded-host", () => {
    // Cloudflare Tunnel's exact shape: it forwards the scheme and preserves
    // Host, but sends no x-forwarded-host. Requiring both yielded an http://
    // origin, which Google rejects as an OAuth redirect_uri.
    const request = new Request("http://seo.example.com/api/gsc/oauth/callback", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(getPublicOrigin(request)).toBe("https://seo.example.com");
  });

  it("prefers an explicit PUBLIC_ORIGIN over request and proxy headers", () => {
    process.env.PUBLIC_ORIGIN = "https://seo.example.com";
    const request = new Request("http://localhost:3001/api/gsc/oauth/callback", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "wrong.test",
      },
    });

    expect(getPublicOrigin(request)).toBe("https://seo.example.com");
  });

  it("ignores a malformed PUBLIC_ORIGIN instead of failing resolution", () => {
    process.env.PUBLIC_ORIGIN = "not a url";
    const request = new Request("http://localhost:3102/api/oauth/consent");

    expect(getPublicOrigin(request)).toBe("http://localhost:3102");
  });

  it("uses the forwarded public protocol and host for tunneled requests", () => {
    const request = new Request("http://localhost:3102/api/oauth/consent", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "scenario-tools.trycloudflare.com",
      },
    });

    expect(getPublicOrigin(request)).toBe(
      "https://scenario-tools.trycloudflare.com",
    );
  });

  it("falls back to the request origin without proxy headers", () => {
    const request = new Request("http://localhost:3102/api/oauth/consent");

    expect(getPublicOrigin(request)).toBe("http://localhost:3102");
  });

  it("ignores forwarded hosts when the request is already public https", () => {
    const request = new Request("https://app.openseo.so/api/oauth/consent", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.test",
      },
    });

    expect(getPublicOrigin(request)).toBe("https://app.openseo.so");
  });
});

describe("requestWithPublicOrigin", () => {
  it("rewrites the request URL origin while preserving path and query", async () => {
    const request = new Request("http://localhost:3102/mcp?x=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "scenario-tools.trycloudflare.com",
      },
      body: JSON.stringify({ method: "initialize" }),
    });

    const publicRequest = requestWithPublicOrigin(request);

    expect(publicRequest.url).toBe(
      "https://scenario-tools.trycloudflare.com/mcp?x=1",
    );
    expect(publicRequest.method).toBe("POST");
    await expect(publicRequest.json()).resolves.toEqual({
      method: "initialize",
    });
  });
});
