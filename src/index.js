
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

// =====================================================
// ChatGPT Cloudflare Lab V6
// Cloudflare Worker + D1 + GitHub Image Storage
// =====================================================

const VERSION = "6.0.0";

const GITHUB_OWNER = "tamanh230893-arch";
const GITHUB_REPO = "chatgpt-lab-images";
const GITHUB_BRANCH = "main";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

// =====================================================
// Helpers
// =====================================================

function toolResult(data, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(data)
      }
    ]
  };
}

function decodeImage(base64, mimeType) {
  const extension = ALLOWED_IMAGE_TYPES[mimeType];

  if (!extension) {
    throw new Error("Unsupported image type");
  }

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

  const bytes = Uint8Array.from(
    atob(clean),
    (character) => character.charCodeAt(0)
  );

  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_BYTES
  ) {
    throw new Error("Image must be 2 MB or smaller");
  }

  const isPng =
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value
    );

  const isJpeg =
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255;

  const isWebp =
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";

  const valid =
    (mimeType === "image/png" && isPng) ||
    (mimeType === "image/jpeg" && isJpeg) ||
    (mimeType === "image/webp" && isWebp);

  if (!valid) {
    throw new Error("Image content does not match MIME type");
  }

  return {
    extension,
    base64: clean
  };
}

function validateImageUrl(imageUrl) {
  let parsed;

  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("Invalid image URL");
  }

  const expectedPrefix =
    `/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/images/`;

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "raw.githubusercontent.com" ||
    !parsed.pathname.startsWith(expectedPrefix) ||
    !/\.(png|jpg|jpeg|webp)$/i.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Image URL must belong to the GitHub image repository");
  }

  return parsed.href;
}

// =====================================================
// Upload Image to GitHub
// =====================================================

async function uploadToGitHub(
  env,
  imageBase64,
  mimeType
) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is missing");
  }

  const image = decodeImage(imageBase64, mimeType);

  const filename =
    `${crypto.randomUUID()}.${image.extension}`;

  const path = `images/${filename}`;

  const endpoint =
    `https://api.github.com/repos/` +
    `${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;

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
      content: image.base64,
      branch: GITHUB_BRANCH
    })
  });

  if (!response.ok) {
    throw new Error(
      `GitHub upload failed: HTTP ${response.status}`
    );
  }

  return {
    success: true,
    filename,
    path,
    image_url:
      `https://raw.githubusercontent.com/` +
      `${GITHUB_OWNER}/${GITHUB_REPO}/` +
      `${GITHUB_BRANCH}/${path}`
  };
}

// =====================================================
// MCP Server
// =====================================================

function createServer(env) {
  const server = new McpServer({
    name: "ChatGPT Cloudflare Lab",
    version: VERSION
  });

  // ---------------------------------------------------
  // Tool 1: list_posts
  // ---------------------------------------------------

  server.registerTool(
    "list_posts",
    {
      description:
        "Read the latest 50 posts from Cloudflare D1. Read-only.",
      inputSchema: {}
    },
    async () => {
      try {
        const { results } = await env.DB.prepare(
          `SELECT
             id,
             title,
             content,
             image_url,
             status,
             created_at
           FROM posts
           ORDER BY id DESC
           LIMIT 50`
        ).all();

        return toolResult({
          success: true,
          count: results.length,
          posts: results
        });
      } catch {
        return toolResult(
          {
            success: false,
            error: "Database read failed"
          },
          true
        );
      }
    }
  );

  // ---------------------------------------------------
  // Tool 2: save_post
  // ---------------------------------------------------

  server.registerTool(
    "save_post",
    {
      description:
        "Save a text-only draft to Cloudflare D1. " +
        "Only call after explicit user confirmation.",
      inputSchema: {
        title: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(15000)
      }
    },
    async ({ title, content }) => {
      try {
        const result = await env.DB.prepare(
          `INSERT INTO posts
             (title, content, status)
           VALUES (?, ?, 'draft')`
        )
          .bind(title.trim(), content.trim())
          .run();

        return toolResult({
          success: true,
          id: result.meta.last_row_id,
          status: "draft"
        });
      } catch {
        return toolResult(
          {
            success: false,
            error: "Database write failed"
          },
          true
        );
      }
    }
  );

  // ---------------------------------------------------
  // Tool 3: upload_image
  // ---------------------------------------------------

  server.registerTool(
    "upload_image",
    {
      description:
        "Upload an actual PNG, JPEG or WebP image " +
        "(maximum 2 MB) to the public GitHub repository. " +
        "Requires explicit user approval. " +
        "Accepts real Base64 image data, not a filename " +
        "or a ChatGPT image reference.",
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
          env,
          image_base64,
          mime_type
        );

        return toolResult(result);
      } catch (error) {
        return toolResult(
          {
            success: false,
            error: error.message
          },
          true
        );
      }
    }
  );

  // ---------------------------------------------------
  // Tool 4: save_post_with_image
  // ---------------------------------------------------

  server.registerTool(
    "save_post_with_image",
    {
      description:
        "Save a Facebook draft with title, content and " +
        "an existing GitHub image URL to Cloudflare D1. " +
        "Only call after explicit user confirmation. " +
        "Never publish to Facebook.",
      inputSchema: {
        title: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(15000),
        image_url: z.string().url()
      }
    },
    async ({ title, content, image_url }) => {
      try {
        const validImageUrl =
          validateImageUrl(image_url);

        const result = await env.DB.prepare(
          `INSERT INTO posts
             (title, content, image_url, status)
           VALUES (?, ?, ?, 'draft')`
        )
          .bind(
            title.trim(),
            content.trim(),
            validImageUrl
          )
          .run();

        return toolResult({
          success: true,
          id: result.meta.last_row_id,
          image_url: validImageUrl,
          status: "draft"
        });
      } catch (error) {
        return toolResult(
          {
            success: false,
            error: error.message
          },
          true
        );
      }
    }
  );

  return server;
}

// =====================================================
// Cloudflare Worker
// =====================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // MCP endpoint
    if (url.pathname === "/mcp") {
      return createMcpHandler(
        () => createServer(env)
      )(request, env, ctx);
    }

    // Health check
    if (url.pathname === "/") {
      return Response.json({
        project: "ChatGPT Cloudflare Lab",
        version: "V6",
        status: "running",
        mcp: "/mcp",
        tools: [
          "list_posts",
          "save_post",
          "upload_image",
          "save_post_with_image"
        ]
      });
    }

    // Read posts via HTTP API
    if (
      url.pathname === "/api/posts" &&
      request.method === "GET"
    ) {
      try {
        const { results } = await env.DB.prepare(
          `SELECT *
           FROM posts
           ORDER BY id DESC
           LIMIT 50`
        ).all();

        return Response.json({
          success: true,
          count: results.length,
          posts: results
        });
      } catch {
        return Response.json(
          { success: false, error: "Database read failed" },
          { status: 500 }
        );
      }
    }

    // Save text-only draft via HTTP API
    if (
      url.pathname === "/api/posts" &&
      request.method === "POST"
    ) {
      try {
        const data = await request.json();

        if (
          typeof data.title !== "string" ||
          typeof data.content !== "string" ||
          !data.title.trim() ||
          !data.content.trim() ||
          data.title.trim().length > 200 ||
          data.content.trim().length > 15000
        ) {
          return Response.json(
            { success: false, error: "Invalid data" },
            { status: 400 }
          );
        }

        const result = await env.DB.prepare(
          `INSERT INTO posts
             (title, content, status)
           VALUES (?, ?, 'draft')`
        )
          .bind(
            data.title.trim(),
            data.content.trim()
          )
          .run();

        return Response.json({
          success: true,
          id: result.meta.last_row_id,
          status: "draft"
        });
      } catch {
        return Response.json(
          { success: false, error: "Database write failed" },
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
