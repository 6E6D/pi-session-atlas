// Metadata-only history annotations. This deliberately does not reconstruct a
// provider request: compaction and request-local hooks may change visibility.
export interface ContextNode {
  id: string;
  parentId: string | null;
  type: string;
  role: string | null;
  targetId: string | null;
  action: "omit" | "replace" | "invalid";
}
export function contextNode(entry: Record<string, unknown>): ContextNode | null {
  if (typeof entry.id !== "string") return null;
  const message = entry.message as Record<string, unknown> | undefined;
  return {
    id: entry.id,
    parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    type: typeof entry.type === "string" ? entry.type : "unknown",
    role: message && typeof message.role === "string" ? message.role : null,
    targetId: typeof entry.targetId === "string" ? entry.targetId : null,
    action: entry.replacement === null ? "omit" :
      typeof entry.replacement === "string" || Array.isArray(entry.replacement) ? "replace" : "invalid",
  };
}
export function contextAnnotations(nodes: ContextNode[], selectedIds: string[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const duplicates = byId.size !== nodes.length;
  function ancestry(id: string | null): { ids: Set<string>; valid: boolean } {
    const ids = new Set<string>();
    while (id !== null) {
      if (ids.has(id) || !byId.has(id)) return { ids, valid: false };
      ids.add(id);
      id = byId.get(id)!.parentId;
    }
    return { ids, valid: !duplicates };
  }
  const leafId = nodes.at(-1)?.id ?? null;
  const active = ancestry(leafId);
  const edits = nodes.filter(node => node.type === "context_edit").map(node => {
    const target = node.targetId ? byId.get(node.targetId) : undefined;
    const parents = ancestry(node.parentId);
    const eligible = target?.type === "custom_message" ||
      (target?.type === "message" && ["user", "assistant", "toolResult"].includes(target.role ?? ""));
    const valid = parents.valid && node.action !== "invalid" && !!eligible && parents.ids.has(node.targetId!);
    return { entryId: node.id, targetId: node.targetId, action: node.action, valid,
      onObservedBranch: active.valid ? active.ids.has(node.id) : null };
  });
  return {
    basis: "source-history" as const,
    observedLeafId: leafId,
    branchValid: active.valid,
    modelContextReconstructed: false as const,
    limitation: "Branch membership and edit annotations are not proof of model visibility. Compaction and per-request transformations are not replayed. History is not redacted.",
    entries: selectedIds.map(id => {
      const related = edits.filter(edit => edit.targetId === id || edit.entryId === id);
      const applicable = edits.filter(edit => edit.targetId === id && edit.onObservedBranch && edit.valid);
      const latest = applicable.at(-1);
      return { entryId: id, onObservedBranch: active.valid ? active.ids.has(id) : null,
        latestValidEditOnObservedBranch: latest?.entryId ?? null,
        editAction: latest?.action ?? null, relatedEdits: related };
    }),
  };
}
