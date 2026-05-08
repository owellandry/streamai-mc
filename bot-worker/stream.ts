/**
 * Stream pipeline: prismarine-viewer → puppeteer headless Chrome → ffmpeg → RTMP
 * Captures the bot's first-person view via CDP screencast and pipes JPEG frames to ffmpeg.
 */

import puppeteer from "puppeteer-core";
import type { Browser, Page, CDPSession } from "puppeteer-core";
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";

export interface StreamTarget {
  platform: string;
  rtmp_url: string;
  stream_key: string;
}

export interface StreamConfig {
  botName: string;
  viewerUrl: string;
  targets: StreamTarget[];
  width?: number;
  height?: number;
  fps?: number;
  videoBitrate?: string;
  audioBitrate?: string;
  ambientAudio?: string;
}

let browser: Browser | null = null;
let page: Page | null = null;
let cdp: CDPSession | null = null;
let ffmpeg: ChildProcess | null = null;
let isStreaming = false;

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function startStream(config: StreamConfig): Promise<void> {
  if (isStreaming) {
    console.log(`[stream:${config.botName}] ya está activo`);
    return;
  }
  if (config.targets.length === 0) {
    console.warn(`[stream:${config.botName}] ⚠️  Sin targets RTMP configurados - streaming deshabilitado`);
    return; // Don't throw, just skip streaming
  }

  const chromePath = findChrome();
  if (!chromePath) {
    console.warn(`[stream:${config.botName}] ⚠️  Chrome/Edge no encontrado - streaming deshabilitado (define CHROME_PATH para habilitar)`);
    return; // Don't throw, just skip streaming
  }

  const width = config.width ?? 1280;
  const height = config.height ?? 720;
  const fps = config.fps ?? 30;
  const videoBitrate = config.videoBitrate ?? "2500k";
  const audioBitrate = config.audioBitrate ?? "128k";

  console.log(`[stream:${config.botName}] 🎬 Iniciando stream ${width}x${height}@${fps}fps → ${config.targets.map(t => t.platform).join(",")}`);

  try {
    // 1) Launch headless Chrome with the viewer
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--enable-webgl", "--use-gl=swiftshader",
        "--ignore-gpu-blocklist", "--ignore-gpu-blacklist",
        `--window-size=${width},${height}`,
        "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
      ],
      defaultViewport: { width, height },
    });
    console.log(`[stream:${config.botName}] ✓ Chrome lanzado`);

    page = await browser.newPage();
    await page.setViewport({ width, height });
    console.log(`[stream:${config.botName}] ✓ Conectando al viewer en ${config.viewerUrl}...`);
    await page.goto(config.viewerUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 6000)); // let WebGL + chunks warm up
    console.log(`[stream:${config.botName}] ✓ Viewer cargado`);
  } catch (err: any) {
    console.error(`[stream:${config.botName}] ❌ Error iniciando Chrome/viewer: ${err.message}`);
    // Cleanup on failure
    try { await browser?.close(); } catch {}
    browser = null; page = null;
    return;
  }

  // 2) Spawn ffmpeg: image2pipe (mjpeg) input + audio + RTMP output
  const ffArgs: string[] = [
    "-y",
    "-loglevel", "warning",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-r", String(fps),
    "-i", "pipe:0",
  ];
  if (config.ambientAudio && existsSync(config.ambientAudio)) {
    ffArgs.push("-stream_loop", "-1", "-i", config.ambientAudio);
  } else {
    ffArgs.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }
  const bufsizeKbps = parseInt(videoBitrate) * 2;
  ffArgs.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-b:v", videoBitrate,
    "-maxrate", videoBitrate,
    "-bufsize", `${bufsizeKbps}k`,
    "-g", String(fps * 2),
    "-keyint_min", String(fps),
    "-c:a", "aac",
    "-b:a", audioBitrate,
    "-ar", "44100",
    "-shortest",
  );
  if (config.targets.length === 1) {
    ffArgs.push("-f", "flv", `${config.targets[0]!.rtmp_url}/${config.targets[0]!.stream_key}`);
  } else {
    const tee = config.targets.map(t => `[f=flv:onfail=ignore]${t.rtmp_url}/${t.stream_key}`).join("|");
    ffArgs.push("-flags", "+global_header", "-f", "tee", tee);
  }

  try {
    ffmpeg = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "ignore", "pipe"] });
    ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      // Show meaningful errors only
      if (/Connection refused|Cannot open|Failed|Invalid|No such|Unknown|Error/.test(s)) {
        console.warn(`[stream:${config.botName}] ${s.slice(0, 250).trim()}`);
      }
    });
    ffmpeg.stdin?.on("error", () => {}); // silence EPIPE on shutdown
    ffmpeg.on("exit", (code) => {
      console.log(`[stream:${config.botName}] ffmpeg exit code=${code}`);
      isStreaming = false;
    });
    ffmpeg.on("error", (err) => {
      console.warn(`[stream:${config.botName}] ffmpeg error: ${err.message}`);
      isStreaming = false;
    });
    console.log(`[stream:${config.botName}] ✓ ffmpeg iniciado`);
  } catch (err: any) {
    console.error(`[stream:${config.botName}] ❌ Error iniciando ffmpeg (¿está instalado?): ${err.message}`);
    try { await page?.close(); } catch {}
    try { await browser?.close(); } catch {}
    browser = null; page = null;
    return;
  }

  // 3) Start CDP screencast and pipe frames to ffmpeg
  try {
    cdp = await page.createCDPSession();
    cdp.on("Page.screencastFrame", async (params: any) => {
      try {
        if (ffmpeg?.stdin?.writable) {
          ffmpeg.stdin.write(Buffer.from(params.data, "base64"));
        }
        if (cdp) await cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId });
      } catch {}
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    });
    console.log(`[stream:${config.botName}] ✓ Screencast iniciado`);
  } catch (err: any) {
    console.error(`[stream:${config.botName}] ❌ Error iniciando screencast: ${err.message}`);
    // Cleanup on failure
    try { ffmpeg?.kill("SIGKILL"); } catch {}
    try { await page?.close(); } catch {}
    try { await browser?.close(); } catch {}
    ffmpeg = null; cdp = null; page = null; browser = null;
    return;
  }

  isStreaming = true;
  console.log(`[stream:${config.botName}] ✅ activo`);
}

export async function stopStream(): Promise<void> {
  if (!isStreaming && !browser) return;
  console.log("[stream] 🛑 deteniendo");
  isStreaming = false;
  try { if (cdp) await cdp.send("Page.stopScreencast"); } catch {}
  try { ffmpeg?.stdin?.end(); } catch {}
  try { ffmpeg?.kill("SIGKILL"); } catch {}
  try { await page?.close(); } catch {}
  try { await browser?.close(); } catch {}
  cdp = null; ffmpeg = null; page = null; browser = null;
}

export function isActive(): boolean { return isStreaming; }
