import os from "node:os";
import path from "node:path";

/**
 * On-disk state dir for the vendored WeChat (iLink) transport: account index,
 * per-account credential cache, sync buffers, context tokens. The adapter sets
 * this via setStateDir() in initialize(); falls back to an env var or ~/.craft-agent.
 */
let overrideStateDir: string | undefined;

export function setStateDir(dir: string | undefined): void {
  overrideStateDir = dir?.trim() || undefined;
}

export function resolveStateDir(): string {
  return (
    overrideStateDir ||
    process.env.CRAFT_WECHAT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".craft-agent", "wechat")
  );
}
