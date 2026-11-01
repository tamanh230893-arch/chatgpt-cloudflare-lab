
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer(env) {
  const server = new McpServer({
    name: "ChatGPT Cloudflare Lab",
    version: "4.0.0"
  });

  server.registerTool(
    "list_posts",
    {
      description: "Read draft posts from Cloudflare D1",
      inputSchema: {}
    },
    async () => {
      try {
        const { results } = await env.DB.prepare(
          `SELECT id, title, content, image_url,
                  status, created_at
           FROM posts
           ORDER BY id DESC LIMIT 50`
        ).all();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                posts: results
              })
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Database read failed" }
          ]
        };
      }
    }
  );

  server.registerTool(
    "save_post",
    {
      description:
        "Save a draft post to Cloudflare D1. Only call after the user explicitly confirms saving.",
      inputSchema: {
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(15000)
      }
    },
    async ({ title, content }) => {
      try {
        const result = await env.DB.prepare(
          `INSERT INTO posts (title, content, status)
           VALUES (?, ?, 'draft')`
        )
          .bind(title, content)
          .run();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                id: result.meta.last_row_id,
                status: "draft"
              })
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Database write failed" }
          ]
        };
      }
    }
  );

  return server;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return createMcpHandler(
        () => createServer(env)
      )(request, env, ctx);
    }

    if (url.pathname === "/") {
      return Response.json({
        project: "ChatGPT Cloudflare Lab",
        version: "V4",
        status: "running",
        mcp: "/mcp"
      });
    }

    if (
      url.pathname === "/api/posts" &&
      request.method === "GET"
    ) {
      const { results } = await env.DB.prepare(
        "SELECT * FROM posts ORDER BY id DESC LIMIT 50"
      ).all();

      return Response.json({
        success: true,
        count: results.length,
        posts: results
      });
    }

    if (
      url.pathname === "/api/posts" &&
      request.method === "POST"
    ) {
      const data = await request.json();

      if (
        typeof data.title !== "string" ||
        typeof data.content !== "string" ||
        !data.title.trim() ||
        !data.content.trim()
      ) {
        return Response.json(
          { error: "Invalid data" },
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
      });
    }

    return Response.json(
      { error: "Not found" },
      { status: 404 }
    );
  }
};
