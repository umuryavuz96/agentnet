// One update at a time: $HOME/run/update.lock, created with open(wx). A lock whose pid is dead is stale and replaced.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface Lock { id: string; pid: number; startedAt: number }
const file = (home: string) => join(home, "run", "update.lock");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The live holder, or null (no lock, unreadable, or stale). */
export function readLock(home: string): Lock | null {
  try {
    const l = JSON.parse(readFileSync(file(home), "utf8")) as Lock;
    return l && Number.isInteger(l.pid) && alive(l.pid) ? l : null;
  } catch { return null; }
}

export function acquire(home: string, id: string, pid = process.pid): Lock | null {
  mkdirSync(join(home, "run"), { recursive: true });
  const lock: Lock = { id, pid, startedAt: Date.now() };
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file(home), "wx");
      try { writeSync(fd, JSON.stringify(lock)); } finally { closeSync(fd); }
      return lock;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (readLock(home)) return null;
      rmSync(file(home), { force: true }); // stale
    }
  }
  return null;
}

export function release(home: string, id: string): void {
  try {
    const l = JSON.parse(readFileSync(file(home), "utf8")) as Lock;
    if (l.id === id) rmSync(file(home), { force: true });
  } catch { /* already gone */ }
}
