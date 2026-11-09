// Release tags: only vMAJOR.MINOR.PATCH. Pre-release and other tags never count.
export interface Ver { major: number; minor: number; patch: number; tag: string }

const NUM = "(0|[1-9]\\d{0,8})"; // no leading zeros, safe integer
const TAG = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}$`);
const PLAIN = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);

const make = (m: RegExpExecArray): Ver => ({ major: +m[1]!, minor: +m[2]!, patch: +m[3]!, tag: `v${m[1]}.${m[2]}.${m[3]}` });

export function parseTag(tag: string): Ver | null {
  const m = TAG.exec(tag);
  return m ? make(m) : null;
}

/** "0.3.0" (package.json) to the same Ver as v0.3.0. */
export function fromPackage(version: string): Ver | null {
  const m = PLAIN.exec(version);
  return m ? make(m) : null;
}

export const cmp = (a: Ver, b: Ver): number => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

export function newest(tags: string[]): Ver | null {
  let best: Ver | null = null;
  for (const t of tags) {
    const v = parseTag(t);
    if (v && (!best || cmp(v, best) > 0)) best = v;
  }
  return best;
}

export const versionOf = (v: Ver): string => v.tag.slice(1);
