/**
 * Vision Bridge — 图片识别桥接扩展
 *
 * 主模型（如 deepseek-v4-flash）不支持图片时，自动把图片识别任务交给
 * 视觉模型（默认 opencode-go / gpt-5.6-luna），并把识别出的文字描述
 * 交回给主模型继续处理。
 *
 * 两个入口：
 * 1. 自动拦截：粘贴 / 拖入图片时，若当前模型不支持图片，自动调用视觉模型
 *    识别，把文字描述注入本轮 prompt；原图不发送给主模型。
 * 2. analyze_image 工具：主模型在会话中遇到图片路径 / URL 时主动调用，
 *    返回识别结果文字，主模型继续处理。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VISION_PROVIDER = "opencode-go";
/** 候选视觉模型，按顺序尝试；第一个可用（且能成功返回）的会被记住并优先使用。
 *  gpt-5.6-luna 在某些地区会被上游 403（This model is not available in your region），
 *  此时自动回退到 kimi-k2.6 等。 */
const VISION_MODEL_CANDIDATES = [
  "gpt-5.6-luna",
  "kimi-k2.6",
  "kimi-k3",
  "qwen3.8-max",
  "qwen3.6-plus",
  "minimax-m3",
  "mimo-v2.5",
];
const VISION_TIMEOUT_MS = 120_000;
/** 识别模型单次响应的最大输出 token（防大图/多图描述截断） */
const VISION_MAX_TOKENS = 16_000;
/** 记住当前可用的视觉模型（避免每次先撞一次被封锁的模型） */
const STATE_FILE = new URL(".state.json", import.meta.url).pathname;
const DEFAULT_DESCRIBE_PROMPT =
  "请仔细识别这张图片，尽可能完整、准确地描述所有内容：所有可见文本（逐字转录，保留代码原文）、界面布局、图表、表格、物体、场景等。看不清的内容不要猜测，直接说明。";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/** 粘贴图片的落盘目录（供主模型追问细节时用 analyze_image 再次读取） */
const IMAGES_CACHE_DIR = fileURLToPath(new URL("./images/", import.meta.url));
/** 缓存目录最多保留的图片数（超出删除最旧的） */
const MAX_CACHED_IMAGES = 50;
const VISION_SYSTEM_PROMPT =
  "You are an image recognition assistant. Your job is to transcribe and describe images accurately and completely for a text-only LLM to process. Be precise, objective, and exhaustive. Preserve original code and text verbatim.";

function loadState(): { model?: string } {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** 把粘贴的图片落盘到缓存目录，返回保存路径；顺带清理超出上限的旧文件。 */
async function saveImageToCache(data: string, mimeType: string, index: number): Promise<string> {
  await mkdir(IMAGES_CACHE_DIR, { recursive: true });
  const ext = EXT_BY_MIME[mimeType] ?? "png";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(IMAGES_CACHE_DIR, `${stamp}-${index}.${ext}`);
  await writeFile(file, Buffer.from(data, "base64"));
  // 清理：只保留最近的 MAX_CACHED_IMAGES 个文件
  try {
    const files = (await readdir(IMAGES_CACHE_DIR)).map((f) => join(IMAGES_CACHE_DIR, f));
    if (files.length > MAX_CACHED_IMAGES) {
      const sorted = (await Promise.all(files.map(async (f) => ({ f, t: (await stat(f)).mtimeMs }))))
        .sort((a, b) => b.t - a.t);
      for (const { f } of sorted.slice(MAX_CACHED_IMAGES)) {
        await rm(f, { force: true });
      }
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
  return file;
}

function saveState(state: { model?: string }) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    /* 忽略状态写入失败 */
  }
}

interface ImageInput {
  data: string; // base64
  mimeType: string;
}

export default function (pi: ExtensionAPI) {
  /** 调用视觉模型识别图片，返回文字描述。 */
  async function describeImages(
    images: ImageInput[],
    opts: { prompt: string; signal?: AbortSignal },
    ctx: ExtensionContext
  ) {
    const registry = ctx.modelRegistry;
    const provider = registry.getProvider(VISION_PROVIDER);
    if (!provider) {
      throw new Error(`provider ${VISION_PROVIDER} 不可用`);
    }
    const auth = await registry.getProviderAuth(VISION_PROVIDER);
    const timeoutSignal = AbortSignal.timeout(VISION_TIMEOUT_MS);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal;

    // 候选模型顺序：上次成功的优先 → 配置的候选列表 → provider 上任意图片模型
    const state = loadState();
    const candidates = [
      ...(state.model ? [state.model] : []),
      ...VISION_MODEL_CANDIDATES,
      ...registry
        .getAll()
        .filter((m) => m.provider === VISION_PROVIDER && m.input.includes("image"))
        .map((m) => m.id),
    ].filter((id, i, arr) => arr.indexOf(id) === i);

    let lastError: Error | undefined;
    for (const modelId of candidates) {
      const model = registry.find(VISION_PROVIDER, modelId);
      if (!model) continue;
      try {
        const stream = provider.stream(
          model,
          {
            systemPrompt: VISION_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [
                  ...images.map((img) => ({
                    type: "image" as const,
                    data: img.data,
                    mimeType: img.mimeType,
                  })),
                  { type: "text" as const, text: opts.prompt },
                ],
              },
            ],
          },
          { signal, apiKey: auth?.auth?.apiKey, maxTokens: VISION_MAX_TOKENS }
        );

        let text = "";
        let usage: unknown;
        for await (const ev of stream) {
          if (ev.type === "text_delta") {
            text += ev.delta;
          } else if (ev.type === "error") {
            throw new Error(ev.error.errorMessage || "视觉模型调用失败");
          } else if (ev.type === "done") {
            usage = ev.message.usage;
          }
        }
        if (!text.trim()) throw new Error("视觉模型未返回任何文字内容");
        if (state.model !== modelId) saveState({ model: modelId });
        return { text, usage };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // 只对被封锁/报错的模型切换下一个，正常返回则直接用
      }
    }
    throw new Error(
      `所有候选视觉模型都失败：${lastError?.message ?? "未知错误"}`
    );
  }

  // ---------- 1. 自动拦截：粘贴图片且当前模型不支持图片 ----------
  pi.on("input", async (event, ctx) => {
    if (!event.images || event.images.length === 0) return { action: "continue" };
    const model = ctx.model;
    if (model && model.input.includes("image")) return { action: "continue" }; // 当前模型能看图，不干预

    ctx.ui.notify(
      `当前模型 ${model?.id ?? "(未知)"} 不支持图片，自动调用视觉模型识别中…`,
      "info"
    );
    try {
      const results: string[] = [];
      for (let i = 0; i < event.images.length; i++) {
        const img = event.images[i];
        // 把用户原始问题一并传给识别模型：优先回答该问题，同时保持完整转录
        const { text } = await describeImages(
          [{ data: img.data, mimeType: img.mimeType }],
          {
            prompt:
              `图片 ${i + 1}：${DEFAULT_DESCRIBE_PROMPT}\n` +
              `用户在问：${event.text}\n` +
              "请优先围绕用户的问题给出准确、详细的回答；之后仍请完整转录图中其余可见文本，不要遗漏。",
          },
          ctx
        );
        const saved = await saveImageToCache(img.data, img.mimeType, i);
        results.push(
          `【图片 ${i + 1}】\n${text}\n` +
            `（原图已保存至：${saved}，供后续追问细节使用）`
        );
      }
      const newText =
        `${event.text}\n\n` +
        `== 图片识别结果（由视觉模型生成，以下为文字描述，原图未发送给主模型）==\n` +
        results.join("\n\n") +
        `\n== 图片识别结束 ==\n` +
        `后续若用户追问图片某个局部的细节（如小字、丝印、图表数值、角落内容），` +
        `请调用 analyze_image 工具，path 参数填对应图片的「原图已保存至」路径，` +
        `并在 prompt 参数中描述你关注的区域和问题。`;
      // 图片保留在会话历史中：切到原生视觉模型时旧图可再次可见；
      // 主模型（文本）请求时 pi 会自动降级为占位符，不影响请求。
      return { action: "transform", text: newText };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`图片识别失败：${msg}`, "error");
      return { action: "continue" }; // 回退到 pi 默认行为（图片被忽略）
    }
  });

  // ---------- 2. analyze_image 工具：主模型主动调用 ----------
  pi.registerTool({
    name: "analyze_image",
    label: "Analyze Image",
    description:
      "识别图片内容并返回文字描述。接受本地图片路径或 http(s) 图片 URL。由视觉模型（候选列表自动选择可用模型）执行识别，返回的文字描述可直接用于后续处理。用户追问已识别图片的局部细节时也用它：path 填此前「原图已保存至」的路径，prompt 描述关注的区域。",
    promptSnippet: "识别图片内容（本地路径或 URL），返回文字描述",
    promptGuidelines: [
      "当前主模型不支持直接查看图片。当需要查看图片、截图或图像内容时，必须使用 analyze_image 工具（传本地路径或 URL），不要用 read 读取图片文件（图片会被忽略）。",
      "用户追问已识别图片的局部细节（小字、丝印、图表数值、角落内容）时，调用 analyze_image，path 填会话中「原图已保存至」给出的路径，prompt 描述关注的区域和问题。",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "图片文件的本地路径，或 http(s) 图片 URL" }),
      prompt: Type.Optional(
        Type.String({
          description: "可选的识别要求，例如「转录图中所有代码」「描述图表中的数据」",
        })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const target = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      let data: string;
      let mimeType: string;
      if (/^https?:\/\//i.test(target)) {
        const resp = await fetch(target, { signal: signal ?? undefined });
        if (!resp.ok) throw new Error(`下载图片失败: HTTP ${resp.status}`);
        data = Buffer.from(await resp.arrayBuffer()).toString("base64");
        mimeType = resp.headers.get("content-type") ?? "image/png";
      } else {
        const abs = resolve(ctx.cwd, target);
        data = (await readFile(abs)).toString("base64");
        mimeType = MIME_BY_EXT[extname(abs).toLowerCase()] ?? "image/png";
      }

      const prompt = params.prompt ?? DEFAULT_DESCRIBE_PROMPT;
      const { text, usage } = await describeImages(
        [{ data, mimeType }],
        { prompt, signal },
        ctx
      );
      return {
        content: [{ type: "text", text }],
        details: { source: target, mimeType },
        usage,
      };
    },
  });
}
