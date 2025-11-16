export interface Env {
  FASTAPI_BASE_URL: string;
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
      const fastapiResponse = await fetch(targetUrl, new Request(targetUrl, request));

      return withCors(new Response(fastapiResponse.body, fastapiResponse), origin);
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

      return withCors(new Response(runpodResponse.body, runpodResponse), origin);
    }

    return withCors(Response.json({ error: "not_found" }, { status: 404 }), origin);
  },
};

function corsHeaders(origin: string | null) {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin ?? "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
