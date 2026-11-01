
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        project: "ChatGPT Cloudflare Lab",
        version: "V2",
        status: "running",
        database: "D1 connected"
      });
    }

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "chatgpt-cloudflare-lab"
      });
    }

    if (
      url.pathname === "/api/posts" &&
      request.method === "GET"
    ) {
      try {
        const { results } = await env.DB
          .prepare(
            "SELECT id, title, content, image_url, status, created_at FROM posts ORDER BY id DESC LIMIT 50"
          )
          .all();

        return Response.json({
          success: true,
          count: results.length,
          posts: results
        });
      } catch (error) {
        return Response.json(
          {
            success: false,
            error: "Database query failed"
          },
          { status: 500 }
        );
      }
    }

    return Response.json(
      { error: "Not found" },
      { status: 404 }
    );
  }
};
