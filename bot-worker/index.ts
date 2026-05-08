/**
 * StreamAI-MC — Bot Worker v5 (Mindcraft skills)
 * Uses battle-tested Mindcraft library for all gameplay
 */

import * as mc from "./lib/mcdata.js";
import * as skills from "./lib/skills.js";
import * as world from "./lib/world.js";
import { Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import mineflayerViewer from "prismarine-viewer";
import * as stream from "./stream.ts";
const { mineflayer: viewerPlugin } = mineflayerViewer as any;

// ── Config ────────────────────────────────────────────────────────────────
const BOT_NAME     = process.env.BOT_NAME     || "StreamBot";
const MC_HOST      = (process.env.MC_SERVER   || "localhost:25565").split(":")[0];
const MC_PORT      = parseInt((process.env.MC_SERVER || "localhost:25565").split(":")[1] || "25565");
const WORKER_PORT  = parseInt(process.env.WORKER_PORT || "3001");
const TEST_MODE    = process.env.TEST_MODE    === "1";
const PERSONALITY  = process.env.PERSONALITY  || "Un jugador de Minecraft";

// AI providers
const AI_PROVIDER     = (process.env.AI_PROVIDER || "openrouter").toLowerCase();
const OPENROUTER_KEY  = process.env.OPENROUTER_KEY || "";
const OPENROUTER_MODEL= process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";
const OPENROUTER_URL  = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_TIMEOUT = parseInt(process.env.OPENROUTER_TIMEOUT || "15000");
const NVIDIA_KEY      = process.env.NVIDIA_KEY || "";
const NVIDIA_MODEL    = process.env.NVIDIA_MODEL || "mistralai/mistral-medium-3.5-128b";
const NVIDIA_URL      = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_TIMEOUT  = parseInt(process.env.NVIDIA_TIMEOUT || "30000");
const OLLAMA_URL      = process.env.OLLAMA_URL     || "http://localhost:11434";
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL   || "qwen2.5:3b";
const OLLAMA_TIMEOUT  = parseInt(process.env.OLLAMA_TIMEOUT || "8000");

const hotGlobal = globalThis as any;
if (typeof hotGlobal.__streamAiMcWorkerCleanup === "function") {
  try { hotGlobal.__streamAiMcWorkerCleanup("Hot reload cleanup"); } catch {}
}

// ── Create bot using Mindcraft's initBot (loads all plugins) ───────────────
const bot = mc.initBot(BOT_NAME);
// Mindcraft's initBot sets bot.output for skill logging
bot.output = "";
bot.interrupt_code = false;

// Stub Mindcraft's modes system (skills.js uses bot.modes.isOn/pause/unpause)
const _modesState: Record<string, boolean> = {
  cheat: false,
  self_preservation: true,
  self_defense: true,
  cowardice: false,
  hunting: true,
  item_collecting: true,
  torch_placing: true,
  unstuck: true,
  elbow_room: true,
};
const _modesPaused = new Set<string>();
bot.modes = {
  isOn(mode: string): boolean {
    if (_modesPaused.has(mode)) return false;
    return _modesState[mode] ?? false;
  },
  pause(mode: string) { _modesPaused.add(mode); },
  unpause(mode: string) { _modesPaused.delete(mode); },
  unPauseAll() { _modesPaused.clear(); },
};

// ── State ─────────────────────────────────────────────────────────────────
let currentGoal     = "esperando spawn";
let isBusy          = false;
let lastAIChat      = 0;
const startTime     = Date.now();
const intervals: ReturnType<typeof setInterval>[] = [];
let httpServer: any = null;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function inv()  { return bot.inventory.items(); }
function invCount(name: string): number {
  return inv().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
}
function invCountMatch(p: RegExp): number {
  return inv().filter(i => p.test(i.name)).reduce((s, i) => s + i.count, 0);
}
function hasAny(...n: string[]) { return n.some(x => invCount(x) > 0); }
function logInv() { return inv().map(i => `${i.count}x${i.name}`).join(", ") || "vacío"; }
function inventoryFreeSlots(): number {
  try { return bot.inventory.emptySlotCount(); } catch { return 0; }
}

function stopMoving() {
  try { bot.pathfinder.setGoal(null); } catch {}
  try { bot.pathfinder.stop(); } catch {}
  try {
    bot.setControlState("forward", false);
    bot.setControlState("back", false);
    bot.setControlState("left", false);
    bot.setControlState("right", false);
    bot.setControlState("jump", false);
    bot.setControlState("sprint", false);
    bot.setControlState("sneak", false);
  } catch {}
}

// ── Natural head movement ───────────────────────────────────────────────
// Makes the bot look around naturally instead of staring straight ahead
async function naturalLook() {
  if (!bot.entity) return;
  // Look at nearest entity (mob, player, item) if close
  const nearEntity = bot.nearestEntity((e: any) => {
    if (!e?.position || !bot.entity) return false;
    const d = bot.entity.position.distanceTo(e.position);
    return d < 12 && d > 1;
  });
  if (nearEntity?.position) {
    try { await bot.lookAt(nearEntity.position.offset(0, nearEntity.height ?? 1, 0), false); } catch {}
    return;
  }
  // Look at target block if pathfinding
  const goal = (bot.pathfinder as any)?.goal;
  if (goal?.x != null && goal?.z != null) {
    try {
      const target = new Vec3(goal.x, (goal.y ?? bot.entity.position.y) + 1, goal.z);
      await bot.lookAt(target, false);
    } catch {}
    return;
  }
  // Gentle random head sway for idle moments
  const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.3;
  const pitch = -0.15 + (Math.random() - 0.5) * 0.2; // slightly downward like a player
  try { await bot.look(yaw, pitch, false); } catch {}
}

// Move away but avoid water — find a land block to walk toward
async function smartMoveAway(dist: number) {
  if (!bot.entity) return;
  const pos = bot.entity.position;
  // Try up to 5 random directions, pick one that lands on solid ground
  for (let attempt = 0; attempt < 5; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const tx = pos.x + Math.cos(angle) * dist;
    const tz = pos.z + Math.sin(angle) * dist;
    // Check if destination area has solid ground (not water)
    const checkBlock = bot.blockAt(new Vec3(Math.floor(tx), Math.floor(pos.y), Math.floor(tz)));
    const checkBelow = bot.blockAt(new Vec3(Math.floor(tx), Math.floor(pos.y) - 1, Math.floor(tz)));
    if (checkBlock && checkBlock.name !== "water" && checkBlock.name !== "flowing_water" &&
        checkBelow && checkBelow.name !== "water" && checkBelow.name !== "flowing_water" &&
        checkBelow.boundingBox === "block") {
      await skills.goToPosition(bot, tx, pos.y, tz, 3); flushLog();
      return;
    }
  }
  // Fallback: just use moveAway
  await skills.moveAway(bot, dist); flushLog();
}

// Long-range exploration — walk 100-200 blocks in a chosen direction looking for resources
let exploreAngle = Math.random() * Math.PI * 2; // persistent direction
let exploreAttempts = 0;
async function longRangeExplore(target: "tree" | "village" | "any") {
  if (!bot.entity) return;
  const pos = bot.entity.position;
  const stepSize = 60; // walk 60 blocks per step

  // After 4 attempts in one direction, try a new one
  exploreAttempts++;
  if (exploreAttempts > 4) {
    exploreAngle += Math.PI / 2 + (Math.random() - 0.5) * 0.5; // turn ~90°
    exploreAttempts = 0;
    console.log(`[${BOT_NAME}] 🧭 cambiando dirección de exploración`);
  }

  const tx = pos.x + Math.cos(exploreAngle) * stepSize;
  const tz = pos.z + Math.sin(exploreAngle) * stepSize;
  console.log(`[${BOT_NAME}] 🔭 explorando hacia (${Math.round(tx)}, ${Math.round(tz)}) buscando ${target}...`);
  currentGoal = `explorando (${target})`;

  try {
    await skills.goToPosition(bot, tx, pos.y, tz, 5); flushLog();
  } catch {
    // If pathfinding fails, try walking manually
    bot.setControlState("forward", true);
    await bot.look(exploreAngle, 0);
    await sleep(6000);
    bot.setControlState("forward", false);
  }

  // Check if we found what we're looking for
  if (target === "tree") {
    const LOG_NAMES = ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"];
    const found = bot.findBlock({ matching: (b: any) => LOG_NAMES.includes(b.name), maxDistance: 64 });
    if (found) {
      console.log(`[${BOT_NAME}] 🌲 ¡encontré ${found.name} a ${Math.round(bot.entity!.position.distanceTo(found.position))} bloques!`);
      exploreAttempts = 0;
    }
  }
}

// Flush Mindcraft skill log output
function flushLog() {
  if (bot.output) {
    for (const line of bot.output.split("\n").filter(Boolean)) {
      console.log(`[${BOT_NAME}] ${line}`);
    }
    bot.output = "";
  }
}

// ── Multi-provider AI ─────────────────────────────────────────────────────
const aiFailures: Record<string, number> = { openrouter: 0, nvidia: 0, ollama: 0 };
const AI_FAILURE_COOLDOWN = 60_000;

function isProviderHealthy(name: string): boolean {
  return Date.now() - (aiFailures[name] ?? 0) > AI_FAILURE_COOLDOWN;
}

async function tryProvider(name: string, fn: () => Promise<string | null>): Promise<string | null> {
  try {
    const result = await fn();
    if (result) { aiFailures[name] = 0; return result; }
    aiFailures[name] = Date.now();
    return null;
  } catch (e: any) {
    aiFailures[name] = Date.now();
    console.warn(`[${BOT_NAME}] AI ${name} falló: ${e?.message ?? e}`);
    return null;
  }
}

async function askAI(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const preferred = AI_PROVIDER.replace("nvidea", "nvidia");
  const order = ["openrouter", "nvidia", "ollama"];
  const chain = [preferred, ...order.filter(p => p !== preferred)];

  for (const provider of chain) {
    if (!isProviderHealthy(provider)) continue;
    if (provider === "openrouter" && OPENROUTER_KEY) {
      const r = await tryProvider("openrouter", () => callChatAPI(OPENROUTER_URL, OPENROUTER_KEY, OPENROUTER_MODEL, systemPrompt, userPrompt, OPENROUTER_TIMEOUT));
      if (r) return r;
    }
    if (provider === "nvidia" && NVIDIA_KEY) {
      const r = await tryProvider("nvidia", () => callChatAPI(NVIDIA_URL, NVIDIA_KEY, NVIDIA_MODEL, systemPrompt, userPrompt, NVIDIA_TIMEOUT));
      if (r) return r;
    }
    if (provider === "ollama" && OLLAMA_URL.startsWith("http")) {
      const r = await tryProvider("ollama", () => callOllama(systemPrompt, userPrompt));
      if (r) return r;
    }
  }
  return null;
}

async function callChatAPI(url: string, key: string, model: string, sys: string, user: string, timeout: number): Promise<string | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 80,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) return null;
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callOllama(sys: string, user: string): Promise<string | null> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: `${sys}\n\n${user}`,
      stream: false,
      keep_alive: -1,
      options: { temperature: 0.7, num_predict: 60 },
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
  });
  if (!res.ok) return null;
  const data = await res.json() as { response: string };
  return data.response?.trim() ?? null;
}

// ══════════════════════════════════════════════════════════════════════════
//  PROGRESSION — uses Mindcraft skills for all gameplay actions
// ══════════════════════════════════════════════════════════════════════════

type Stage = "wood" | "stone" | "iron" | "diamond" | "nether" | "end" | "victory";

function getStage(): Stage {
  if (hasAny("dragon_egg")) return "victory";
  if (invCount("ender_eye") >= 4 || (hasAny("ender_pearl") && hasAny("blaze_powder"))) return "end";
  if (hasAny("diamond_pickaxe")) return "nether";
  if (invCount("diamond") >= 3) return "diamond";
  if (hasAny("iron_pickaxe") || invCount("iron_ingot") >= 3 || invCount("raw_iron") > 0) return "iron";
  if (hasAny("stone_pickaxe", "stone_sword") || invCount("cobblestone") >= 3) return "stone";
  return "wood";
}

function isNight(): boolean {
  return (bot.time?.timeOfDay ?? 0) >= 13000;
}

function foodCount(): number {
  const foodNames = /cooked_|beef|porkchop|mutton|chicken|cod|salmon|bread|apple|carrot|potato|berries|melon/;
  return inv().filter(i => foodNames.test(i.name)).reduce((s, i) => s + i.count, 0);
}

async function ensureSpace(): Promise<void> {
  // First, reduce excess stacks (keep max 1 stack of 64 for common blocks)
  const excessItems = ["cobblestone", "dirt", "andesite", "diorite", "granite", "cobbled_deepslate", "gravel", "sand"];
  for (const name of excessItems) {
    const total = invCount(name);
    if (total > 64) {
      await skills.discard(bot, name, total - 64);
      flushLog();
    }
  }
  if (inventoryFreeSlots() >= 3) return;
  // Then discard junk entirely
  const junk = ["dirt", "cobbled_deepslate", "andesite", "diorite", "granite",
    "gravel", "sand", "rotten_flesh", "spider_eye", "string", "feather",
    "oak_sapling", "birch_sapling", "spruce_sapling", "jungle_sapling"];
  for (const name of junk) {
    if (inventoryFreeSlots() >= 5) break;
    const total = invCount(name);
    if (total > 0) {
      await skills.discard(bot, name, total);
      flushLog();
    }
  }
}

// ── Task system ──────────────────────────────────────────────────────────
interface Task {
  id: string;
  title: string;
  check: () => boolean;
  run: () => Promise<boolean>;
}

const taskFailCount: Record<string, number> = {};
const taskCooldown: Record<string, number> = {};
const MAX_TASK_FAILS = 3;

function isTaskReady(t: Task): boolean {
  if (t.check()) return false;
  if ((taskCooldown[t.id] ?? 0) > Date.now()) return false;
  return true;
}

function markTaskResult(t: Task, ok: boolean) {
  if (ok || t.check()) {
    delete taskFailCount[t.id];
    delete taskCooldown[t.id];
    return;
  }
  taskFailCount[t.id] = (taskFailCount[t.id] ?? 0) + 1;
  const fails = taskFailCount[t.id]!;
  if (fails >= MAX_TASK_FAILS) {
    taskCooldown[t.id] = Date.now() + 120_000;
    taskFailCount[t.id] = 0;
    console.warn(`[${BOT_NAME}] ⏸ "${t.title}" en cooldown 2min`);
  } else {
    taskCooldown[t.id] = Date.now() + 5_000 * fails;
  }
}

function buildTasks(): Task[] {
  const tasks: Task[] = [];
  const anyPick = () => hasAny("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe");
  const anySword = () => hasAny("wooden_sword", "stone_sword", "iron_sword", "diamond_sword");
  const hasStoneOrBetter = () => hasAny("stone_pickaxe", "iron_pickaxe", "diamond_pickaxe");
  const hasIronOrBetter = () => hasAny("iron_pickaxe", "diamond_pickaxe");

  const LOG_TYPES = ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"];
  const PLANK_TYPES = ["oak_planks", "birch_planks", "spruce_planks", "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks"];

  // Find the nearest log type available
  let collectLogFails = 0;
  async function collectAnyLog(count: number): Promise<boolean> {
    for (const logType of LOG_TYPES) {
      const block = bot.findBlock({ matching: (b: any) => b.name === logType, maxDistance: 64 });
      if (block) {
        const ok = await skills.collectBlock(bot, logType, count); flushLog();
        if (ok) { collectLogFails = 0; return true; }
        collectLogFails++;
        if (collectLogFails >= 3) {
          // Block exists but unreachable — move away and try elsewhere
          console.log(`[${BOT_NAME}] 🔄 troncos inalcanzables, moviéndome...`);
          collectLogFails = 0;
          await longRangeExplore("tree");
          return false;
        }
        return false;
      }
    }
    // No logs found nearby — do long-range exploration
    console.log(`[${BOT_NAME}] 🔭 no hay troncos cerca, exploración largo alcance...`);
    await longRangeExplore("tree");
    return false;
  }

  // Get the plank type matching available logs
  function getAvailablePlankType(): string | null {
    for (let i = 0; i < LOG_TYPES.length; i++) {
      if (invCount(LOG_TYPES[i]!) > 0) return PLANK_TYPES[i]!;
    }
    return null;
  }

  const hasAnyLogs = () => invCountMatch(/_log$/) > 0;
  const hasAnyPlanks = () => invCountMatch(/_planks$/) > 0;

  // ─── Wood ──────────────────────────────────────────────
  tasks.push({
    id: "collect-logs", title: `madera (${invCountMatch(/_log$/)}→16)`,
    check: () => invCountMatch(/_log$/) >= 16,
    run: async () => { currentGoal = "talando árboles"; return await collectAnyLog(4); },
  });
  tasks.push({
    id: "craft-planks", title: `tablas (${invCountMatch(/_planks$/)}→16)`,
    check: () => invCountMatch(/_planks$/) >= 16 || !hasAnyLogs(),
    run: async () => {
      currentGoal = "haciendo tablas";
      const plankType = getAvailablePlankType();
      if (!plankType) return false;
      const ok = await skills.craftRecipe(bot, plankType, 4); flushLog(); return ok;
    },
  });
  tasks.push({
    id: "craft-sticks", title: `sticks (${invCount("stick")}→8)`,
    check: () => invCount("stick") >= 8 || !hasAnyPlanks(),
    run: async () => { currentGoal = "haciendo sticks"; const ok = await skills.craftRecipe(bot, "stick", 4); flushLog(); return ok; },
  });
  tasks.push({
    id: "craft-table", title: "mesa de crafteo",
    check: () => hasAny("crafting_table") || !!bot.findBlock({ matching: (b: any) => b.name === "crafting_table", maxDistance: 32 }) || invCountMatch(/_planks$/) < 4,
    run: async () => { currentGoal = "creando mesa"; const ok = await skills.craftRecipe(bot, "crafting_table"); flushLog(); return ok; },
  });
  tasks.push({
    id: "wooden-pickaxe", title: "pico madera",
    check: () => anyPick() || invCountMatch(/_planks$/) < 3 || invCount("stick") < 2,
    run: async () => { currentGoal = "pico madera"; const ok = await skills.craftRecipe(bot, "wooden_pickaxe"); flushLog(); return ok; },
  });
  tasks.push({
    id: "wooden-sword", title: "espada madera",
    check: () => anySword() || invCountMatch(/_planks$/) < 2 || invCount("stick") < 1,
    run: async () => { currentGoal = "espada madera"; const ok = await skills.craftRecipe(bot, "wooden_sword"); flushLog(); return ok; },
  });

  // ─── Bed (important but non-blocking) ──
  const hasBed = () => inv().some(i => /_bed$/.test(i.name)) || !!bot.findBlock({ matching: (b: any) => b.name?.endsWith("_bed"), maxDistance: 48 });
  tasks.push({
    id: "get-bed", title: "cama",
    check: () => hasBed() || !anyPick(),
    run: async () => {
      currentGoal = "consiguiendo cama";
      // If we already have wool + planks, just craft
      if (invCountMatch(/_wool$/) >= 3 && invCountMatch(/_planks$/) >= 3) {
        const woolItem = inv().find(i => /_wool$/.test(i.name) && i.count >= 3);
        if (woolItem) {
          const ok = await skills.craftRecipe(bot, woolItem.name.replace("_wool", "_bed")); flushLog();
          if (ok) return true;
        }
      }
      // Only hunt sheep if there are some nearby (don't wander far looking)
      const sheepNearby = bot.nearestEntity((e: any) => e.name === "sheep" && bot.entity!.position.distanceTo(e.position) < 32);
      if (!sheepNearby) {
        console.log(`[${BOT_NAME}] 🐑 no hay ovejas cerca, seguiré buscando luego`);
        return false; // fail fast, let other tasks proceed
      }
      for (let i = 0; i < 3 && invCountMatch(/_wool$/) < 3; i++) {
        const ok = await skills.attackNearest(bot, "sheep", true); flushLog();
        if (ok) { await skills.pickupNearbyItems(bot); flushLog(); }
        else break;
      }
      if (invCountMatch(/_wool$/) >= 3 && invCountMatch(/_planks$/) >= 3) {
        const woolItem = inv().find(i => /_wool$/.test(i.name) && i.count >= 3);
        if (woolItem) {
          const ok = await skills.craftRecipe(bot, woolItem.name.replace("_wool", "_bed")); flushLog();
          return ok;
        }
      }
      return false;
    },
  });

  // ─── Stone ─────────────────────────────────────────────
  tasks.push({
    id: "collect-cobble", title: `piedra (${invCount("cobblestone")}→20)`,
    check: () => invCount("cobblestone") >= 20 || !anyPick(),
    run: async () => { currentGoal = "minando piedra"; const ok = await skills.collectBlock(bot, "stone", 8); flushLog(); return ok; },
  });
  tasks.push({
    id: "stone-pickaxe", title: "pico piedra",
    check: () => hasStoneOrBetter() || invCount("cobblestone") < 3 || invCount("stick") < 2,
    run: async () => { currentGoal = "pico piedra"; const ok = await skills.craftRecipe(bot, "stone_pickaxe"); flushLog(); return ok; },
  });
  tasks.push({
    id: "stone-sword", title: "espada piedra",
    check: () => hasAny("stone_sword", "iron_sword", "diamond_sword") || invCount("cobblestone") < 2 || invCount("stick") < 1,
    run: async () => { currentGoal = "espada piedra"; const ok = await skills.craftRecipe(bot, "stone_sword"); flushLog(); return ok; },
  });
  tasks.push({
    id: "stone-axe", title: "hacha piedra",
    check: () => hasAny("stone_axe", "iron_axe", "diamond_axe") || invCount("cobblestone") < 3 || invCount("stick") < 2,
    run: async () => { currentGoal = "hacha piedra"; const ok = await skills.craftRecipe(bot, "stone_axe"); flushLog(); return ok; },
  });

  // ─── Survival essentials ───────────────────────────────
  tasks.push({
    id: "hunt-food", title: `comida (${foodCount()}→12)`,
    check: () => foodCount() >= 12 || !anySword(),
    run: async () => {
      currentGoal = "cazando";
      for (const animal of ["cow", "pig", "sheep", "chicken"]) {
        const ok = await skills.attackNearest(bot, animal, true);
        flushLog();
        if (ok) { await skills.pickupNearbyItems(bot); flushLog(); return true; }
      }
      await smartMoveAway(30);
      return false;
    },
  });
  tasks.push({
    id: "furnace", title: "horno",
    check: () => hasAny("furnace") || !!bot.findBlock({ matching: (b: any) => b.name === "furnace", maxDistance: 32 }) || invCount("cobblestone") < 8,
    run: async () => {
      currentGoal = "horno";
      const ok = await skills.craftRecipe(bot, "furnace"); flushLog();
      if (ok) { const p = world.getPosition(bot); await skills.placeBlock(bot, "furnace", p.x + 1, p.y, p.z); flushLog(); }
      return ok;
    },
  });
  tasks.push({
    id: "collect-coal", title: `carbón (${invCount("coal")}→16)`,
    check: () => invCount("coal") >= 16 || !hasStoneOrBetter(),
    run: async () => { currentGoal = "minando carbón"; const ok = await skills.collectBlock(bot, "coal_ore", 4); flushLog(); return ok; },
  });
  tasks.push({
    id: "craft-torches", title: `antorchas (${invCount("torch")}→32)`,
    check: () => invCount("torch") >= 32 || invCount("coal") < 2 || invCount("stick") < 2,
    run: async () => { currentGoal = "antorchas"; const ok = await skills.craftRecipe(bot, "torch", 8); flushLog(); return ok; },
  });

  // ─── Iron ──────────────────────────────────────────────
  tasks.push({
    id: "collect-iron", title: `hierro (${invCount("raw_iron") + invCount("iron_ingot")}→12)`,
    check: () => (invCount("raw_iron") + invCount("iron_ingot") >= 12) || !hasStoneOrBetter(),
    run: async () => {
      currentGoal = "minando hierro";
      const ok = await skills.collectBlock(bot, "iron_ore", 3); flushLog();
      if (!ok) { await skills.digDown(bot, 10); flushLog(); }
      return ok;
    },
  });
  tasks.push({
    id: "smelt-iron", title: "fundir hierro",
    check: () => invCount("raw_iron") === 0 || (!hasAny("furnace") && !bot.findBlock({ matching: (b: any) => b.name === "furnace", maxDistance: 32 })),
    run: async () => { currentGoal = "fundiendo"; const ok = await skills.smeltItem(bot, "raw_iron", invCount("raw_iron")); flushLog(); return ok; },
  });
  tasks.push({
    id: "iron-pickaxe", title: "pico hierro",
    check: () => hasIronOrBetter() || invCount("iron_ingot") < 3 || invCount("stick") < 2,
    run: async () => { currentGoal = "pico hierro"; const ok = await skills.craftRecipe(bot, "iron_pickaxe"); flushLog(); return ok; },
  });
  tasks.push({
    id: "iron-sword", title: "espada hierro",
    check: () => hasAny("iron_sword", "diamond_sword") || invCount("iron_ingot") < 2 || invCount("stick") < 1,
    run: async () => { currentGoal = "espada hierro"; const ok = await skills.craftRecipe(bot, "iron_sword"); flushLog(); return ok; },
  });
  tasks.push({
    id: "shield", title: "escudo",
    check: () => hasAny("shield") || invCount("iron_ingot") < 1 || invCountMatch(/_planks$/) < 6,
    run: async () => { currentGoal = "escudo"; const ok = await skills.craftRecipe(bot, "shield"); flushLog(); return ok; },
  });
  tasks.push({
    id: "iron-armor", title: "armadura hierro",
    check: () => hasAny("iron_chestplate", "diamond_chestplate") || invCount("iron_ingot") < 8,
    run: async () => {
      currentGoal = "armadura";
      let ok = await skills.craftRecipe(bot, "iron_chestplate"); flushLog();
      if (invCount("iron_ingot") >= 7) { await skills.craftRecipe(bot, "iron_leggings"); flushLog(); }
      if (invCount("iron_ingot") >= 4) { await skills.craftRecipe(bot, "iron_boots"); flushLog(); }
      if (invCount("iron_ingot") >= 5) { await skills.craftRecipe(bot, "iron_helmet"); flushLog(); }
      return ok;
    },
  });
  tasks.push({
    id: "bucket", title: "balde",
    check: () => hasAny("bucket", "water_bucket") || invCount("iron_ingot") < 3,
    run: async () => { currentGoal = "balde"; const ok = await skills.craftRecipe(bot, "bucket"); flushLog(); return ok; },
  });

  // ─── Diamond ───────────────────────────────────────────
  tasks.push({
    id: "collect-diamonds", title: `diamantes (${invCount("diamond")}→5)`,
    check: () => invCount("diamond") >= 5 || !hasIronOrBetter(),
    run: async () => {
      currentGoal = "buscando diamantes";
      if (bot.entity && bot.entity.position.y > -50) { await skills.digDown(bot, Math.min(20, Math.round(bot.entity.position.y + 55))); flushLog(); }
      const ok = await skills.collectBlock(bot, "diamond_ore", 1); flushLog();
      return ok;
    },
  });
  tasks.push({
    id: "diamond-pickaxe", title: "pico diamante",
    check: () => hasAny("diamond_pickaxe") || invCount("diamond") < 3 || invCount("stick") < 2,
    run: async () => { currentGoal = "pico diamante"; const ok = await skills.craftRecipe(bot, "diamond_pickaxe"); flushLog(); return ok; },
  });
  tasks.push({
    id: "diamond-sword", title: "espada diamante",
    check: () => hasAny("diamond_sword") || invCount("diamond") < 2 || invCount("stick") < 1,
    run: async () => { currentGoal = "espada diamante"; const ok = await skills.craftRecipe(bot, "diamond_sword"); flushLog(); return ok; },
  });

  return tasks;
}

// ══════════════════════════════════════════════════════════════════════════
//  AUTONOMOUS MODES
// ══════════════════════════════════════════════════════════════════════════

async function modeSelfPreservation(): Promise<boolean> {
  if (!bot.entity) return false;
  // Escape water
  const block = bot.blockAt(bot.entity.position);
  const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));
  const isInWater = block?.name === "water" || block?.name === "flowing_water" ||
      below?.name === "water" || below?.name === "flowing_water";
  if (isInWater) {
    bot.setControlState("jump", true);
    const myPos = bot.entity.position;

    // Find the absolute closest solid block by expanding radius
    let bestLand: { x: number; y: number; z: number; dist: number } | null = null;
    for (let radius = 1; radius <= 25 && !bestLand; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue; // only check perimeter
          for (let dy = -2; dy <= 3; dy++) {
            const tx = Math.floor(myPos.x) + dx;
            const ty = Math.floor(myPos.y) + dy;
            const tz = Math.floor(myPos.z) + dz;
            const blk = bot.blockAt(new Vec3(tx, ty, tz));
            if (!blk || blk.boundingBox !== "block") continue;
            if (blk.name.includes("water") || blk.name.includes("lava")) continue;
            // Check block above is walkable (air or non-water)
            const above = bot.blockAt(new Vec3(tx, ty + 1, tz));
            if (above && above.name.includes("water")) continue;
            const dist = myPos.distanceTo(new Vec3(tx, ty, tz));
            if (!bestLand || dist < bestLand.dist) {
              bestLand = { x: tx + 0.5, y: ty + 1, z: tz + 0.5, dist };
            }
          }
        }
      }
    }

    if (bestLand) {
      console.log(`[${BOT_NAME}] 🏊 nadando a tierra (${Math.round(bestLand.dist)}m)`);
      const target = new Vec3(bestLand.x, bestLand.y, bestLand.z);
      await bot.lookAt(target);
      bot.setControlState("forward", true);
      const swimTime = Math.min(Math.max(bestLand.dist * 500, 2000), 10000);
      await sleep(swimTime);
      bot.setControlState("forward", false);
    } else {
      console.log(`[${BOT_NAME}] 🏊 no hay tierra, nadando random`);
      const angle = Math.random() * Math.PI * 2;
      await bot.look(angle, 0);
      bot.setControlState("forward", true);
      await sleep(5000);
      bot.setControlState("forward", false);
    }
    bot.setControlState("jump", false);
    return true;
  }
  // Flee if dying
  if ((bot.health ?? 20) < 6) {
    console.log(`[${BOT_NAME}] ❗ HP baja (${(bot.health ?? 0).toFixed(1)}), huyendo`);
    await skills.avoidEnemies(bot, 16); flushLog();
    for (const food of ["cooked_beef", "cooked_porkchop", "bread", "golden_apple", "apple", "cooked_chicken"]) {
      if (invCount(food) > 0) { await skills.consume(bot, food); flushLog(); break; }
    }
    return true;
  }
  return false;
}

async function modeSelfDefense(): Promise<boolean> {
  if (!bot.entity) return false;
  const hostile = world.getNearestEntityWhere(bot, (e: any) => mc.isHostile(e), 8);
  if (!hostile) return false;
  if ((hostile as any).name === "creeper" && bot.entity.position.distanceTo(hostile.position) < 6) {
    console.log(`[${BOT_NAME}] 💥 creeper! huyendo`);
    await skills.avoidEnemies(bot, 16); flushLog();
    return true;
  }
  console.log(`[${BOT_NAME}] ⚔ atacando ${(hostile as any).name}`);
  await skills.attackEntity(bot, hostile, true); flushLog();
  await skills.pickupNearbyItems(bot); flushLog();
  return true;
}

let itemCollectFailCount = 0;
async function modeItemCollecting(): Promise<boolean> {
  if (!bot.entity || inventoryFreeSlots() < 1) return false;
  if (itemCollectFailCount >= 3) {
    // Stop trying for 30s after 3 failed attempts
    return false;
  }
  const nearbyItem = bot.nearestEntity((e: any) => e.name === "item" && bot.entity!.position.distanceTo(e.position) < 6);
  if (!nearbyItem) { itemCollectFailCount = 0; return false; }
  const before = inv().length;
  await skills.pickupNearbyItems(bot); flushLog();
  const after = inv().length;
  if (after <= before) {
    itemCollectFailCount++;
    if (itemCollectFailCount >= 3) {
      setTimeout(() => { itemCollectFailCount = 0; }, 30_000);
    }
  } else {
    itemCollectFailCount = 0;
  }
  return true;
}

async function modeTorchPlacing(): Promise<boolean> {
  if (!bot.entity || !world.shouldPlaceTorch(bot) || invCount("torch") <= 0) return false;
  const pos = world.getPosition(bot);
  await skills.placeBlock(bot, "torch", pos.x, pos.y, pos.z, "bottom", true); flushLog();
  return true;
}

async function modeEating(): Promise<boolean> {
  if (!bot.entity || (bot.food ?? 20) >= 14) return false;
  for (const food of ["cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton", "bread", "golden_apple", "apple", "carrot"]) {
    if (invCount(food) > 0) {
      console.log(`[${BOT_NAME}] 🍗 comiendo ${food}`);
      await skills.consume(bot, food); flushLog();
      return true;
    }
  }
  return false;
}

async function modeNightSafety(): Promise<boolean> {
  if (!isNight() || !bot.entity) return false;
  const ok = await skills.goToBed(bot); flushLog();
  return ok;
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN TICK
// ══════════════════════════════════════════════════════════════════════════
async function tick() {
  if (isBusy || !bot.entity) return;
  isBusy = true;
  bot.interrupt_code = false;

  try {
    // Natural head movement for viewer
    await naturalLook();
    
    if (await modeSelfPreservation()) return;
    if (await modeNightSafety()) return;
    if (await modeSelfDefense()) return;
    if (await modeItemCollecting()) return;
    if (await modeEating()) return;
    await modeTorchPlacing();
    await ensureSpace();

    const tasks = buildTasks();
    const ready = tasks.filter(isTaskReady);

    if (ready.length > 0) {
      const task = ready[0]!;
      const stage = getStage();
      console.log(`[${BOT_NAME}] 🎯 Stage: ${stage} | HP:${(bot.health ?? 0).toFixed(0)} | Food:${bot.food} | ${task.title} | ${logInv()}`);
      currentGoal = task.title;
      const ok = await task.run();
      markTaskResult(task, ok || task.check());
      return;
    }

    // No tasks ready — explore to find resources
    const hasBasicResources = invCountMatch(/_log$/) > 0 || invCountMatch(/_planks$/) > 0 || hasAny("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe");
    if (!hasBasicResources) {
      // In a desert or barren area — do long-range exploration
      await longRangeExplore("tree");
    } else {
      currentGoal = "explorando";
      await smartMoveAway(20);
    }
  } catch (e: any) {
    console.warn(`[${BOT_NAME}] tick error: ${e?.message ?? e}`);
  } finally {
    isBusy = false;
    bot.interrupt_code = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  AI CHAT
// ══════════════════════════════════════════════════════════════════════════
async function aiChat() {
  if (Date.now() - lastAIChat < 60_000) return;
  lastAIChat = Date.now();

  const stage = getStage();
  const sys = `Eres ${BOT_NAME}, un streamer de Minecraft en vivo. ${PERSONALITY}.

REGLAS que conoces perfectamente:
- Para minar piedra/hierro/carbón NECESITAS pico. Sin pico, solo puedes romper madera con la mano.
- Progresión: madera → tablas → sticks → mesa → pico madera → piedra → pico piedra → hierro → pico hierro → diamante.
- De noche DEBES dormir en cama o refugiarte. Los mobs te matan fácil sin armadura.
- Necesitas espada para pelear. Sin espada, huye de los mobs.
- Primero sobrevivir (cama, comida, armas), después explorar.

Tu misión: PASARTE Minecraft (llegar al End y matar al Ender Dragon).

Responde EN ESPAÑOL con UNA frase corta (máx 70 chars), como streamer real.
Comenta lo que REALMENTE haces/ves. Sin comillas, sin asteriscos, sin emojis.`;

  const nearby = world.getNearbyBlockTypes(bot, 16).slice(0, 10).join(", ");
  const entities = world.getNearbyEntityTypes(bot).join(", ");

  const user = `ACCIÓN: ${currentGoal}
ETAPA: ${stage}
INVENTARIO: ${logInv()}
HP: ${(bot.health ?? 0).toFixed(0)}/20  Hambre: ${bot.food ?? 0}/20
BLOQUES: ${nearby}
ENTIDADES: ${entities}
${isNight() ? "NOCHE." : "Día."}
Comenta brevemente.`;

  const reply = await askAI(sys, user);
  if (reply) {
    const line = reply.replace(/^["'`*]+|["'`*]+$/g, "").replace(/\*+/g, "").split("\n")[0]!.slice(0, 100).trim();
    if (line.length > 3) bot.chat(line);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  SPAWN + LOOP
// ══════════════════════════════════════════════════════════════════════════
bot.once("spawn", () => {
  console.log(`✅ ${BOT_NAME} conectado a ${MC_HOST}:${MC_PORT} [${TEST_MODE ? "TEST" : "LIVE"}]`);
  const primary = OPENROUTER_KEY ? `openrouter(${OPENROUTER_MODEL})` : NVIDIA_KEY ? `nvidia(${NVIDIA_MODEL})` : `ollama(${OLLAMA_MODEL})`;
  console.log(`🤖 AI: ${primary} → fallback chain`);

  const movements = new Movements(bot);
  movements.allowSprinting  = false; // Paper flags sprint-pathfind as "moved wrongly"
  movements.allowParkour    = false; // parkour causes illegal movement on Paper
  movements.allow1by1towers = true;
  movements.canDig          = true;
  movements.allowFreeMotion = false;
  movements.canOpenDoors    = true;
  movements.scafoldingBlocks.push(bot.registry.blocksByName["cobblestone"]?.id ?? 0);
  bot.pathfinder.setMovements(movements);

  // Start prismarine-viewer — renders what the bot sees in first person
  const VIEWER_PORT = WORKER_PORT + 100; // e.g. 3101
  try {
    viewerPlugin(bot, { port: VIEWER_PORT, firstPerson: true });
    console.log(`👁 Viewer ${BOT_NAME} en http://localhost:${VIEWER_PORT}`);
  } catch (e: any) {
    console.warn(`[${BOT_NAME}] viewer error: ${e?.message?.slice(0, 100)}`);
  }

  // Expose HUD metadata on bot for viewer socket.io broadcast
  (bot as any)._hudBotName = BOT_NAME;
  (bot as any)._hudGoal = currentGoal;
  (bot as any)._hudStage = getStage();
  intervals.push(setInterval(() => {
    (bot as any)._hudGoal = currentGoal;
    (bot as any)._hudStage = getStage();
  }, 200));

  setTimeout(() => bot.chat(`Hola, soy ${BOT_NAME}. Mi misión: pasarme Minecraft 💪`), 2000);

  intervals.push(setInterval(() => { tick().catch(e => console.error("tick:", e)); }, 2500));
  intervals.push(setInterval(() => { aiChat().catch(() => {}); }, 65_000));

  // Auto-start streaming if STREAM_TARGETS env var has targets
  setTimeout(async () => {
    try {
      const raw = process.env.STREAM_TARGETS;
      if (!raw) { console.log(`[${BOT_NAME}] sin stream targets, skip stream`); return; }
      const targets = JSON.parse(raw) as Array<{ platform: string; rtmp_url: string; stream_key: string }>;
      if (!Array.isArray(targets) || targets.length === 0) return;
      await stream.startStream({
        botName: BOT_NAME,
        viewerUrl: `http://localhost:${VIEWER_PORT}`,
        targets,
        width: 1280, height: 720, fps: 30,
        videoBitrate: process.env.STREAM_BITRATE || "2500k",
        ambientAudio: process.env.STREAM_AMBIENT_AUDIO,
      });
    } catch (e: any) {
      console.warn(`[${BOT_NAME}] stream auto-start failed: ${e?.message?.slice(0, 200)}`);
    }
  }, 8000); // wait 8s for viewer to be ready
});

bot.on("death", () => {
  console.warn(`[${BOT_NAME}] 💀 murió`);
  isBusy = false;
  bot.interrupt_code = true;
  stopMoving();
});

bot.on("respawn", () => {
  console.log(`[${BOT_NAME}] 🔄 respawn`);
  isBusy = false;
  bot.interrupt_code = false;
});

bot.on("error",  (err: any) => {
  const msg = err?.message ?? String(err);
  if (msg.includes("EPIPE") || msg.includes("ended by the other party") || msg.includes("ECONNRESET")) {
    console.warn(`[${BOT_NAME}] socket error (ignorado): ${msg.slice(0, 80)}`);
    return; // Don't crash on socket errors
  }
  console.error(`[${BOT_NAME}] error:`, msg.slice(0, 200));
});
bot.on("kicked", (reason: any) => console.warn(`[${BOT_NAME}] kicked:`, reason));
bot.on("end",    (reason: any) => console.warn(`[${BOT_NAME}] desconectado:`, reason));

// Catch unhandled errors to prevent process crash
process.on("uncaughtException", (err) => {
  const msg = err?.message ?? String(err);
  if (msg.includes("EPIPE") || msg.includes("ECONNRESET") || msg.includes("ended by the other party")) {
    console.warn(`[${BOT_NAME}] uncaught socket error (ignorado): ${msg.slice(0, 80)}`);
    return;
  }
  console.error(`[${BOT_NAME}] uncaught:`, msg.slice(0, 300));
});
process.on("unhandledRejection", (err: any) => {
  const msg = err?.message ?? String(err);
  if (msg.includes("EPIPE") || msg.includes("ECONNRESET") || msg.includes("ended by the other party")) return;
  console.error(`[${BOT_NAME}] unhandled rejection:`, msg.slice(0, 300));
});

function cleanup(reason = "Stop") {
  console.log(`[${BOT_NAME}] ${reason}, limpiando...`);
  for (const interval of intervals.splice(0)) clearInterval(interval);
  isBusy = false;
  bot.interrupt_code = true;
  try { bot.pathfinder.setGoal(null); } catch {}
  try { stream.stopStream(); } catch {}
  try { bot.quit(reason); } catch {}
  try { httpServer?.stop?.(); } catch {}
}

hotGlobal.__streamAiMcWorkerCleanup = cleanup;
process.once("SIGTERM", () => { cleanup("SIGTERM"); setTimeout(() => process.exit(0), 1000); });
process.once("SIGINT", () => { cleanup("SIGINT"); setTimeout(() => process.exit(0), 1000); });

// ══════════════════════════════════════════════════════════════════════════
//  HTTP API
// ══════════════════════════════════════════════════════════════════════════
function getState() {
  if (!bot.entity) {
    return { health: 0, food: 0, position: [0, 0, 0], inventory: [], nearby_blocks: [],
      nearby_entities: [], time_of_day: "—", stage: "wood", current_goal: currentGoal, uptime_s: 0 };
  }
  const pos = bot.entity.position;
  return {
    health: bot.health ?? 20, food: bot.food ?? 20,
    position: [Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)],
    inventory: inv().map(i => `${i.count}x ${i.name}`),
    nearby_blocks: world.getNearbyBlockTypes(bot, 16).slice(0, 15),
    nearby_entities: world.getNearbyEntityTypes(bot).slice(0, 8),
    time_of_day: (bot.time?.timeOfDay ?? 0) < 13000 ? "dia" : "noche",
    stage: getStage(), current_goal: currentGoal,
    uptime_s: Math.round((Date.now() - startTime) / 1000),
    ai_provider: AI_PROVIDER, is_busy: isBusy,
    bot_name: BOT_NAME,
  };
}

httpServer = Bun.serve({
  port: WORKER_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/state"  && req.method === "GET")  return Response.json(getState());
    if (url.pathname === "/health" && req.method === "GET")  return Response.json({ ok: true, bot: BOT_NAME });
    if (url.pathname === "/say"    && req.method === "POST") {
      const { text } = await req.json() as { text: string };
      bot.chat(text); return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`🌐 Worker ${BOT_NAME} en :${WORKER_PORT}`);