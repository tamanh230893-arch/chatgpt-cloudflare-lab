
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const OWNER = "tamanh230893-arch";
const REPO = "chatgpt-lab-images";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function toolResult(data, isError = false) {
  return {
    isError,
    content: [{ type: "text", text: JSON.stringify(data) }]
  };
}

function decodeImage(base64, mimeType) {
  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp"
  };

  const extension = extensions[mimeType];
  if (!extension) throw new Error("Unsupported image type");

  const clean = base64.replace(
    /^data:image\/(?:png|jpeg|webp);base64,/,
    ""
  );

  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) ||
    clean.length % 4 !== 0 ||
    clean.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
  ) {
    throw new Error("Invalid or oversized Base64 image");
  }

  const bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0));

  if (bytes.length > MAX_IMAGE_BYTES || bytes.length === 0) {
    throw new Error("Image must be 2 MB or smaller");
  }

  const isPng = bytes.length >= 8 &&
    [137,80,78,71,13,10,26,10].every(
      (v, i) => bytes[i] === v
    );

  const isJpeg = bytes.length >= 3 &&
    bytes[0] === 255 && bytes[1] === 216 &&
    bytes[2] === 255;

  const isWebp = bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";

  if (
    !(mimeType === "image/png" && isPng) &&
    !(mimeType === "image/jpeg" && isJpeg) &&
    !(mimeType === "image/webp" && isWebp)
  ) {
    throw new Error("Image content does not match MIME type");
  }

  return extension;
}

async function uploadToGitHub(env, imageBase64, mimeType) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is missing");
  }

  const extension = decodeImage(imageBase64, mimeType);
  const cleanBase64 = imageBase64.replace(
    /^data:image\/(?:png|jpeg|webp);base64,/,
    ""
  );

  const filename = `${crypto.randomUUID()}.${extension}`;
  const path = `images/${filename}`;

  const endpoint =
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ChatGPT-Cloudflare-Lab",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Upload image ${filename}`,
      content: cleanBase64,
      branch: "main"
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub upload failed: HTTP ${response.status}`);
  }

  return {
    success: true,
    filename,
    path,
    image_url:
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${path}`
  };
}

function createServer(env) {
  const server = new McpServer({
    name: "ChatGPT Cloudflare Lab",
    version: "5.0.0"
  });

  // Existing read-only tool
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

        return toolResult({
          success: true,
          posts: results
        });
      } catch {
        return toolResult(
          { success: false, error: "Database read failed" },
          true
        );
      }
    }
  );

  // Existing save tool
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
        ).bind(title, content).run();

        return toolResult({
          success: true,
          id: result.meta.last_row_id,
          status: "draft"
        });
      } catch {
        return toolResult(
          { success: false, error: "Database write failed" },
          true
        );
      }
    }
  );

  // New image upload tool
  server.registerTool(
    "upload_image",
    {
      description:
        "Upload a PNG, JPEG or WebP image (maximum 2 MB) to the public GitHub image repository. Requires explicit user approval. Accepts actual Base64 image data, not a filename or a ChatGPT image reference.",
      inputSchema: {
        image_base64: z.string().min(1),
        mime_type: z.enum([
          "image/png",
          "image/jpeg",
          "image/webp"
        ])
      }
    },
    async ({ image_base64, mime_type }) => {
      try {
        const result = await uploadToGitHub(
          env, image_base64, mime_type
        );
        return toolResult(result);
      } catch (error) {
        return toolResult({
          success: false,
          error: error.message
        }, true);
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
        version: "V5",
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
      ).bind(data.title.trim(), data.content.trim()).run();

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
