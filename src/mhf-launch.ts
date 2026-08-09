/**
 * mhf-launch.ts (Electron main-process module)
 *
 * Login -> config.json -> launch the MHF-Z client, wrapped as a function
 * meant to be called from Electron's main process (e.g. via
 * ipcMain.handle), not run as a standalone CLI script.
 *
 * Import and call `launchMhf()` from the main process. See the
 * `wireUpIpc()` helper at the bottom for an example of hooking this up to
 * a renderer via IPC, including streaming log lines to a window.
 *
 * NOTE: writes <userData>/logs/login-raw.json, which contains a live
 * session token. That directory is not part of this repo, but know where this ends up!
 */

import { app, dialog, type BrowserWindow, ipcMain } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LauncherEnv {
  MHF_USER: string;
  MHF_PASS: string;
  MHF_HOST: string;
  MHF_PORT: string;
  MHF_CHAR_INDEX: string;
  MHF_GAME_DIR: string;
}

interface Character {
  id: number;
  name: string;
  hr: number;
  gr: number;
}

interface MezFes {
  id?: number;
  start?: number;
  end?: number;
  soloTickets?: number;
  groupTickets?: number;
  stalls?: number[];
}

interface LoginResponse {
  characters?: Character[];
  mezFes?: MezFes;
  user: {
    tokenId: number;
    token: string;
    rights: number;
  };
  entranceCount: number;
  currentTs: number;
  expiryTs: number;
  notices?: string[];
  messages?: string[];
}

interface GameConfig {
  char_id: number;
  char_name: string;
  char_hr: number;
  char_gr: number;
  char_ids: number[];
  char_new: boolean;
  user_token_id: number;
  user_token: string;
  user_name: string;
  user_password: string;
  user_rights: number;
  server_host: string;
  server_port: number;
  entrance_count: number;
  current_ts: number;
  expiry_ts: number;
  notices: { data: string; flags: number }[];
  messages: { data: string; flags: number }[];
  mez_event_id: number;
  mez_start: number;
  mez_end: number;
  mez_solo_tickets: number;
  mez_group_tickets: number;
  version: string;
  mez_stalls: string[];
}

export interface LaunchOptions {
  /** Called with each log line as the launch proceeds (for streaming to a renderer). */
  onLog?: (line: string) => void;
  /** Called once the game process exits (only fires if launch got that far). */
  onExit?: (code: number | null) => void;
  /** Overrides the game install directory otherwise read from the env file / default. */
  gameDir?: string;
  /** Show a native error dialog on failure. Defaults to true. */
  showErrorDialog?: boolean;
}

export class LaunchError extends Error {}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// MezFes stall IDs -> the names mhf-iel expects. Any ID not listed here
// (e.g. 5, which the client's Rust enum doesn't recognize as "GoocooScoop"
// or otherwise) gets silently dropped from mez_stalls in toGameConfig()
// rather than sent through. An unrecognized variant makes the client
// panic on startup instead of launching (found that out the hard way)
const STALLS: Record<number, string> = {
  2: "TokotokoPartnya",
  3: "Pachinko",
  4: "VolpakkunTogether",
  6: "Nyanrendo",
  7: "HoneyPanic",
  8: "DokkanBattleCats",
  9: "PointStall",
  10: "StallMap",
};

const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getEnvFilePath(): string {
  // While unpackaged (npm start / `electron .`), read straight from a
  // `.env` in the project root.
  if (!app.isPackaged) {
    const devEnvPath = join(app.getAppPath(), ".env");
    if (existsSync(devEnvPath)) return devEnvPath;
  }
  // Packaged builds (and dev, if no project-root .env exists) use the real
  // per-user location. Nothing writes this file yet — that's the eventual
  // job of a settings screen — so today this path just needs to exist by
  // hand if we're testing a packaged build.
  return join(app.getPath("userData"), "launcher.env");
}

function getLogDir(): string {
  return join(app.getPath("userData"), "logs");
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function makeLogger(onLog?: (line: string) => void) {
  mkdirSync(getLogDir(), { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stream = createWriteStream(join(getLogDir(), `launch-${timestamp}.log`), { flags: "a" });

  return {
    log(line: string): void {
      stream.write(line + "\n");
      onLog?.(line);
    },
    close(): void {
      stream.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Step 1: load + parse the env file
// ---------------------------------------------------------------------------

function parseEnvFile(path: string): Record<string, string> {
  const raw = readFileSync(path, "utf8");
  const out: Record<string, string> = {};

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    const wasQuoted = /^["'].*["']$/.test(withoutExport.slice(eq + 1).trim());
    if (!wasQuoted) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }

    out[key] = value;
  }

  return out;
}

function loadEnv(fail: (message: string) => never): LauncherEnv {
  const envFile = getEnvFilePath();
  if (!existsSync(envFile)) {
    const hint = app.isPackaged
      ? "Account setup isn't wired up yet — create this file by hand for now."
      : `Add a .env file at the project root (${join(app.getAppPath(), ".env")}), or create ${envFile} by hand.`;
    fail(`Credentials file not found: ${envFile}\n\n${hint}`);
  }

  const parsed = parseEnvFile(envFile);

  if (!parsed.MHF_USER || !parsed.MHF_PASS) {
    fail(`${envFile} must define MHF_USER and MHF_PASS.`);
  }
  if (!parsed.MHF_GAME_DIR) {
    fail(`${envFile} must define MHF_GAME_DIR (the MHF install folder).`);
  }

  return {
    MHF_USER: parsed.MHF_USER,
    MHF_PASS: parsed.MHF_PASS,
    MHF_HOST: parsed.MHF_HOST || "127.0.0.1",
    MHF_PORT: parsed.MHF_PORT || "53310",
    MHF_CHAR_INDEX: parsed.MHF_CHAR_INDEX || "0",
    MHF_GAME_DIR: parsed.MHF_GAME_DIR,
  };
}

// ---------------------------------------------------------------------------
// Step 2: tunnel check
// ---------------------------------------------------------------------------

function which(bin: string): boolean {
  const res = spawnSync(isWindows ? "where" : "which", [bin], { stdio: "ignore" });
  return res.status === 0;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureTunnel(
  log: (line: string) => void,
  fail: (message: string) => never
): Promise<void> {
  // mhf-tunnel.service is a systemd user unit — Linux only. On Windows/macOS
  // (and inside a Proton/Wine sandbox on Linux) the tunnel needs to be
  // started some other way; this just polls for it either way.
  if (!isWindows && which("systemctl")) {
    spawnSync("systemctl", ["--user", "start", "mhf-tunnel.service"], { stdio: "ignore" });
  }

  let ok = false;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://${loadEnv(fail).MHF_HOST}:8080/v2/login`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        ok = true;
        break;
      }
    } catch {
      // keep polling
    }
    await sleep(1000);
  }

  if (!ok) {
    fail(
      "Could not establish the tunnel to the server (port 8080).\nMake sure the tunnel is running."
    );
  }
  log("tunnel: ok");
}

// ---------------------------------------------------------------------------
// Step 3: clear stale game processes from a previous run
// ---------------------------------------------------------------------------

// Every /v2/login issues a fresh token and invalidates the previous one. If
// an old mhf-iel-cli.exe from a prior run is still sitting open, it's
// holding a now-dead token — selecting a world in that stale window gets
// rejected by the channel server ("Invalid login token") and disconnects
// immediately. This has to run before every login, not just on Linux.
async function cleanStaleWine(log: (line: string) => void): Promise<void> {
  if (isWindows) {
    log("cleaning stale game processes...");
    spawnSync("taskkill", ["/IM", "mhf-iel-cli.exe", "/F"], { stdio: "ignore" });
    await sleep(500);
    return;
  }
  log("cleaning stale wine processes...");
  spawnSync("wineserver", ["-k"], { stdio: "ignore" });
  await sleep(2000);
}

// ---------------------------------------------------------------------------
// Step 4: login -> config.json
// ---------------------------------------------------------------------------

async function login(
  env: LauncherEnv,
  fail: (message: string) => never
): Promise<LoginResponse> {
  let res: Response;
  try {
    res = await fetch(`http://${env.MHF_HOST}:8080/v2/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: env.MHF_USER, password: env.MHF_PASS }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    fail("Request to /v2/login failed");
  }

  const text = await res.text();
  writeFileSync(join(getLogDir(), "login-raw.json"), text);

  if (!res.ok) {
    fail(`Malformed login response (check username/password): ${text.slice(0, 200)}`);
  }

  let data: LoginResponse;
  try {
    data = JSON.parse(text);
  } catch {
    fail(`Malformed login response (check username/password): ${text.slice(0, 200)}`);
  }

  if (!("user" in data)) {
    fail(`Malformed login response (check username/password): ${text.slice(0, 200)}`);
  }

  return data;
}

function toGameConfig(a: LoginResponse, env: LauncherEnv): GameConfig {
  const chars = a.characters ?? [];
  const sel = parseInt(env.MHF_CHAR_INDEX, 10) || 0;
  const ch = chars.length > 0 ? chars[sel] : undefined;
  const mez = a.mezFes ?? {};

  return {
    char_id: ch ? ch.id : 0,
    char_name: ch ? ch.name : "",
    char_hr: ch ? ch.hr : 0,
    char_gr: ch ? ch.gr : 0,
    char_ids: chars.map((c) => c.id),
    char_new: false,
    user_token_id: a.user.tokenId,
    user_token: a.user.token,
    user_name: env.MHF_USER,
    user_password: env.MHF_PASS,
    user_rights: a.user.rights,
    server_host: env.MHF_HOST,
    server_port: parseInt(env.MHF_PORT, 10),
    entrance_count: a.entranceCount,
    current_ts: a.currentTs,
    expiry_ts: a.expiryTs,
    notices: (a.notices ?? []).map((n) => ({ data: n, flags: 0 })),
    messages: (a.messages ?? []).map((n) => ({ data: n, flags: 0 })),
    mez_event_id: mez.id ?? 0,
    mez_start: mez.start ?? 0,
    mez_end: mez.end ?? 0,
    mez_solo_tickets: mez.soloTickets ?? 0,
    mez_group_tickets: mez.groupTickets ?? 0,
    version: "ZZ",
    mez_stalls: (mez.stalls ?? [])
      .map((s) => STALLS[s])
      .filter((name): name is string => name !== undefined),
  };
}

// ---------------------------------------------------------------------------
// Step 5: launch
// ---------------------------------------------------------------------------

function launchGame(
  gameDir: string,
  log: (line: string) => void,
  fail: (message: string) => never,
  onExit?: (code: number | null) => void
): void {
  if (!existsSync(gameDir)) {
    fail(`Game folder not found: ${gameDir}`);
  }

  // If this Electron app is itself running under Proton, process.platform
  // already reports "win32" here (Proton wraps the whole process), so this
  // branch is correct in that case too — no explicit wine call needed.
  const command = isWindows ? join(gameDir, "mhf-iel-cli.exe") : "wine";
  const args = isWindows ? [] : ["./mhf-iel-cli.exe"];

  log(`launching ${isWindows ? "mhf-iel-cli.exe" : "wine mhf-iel-cli.exe"} ...`);

  const child = spawn(command, args, {
    cwd: gameDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: isWindows
      ? process.env
      : {
          ...process.env,
          WINEPREFIX: join(homedir(), ".wine-mhf"),
          LANG: "ja_JP.UTF-8",
        },
  });

  child.stdout?.on("data", (chunk: Buffer) => log(`[game stdout] ${chunk.toString().trimEnd()}`));
  child.stderr?.on("data", (chunk: Buffer) => log(`[game stderr] ${chunk.toString().trimEnd()}`));

  child.on("exit", (code, signal) => {
    log(`game process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    onExit?.(code);
  });
  child.on("error", (err) =>
    fail(`Failed to launch ${isWindows ? "the game" : "wine"}: ${err.message}`)
  );

  // Let the game run independently of the Electron app's lifecycle.
  child.unref();
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Runs the full login -> config.json -> launch flow. Resolves once the
 * game process has been spawned (not when it exits — use `onExit` for that).
 */
export async function launchMhf(options: LaunchOptions = {}): Promise<GameConfig> {
  const { onLog, onExit, showErrorDialog = true } = options;
  const logger = makeLogger(onLog);

  const fail = (message: string): never => {
    logger.log(`ERROR: ${message}`);
    if (showErrorDialog) {
      dialog.showErrorBox("MHF Launcher", message);
    }
    logger.close();
    throw new LaunchError(message);
  };

  try {
    logger.log(`=== MHF launch ${new Date().toString()} ===`);

    const env = loadEnv(fail);
    await ensureTunnel(logger.log, fail);
    await cleanStaleWine(logger.log);

    const loginData = await login(env, fail);
    const config = toGameConfig(loginData, env);

    const gameDir = options.gameDir || env.MHF_GAME_DIR;
    writeFileSync(join(gameDir, "config.json"), JSON.stringify(config, null, 2), "utf8");
    logger.log(
      `char=${config.char_name} id=${config.char_id} token_id=${config.user_token_id} host=${config.server_host}:${config.server_port}`
    );

    launchGame(gameDir, logger.log, fail, onExit);

    return config;
  } finally {
    logger.close();
  }
}

// ---------------------------------------------------------------------------
// Example IPC wiring — call this once from your main process setup, passing
// the BrowserWindow you want log lines streamed to. Adjust channel names to
// match your preload/renderer contract.
// ---------------------------------------------------------------------------

export function wireUpIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle("mhf:launch", async () => {
    const win = getWindow();
    try {
      const config = await launchMhf({
        onLog: (line) => win?.webContents.send("mhf:log", line),
        onExit: (code) => win?.webContents.send("mhf:exit", code),
      });
      return { ok: true as const, config };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });
}