// Header counts of the Routing picks list. Each pick lands in exactly one group, owner-named first:
// a pick the owner named counts as "owner" even when the mode also capped it.
export interface PickFlags { owner: boolean; changed: boolean }
export function pickCounts(l: PickFlags[]) {
  const owner = l.filter((p) => p.owner).length, mode = l.filter((p) => !p.owner && p.changed).length;
  return { owner, mode, kept: l.length - owner - mode, total: l.length };
}
