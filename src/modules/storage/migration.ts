export type SourceStorageObject = {
  key: string;
  size: number;
  contentType: string;
  etag: string | null;
  updatedAt: string | null;
};

export type TargetStorageObject = {
  size: number;
  contentType: string | null;
  metadata: Record<string, string>;
};

export type StorageMigrationStatus = "missing" | "verified" | "needs-copy";

export function normalizeEtag(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^"|"$/g, "") ?? "";
  return normalized || null;
}

export function classifyStorageObject(
  source: SourceStorageObject,
  target: TargetStorageObject | null,
): StorageMigrationStatus {
  if (!target) return "missing";
  if (target.size !== source.size || target.contentType !== source.contentType) {
    return "needs-copy";
  }

  const sourceEtag = normalizeEtag(source.etag);
  const copiedSourceEtag = normalizeEtag(target.metadata["source-etag"]);
  if (sourceEtag && sourceEtag !== copiedSourceEtag) {
    return "needs-copy";
  }
  if (!sourceEtag) {
    if (target.metadata["source-key"] !== source.key) return "needs-copy";
    if (source.updatedAt && target.metadata["source-updated-at"] !== source.updatedAt) {
      return "needs-copy";
    }
  }

  return "verified";
}
