export interface Env {
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

    // ヘルスチェック
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
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

      return new Response(runpodResponse.body, runpodResponse);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
