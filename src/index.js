
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

// ChatGPT Cloudflare Lab V7
// MCP + D1 + GitHub Image Storage + iPad Dashboard

const VERSION = "7.0.0";

const GITHUB_OWNER = "tamanh230893-arch";
const GITHUB_REPO = "chatgpt-lab-images";
const GITHUB_BRANCH = "main";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

// ----------------------------
// Helpers
// ----------------------------

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

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

  if (typeof base64 !== "string") {
    throw new Error("Invalid image data");
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
    character => character.charCodeAt(0)
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

  const prefix =
    `/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/images/`;

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "raw.githubusercontent.com" ||
    !parsed.pathname.startsWith(prefix) ||
    !/\.(png|jpg|jpeg|webp)$/i.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Invalid GitHub image URL");
  }

  return parsed.href;
}

function validatePost(data) {
  if (
    !data ||
    typeof data.title !== "string" ||
    typeof data.content !== "string"
  ) {
    throw new Error("Invalid post data");
  }

  const title = data.title.trim();
  const content = data.content.trim();

  if (
    !title ||
    !content ||
    title.length > 200 ||
    content.length > 15000
  ) {
    throw new Error(
      "Title or content is empty or too long"
    );
  }

  return { title, content };
}

// ----------------------------
// GitHub image upload
// ----------------------------

async function uploadToGitHub(
  env,
  imageBase64,
  mimeType
) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is missing");
  }

  const image = decodeImage(
    imageBase64,
    mimeType
  );

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

// ----------------------------
// D1 functions
// ----------------------------

async function listPosts(env) {
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

  return results;
}

async function savePost(
  env,
  title,
  content,
  imageUrl = null
) {
  const post = validatePost({
    title,
    content
  });

  const validImageUrl = imageUrl
    ? validateImageUrl(imageUrl)
    : null;

  const result = await env.DB.prepare(
    `INSERT INTO posts
       (title, content, image_url, status)
     VALUES (?, ?, ?, 'draft')`
  )
    .bind(
      post.title,
      post.content,
      validImageUrl
    )
    .run();

  return {
    success: true,
    id: result.meta.last_row_id,
    image_url: validImageUrl,
    status: "draft"
  };
}

// ----------------------------
// MCP Server - preserve V6 tools
// ----------------------------

function createServer(env) {
  const server = new McpServer({
    name: "ChatGPT Cloudflare Lab",
    version: VERSION
  });

  server.registerTool(
    "list_posts",
    {
      description:
        "Read the latest 50 posts from Cloudflare D1. Read-only.",
      inputSchema: {}
    },
    async () => {
      try {
        const posts = await listPosts(env);

        return toolResult({
          success: true,
          count: posts.length,
          posts
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
        return toolResult(
          await savePost(
            env,
            title,
            content
          )
        );
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

  server.registerTool(
    "upload_image",
    {
      description:
        "Upload a PNG, JPEG or WebP image, maximum 2 MB, " +
        "to the public GitHub image repository. " +
        "Requires explicit user approval. " +
        "Accepts actual Base64 image data.",
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
        return toolResult(
          await uploadToGitHub(
            env,
            image_base64,
            mime_type
          )
        );
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
        return toolResult(
          await savePost(
            env,
            title,
            content,
            image_url
          )
        );
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

// ----------------------------
// Dashboard HTML
// ----------------------------

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport"
 content="width=device-width, initial-scale=1">

<title>AI Control Center V7</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 18px;
  background: #f3f5f9;
  font-family: system-ui, sans-serif;
  color: #172033;
}

.container {
  max-width: 760px;
  margin: auto;
}

h1 {
  font-size: 26px;
  margin-bottom: 6px;
}

.subtitle {
  color: #64748b;
  margin-bottom: 22px;
}

.card {
  background: white;
  padding: 20px;
  border-radius: 16px;
  margin-bottom: 18px;
  box-shadow: 0 3px 14px rgba(0,0,0,.05);
}

label {
  display: block;
  font-weight: 600;
  margin: 14px 0 7px;
}

input[type="text"],
textarea {
  width: 100%;
  padding: 13px;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  font-size: 16px;
  font-family: inherit;
}

textarea {
  min-height: 220px;
  resize: vertical;
}

input[type="file"] {
  width: 100%;
  padding: 12px 0;
}

button {
  border: 0;
  background: #2563eb;
  color: white;
  padding: 14px 20px;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
}

button:disabled {
  opacity: .55;
  cursor: wait;
}

.secondary {
  background: #475569;
}

#preview {
  max-width: 100%;
  max-height: 300px;
  border-radius: 10px;
  margin-top: 12px;
  display: none;
}

#message {
  margin-top: 14px;
  white-space: pre-wrap;
  font-weight: 600;
}

.post {
  padding: 15px 0;
  border-bottom: 1px solid #e2e8f0;
}

.post:last-child {
  border-bottom: 0;
}

.post h3 {
  margin: 0 0 6px;
  overflow-wrap: anywhere;
}

.post p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #475569;
}

.post img {
  max-width: 220px;
  width: 100%;
  border-radius: 8px;
}

.status {
  display: inline-block;
  padding: 4px 9px;
  border-radius: 20px;
  background: #dbeafe;
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 700;
}

.note {
  font-size: 13px;
  color: #64748b;
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
</head>

<body>
<div class="container">

<h1>🤖 AI Control Center V7</h1>
<p class="subtitle">
  Quản lý bài viết Facebook bằng iPad
</p>

<section class="card">
<h2>✍️ Tạo bài viết mới</h2>

<form id="postForm">

<label for="title">Tiêu đề</label>
<input
  id="title"
  type="text"
  maxlength="200"
  placeholder="Nhập tiêu đề bài viết"
  required
>

<label for="content">Nội dung</label>
<textarea
  id="content"
  maxlength="15000"
  placeholder="Nhập nội dung Facebook..."
  required
></textarea>

<label for="image">Hình ảnh</label>
<input
  id="image"
  type="file"
  accept="image/png,image/jpeg,image/webp"
>

<img id="preview" alt="Xem trước hình ảnh">

<p class="note">
  Hỗ trợ PNG, JPG, WebP. Tối đa 2 MB.
</p>

<button id="saveButton" type="submit">
  💾 Lưu bản nháp
</button>

<div id="message" role="status"></div>

</form>
</section>

<section class="card">
<h2>📋 Danh sách bài viết</h2>

<div class="actions">
<button
  class="secondary"
  id="refreshButton"
  type="button"
>
  🔄 Làm mới
</button>
</div>

<div id="posts">
  Đang tải...
</div>

</section>

<p class="note">
  Phiên bản thử nghiệm.
  Không có chức năng đăng Facebook tự động.
</p>

</div>

<script>
const form = document.getElementById("postForm");
const imageInput = document.getElementById("image");
const preview = document.getElementById("preview");
const message = document.getElementById("message");
const saveButton = document.getElementById("saveButton");
const postsContainer = document.getElementById("posts");

imageInput.addEventListener("change", function () {
  const file = imageInput.files[0];

  if (!file) {
    preview.style.display = "none";
    preview.removeAttribute("src");
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    alert("Ảnh phải nhỏ hơn hoặc bằng 2 MB");
    imageInput.value = "";
    preview.style.display = "none";
    return;
  }

  const url = URL.createObjectURL(file);

  preview.onload = function () {
    URL.revokeObjectURL(url);
  };

  preview.src = url;
  preview.style.display = "block";
});

function readFileAsBase64(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();

    reader.onload = function () {
      const value = String(reader.result);
      resolve(value.split(",")[1]);
    };

    reader.onerror = function () {
      reject(new Error("Không đọc được ảnh"));
    };

    reader.readAsDataURL(file);
  });
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(
      data.error || "Yêu cầu thất bại"
    );
  }

  return data;
}

form.addEventListener("submit", async function (event) {
  event.preventDefault();

  const title = document.getElementById("title").value.trim();
  const content = document.getElementById("content").value.trim();
  const file = imageInput.files[0];

  if (!title || !content) {
    message.textContent = "Vui lòng nhập tiêu đề và nội dung.";
    return;
  }

  if (!confirm("Lưu bài viết này vào Cloudflare D1 dưới dạng draft?")) {
    return;
  }

  saveButton.disabled = true;
  message.style.color = "#1d4ed8";
  message.textContent = "Đang xử lý...";

  try {
    let imageUrl = null;

    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        throw new Error("Ảnh vượt quá 2 MB");
      }

      message.textContent = "Đang tải ảnh lên GitHub...";

      const imageBase64 = await readFileAsBase64(file);

      const uploaded = await requestJson(
        "/api/upload-image",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            image_base64: imageBase64,
            mime_type: file.type
          })
        }
      );

      imageUrl = uploaded.image_url;
    }

    message.textContent = "Đang lưu vào D1...";

    const saved = await requestJson(
      "/api/posts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: title,
          content: content,
          image_url: imageUrl
        })
      }
    );

    message.style.color = "#15803d";
    message.textContent =
      "✅ Đã lưu POST-" +
      String(saved.id).padStart(4, "0") +
      " | Trạng thái: draft";

    form.reset();
    preview.style.display = "none";
    preview.removeAttribute("src");

    await loadPosts();

  } catch (error) {
    message.style.color = "#b91c1c";
    message.textContent =
      "❌ " + error.message +
      "\\nNếu ảnh đã tải lên nhưng lưu D1 lỗi, " +
      "ảnh có thể vẫn nằm trên GitHub.";
  } finally {
    saveButton.disabled = false;
  }
});

function createTextElement(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

async function loadPosts() {
  postsContainer.textContent = "Đang tải...";

  try {
    const data = await requestJson("/api/posts");

    postsContainer.replaceChildren();

    if (!data.posts.length) {
      postsContainer.textContent = "Chưa có bài viết.";
      return;
    }

    data.posts.forEach(function (post) {
      const card = document.createElement("div");
      card.className = "post";

      const heading = createTextElement(
        "h3",
        "POST-" +
        String(post.id).padStart(4, "0") +
        " — " + post.title
      );

      const status = createTextElement(
        "span",
        post.status || "draft"
      );
      status.className = "status";

      const content = createTextElement(
        "p",
        post.content || ""
      );

      card.append(heading, status, content);

      if (post.image_url) {
        const img = document.createElement("img");
        img.src = post.image_url;
        img.alt = "Ảnh bài viết";
        img.loading = "lazy";
        card.appendChild(img);
      }

      postsContainer.appendChild(card);
    });

  } catch (error) {
    postsContainer.textContent =
      "Không tải được bài viết: " + error.message;
  }
}

document.getElementById("refreshButton")
  .addEventListener("click", loadPosts);

loadPosts();
</script>
</body>
</html>`;
}

// ----------------------------
// Worker routes
// ----------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Preserve existing MCP endpoint
    if (path === "/mcp") {
      return createMcpHandler(
        () => createServer(env)
      )(request, env, ctx);
    }

    // Health check
    if (path === "/" && method === "GET") {
      return json({
        project: "ChatGPT Cloudflare Lab",
        version: VERSION,
        status: "running",
        dashboard: "/dashboard",
        mcp: "/mcp",
        tools: [
          "list_posts",
          "save_post",
          "upload_image",
          "save_post_with_image"
        ]
      });
    }

    // iPad Dashboard
    if (
      path === "/dashboard" &&
      method === "GET"
    ) {
      return new Response(dashboardHtml(), {
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer"
        }
      });
    }

    // Read posts
    if (
      path === "/api/posts" &&
      method === "GET"
    ) {
      try {
        const posts = await listPosts(env);

        return json({
          success: true,
          count: posts.length,
          posts
        });
      } catch {
        return json(
          {
            success: false,
            error: "Database read failed"
          },
          500
        );
      }
    }

    // Upload image via HTTP
    if (
      path === "/api/upload-image" &&
      method === "POST"
    ) {
      try {
        const contentLength = Number(
          request.headers.get("content-length") || 0
        );

        if (contentLength > 3 * 1024 * 1024) {
          return json({
            success: false,
            error: "Request is too large"
          }, 413);
        }

        const data = await request.json();

        const uploaded = await uploadToGitHub(
          env,
          data.image_base64,
          data.mime_type
        );

        return json(uploaded);

      } catch (error) {
        return json({
          success: false,
          error: error.message
        }, 400);
      }
    }

    // Save text or image draft
    if (
      path === "/api/posts" &&
      method === "POST"
    ) {
      try {
        const data = await request.json();

        const saved = await savePost(
          env,
          data.title,
          data.content,
          data.image_url || null
        );

        return json(saved);

      } catch (error) {
        return json({
          success: false,
          error: error.message
        }, 400);
      }
    }

    return json({
      error: "Not found"
    }, 404);
  }
};
