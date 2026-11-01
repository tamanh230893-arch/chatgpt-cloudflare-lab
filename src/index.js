
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        project: "ChatGPT Cloudflare Lab",
        version: "V1",
        status: "running",
        message: "Worker is working!"
      });
    }

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "chatgpt-cloudflare-lab"
      });
    }

    return Response.json(
      { error: "Not found" },
      { status: 404 }
    );
  }
};
