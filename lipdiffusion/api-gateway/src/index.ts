export interface Env {
  FASTAPI_BASE_URL: string;
  FASTAPI_ACCESS_CLIENT_ID?: string;
  FASTAPI_ACCESS_CLIENT_SECRET?: string;
  RUNPOD_FACEFUSION_URL: string;
  RUNPOD_FACEFUSION_KEY: string;
  RUNPOD_WAV2LIP_URL: string;
  RUNPOD_WAV2LIP_KEY: string;
  RUNPOD_SOVITS_URL: string;
  RUNPOD_SOVITS_KEY: string;
  RUNPOD_LLAMA_URL: string;
  RUNPOD_LLAMA_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ヘルスチェック
    if (url.pathname === "/health") {
      return withCors(Response.json({ status: "ok" }), origin);
    }

    // R2 (presigned) オブジェクトを CORS 付きでプロキシ
    if (url.pathname === "/r2-proxy") {
      const target = url.searchParams.get("url");
      if (!target) {
        return withCors(Response.json({ error: "missing_url" }, { status: 400 }), origin);
      }

      try {
        const method = request.method.toUpperCase();
        const isBody = method !== "GET" && method !== "HEAD";
        const upstream = await fetch(target, {
          method,
          headers: request.headers,
          body: isBody ? request.body : null,
        });
        const headers = new Headers();
        const contentType = upstream.headers.get("Content-Type");
        const contentLength = upstream.headers.get("Content-Length");
        if (contentType) headers.set("Content-Type", contentType);
        if (contentLength) headers.set("Content-Length", contentLength);

        return withCors(
          new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers,
          }),
          origin,
        );
      } catch (error) {
        return withCors(
          Response.json(
            { error: "proxy_failed", detail: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          ),
          origin,
        );
      }
    }

    if (url.pathname.startsWith("/fastapi")) {
      const base = (env.FASTAPI_BASE_URL || "").replace(/\/$/, "");
      if (!base) {
        return withCors(
          Response.json({ error: "fastapi_not_configured" }, { status: 500 }),
          origin,
        );
      }

      const upstreamPath = url.pathname.replace(/^\/fastapi/, "") || "/";
      const targetUrl = base + upstreamPath + url.search;
      const headers = new Headers(request.headers);
      if (env.FASTAPI_ACCESS_CLIENT_ID && env.FASTAPI_ACCESS_CLIENT_SECRET) {
        headers.set("CF-Access-Client-Id", env.FASTAPI_ACCESS_CLIENT_ID);
        headers.set("CF-Access-Client-Secret", env.FASTAPI_ACCESS_CLIENT_SECRET);
      }
      const fastapiResponse = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: shouldIncludeBody(request.method) ? request.body : null,
      });

      return withCors(cloneResponse(fastapiResponse), origin);
    }

    const runpodTargets: Record<string, { url: string; key: string }> = {
      "/run-facefusion": {
        url: env.RUNPOD_FACEFUSION_URL,
        key: env.RUNPOD_FACEFUSION_KEY,
      },
      "/run-wav2lip": {
        url: env.RUNPOD_WAV2LIP_URL,
        key: env.RUNPOD_WAV2LIP_KEY,
      },
      "/run-sovits": {
        url: env.RUNPOD_SOVITS_URL,
        key: env.RUNPOD_SOVITS_KEY,
      },
      "/run-llama": {
        url: env.RUNPOD_LLAMA_URL,
        key: env.RUNPOD_LLAMA_KEY,
      },
    };

    if (request.method === "POST" && runpodTargets[url.pathname]) {
      const body = await request.text();
      const target = runpodTargets[url.pathname];

      const runpodResponse = await fetch(target.url + "/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + target.key,
        },
        body,
      });

      return withCors(cloneResponse(runpodResponse), origin);
    }

    return withCors(Response.json({ error: "not_found" }, { status: 404 }), origin);
  },
};

function corsHeaders(origin: string | null) {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin ?? "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
  headers.set("Access-Control-Allow-Credentials", "true");
  return headers;
}

function withCors(response: Response, origin: string | null) {
  const headers = new Headers(response.headers);
  corsHeaders(origin).forEach((value, key) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cloneResponse(response: Response) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function shouldIncludeBody(method: string) {
  const upper = method.toUpperCase();
  return upper !== "GET" && upper !== "HEAD";
}
