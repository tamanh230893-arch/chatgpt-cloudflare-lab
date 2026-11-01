
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        project: "ChatGPT Cloudflare Lab",
        version: "V3",
        status: "running",
        authentication: "disabled"
      });
    }

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        version: "V3"
      });
    }

    if (url.pathname === "/api/posts" &&
        request.method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT * FROM posts ORDER BY id DESC LIMIT 50"
        ).all();

        return Response.json({
          success: true,
          count: results.length,
          posts: results
        });
      } catch (error) {
        return Response.json(
          { success: false, error: "Database read failed" },
          { status: 500 }
        );
      }
    }

    if (url.pathname === "/api/posts" &&
        request.method === "POST") {
      try {
        const data = await request.json();

        if (
          typeof data.title !== "string" ||
          typeof data.content !== "string" ||
          !data.title.trim() ||
          !data.content.trim() ||
          data.title.length > 200 ||
          data.content.length > 15000
        ) {
          return Response.json(
            { success: false, error: "Invalid data" },
            { status: 400 }
          );
        }

        const result = await env.DB.prepare(
          `INSERT INTO posts (title, content, status)
           VALUES (?, ?, 'draft')`
        )
          .bind(data.title.trim(), data.content.trim())
          .run();

        return Response.json({
          success: true,
          id: result.meta.last_row_id,
          status: "draft"
        }, { status: 201 });

      } catch (error) {
        return Response.json(
          { success: false, error: "Request failed" },
          { status: 400 }
        );
      }
    }

    return Response.json(
      { error: "Not found" },
      { status: 404 }
    );
  }
};
