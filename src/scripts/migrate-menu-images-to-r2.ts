import { createHash } from "node:crypto";

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

import {
  classifyStorageObject,
  normalizeEtag,
  type SourceStorageObject,
  type TargetStorageObject,
} from "../modules/storage/migration.js";
import { reserveMigrationReport } from "../modules/storage/migration-report.js";

type MigrationConfig = {
  sourceUrl: string;
  sourceServiceRoleKey: string;
  sourceBucket: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  targetBucket: string;
};

type MigrationRecord = SourceStorageObject & {
  before: ReturnType<typeof classifyStorageObject>;
  after: "not-run" | "verified" | "failed";
  sha256?: string;
  error?: string;
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function loadConfig(env: NodeJS.ProcessEnv): MigrationConfig {
  return {
    sourceUrl: required(env, "SUPABASE_URL"),
    sourceServiceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    sourceBucket: env.SUPABASE_STORAGE_BUCKET?.trim() || "menu-images",
    r2AccountId: required(env, "R2_ACCOUNT_ID"),
    r2AccessKeyId: required(env, "R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: required(env, "R2_SECRET_ACCESS_KEY"),
    targetBucket: required(env, "R2_BUCKET_NAME"),
  };
}

function joinedPath(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

function metadataString(metadata: Record<string, unknown> | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function listSourceObjects(config: MigrationConfig): Promise<SourceStorageObject[]> {
  const client = createClient(config.sourceUrl, config.sourceServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const bucket = client.storage.from(config.sourceBucket);
  const pending = [""];
  const objects: SourceStorageObject[] = [];

  while (pending.length > 0) {
    const prefix = pending.shift()!;
    let offset = 0;

    while (true) {
      const { data, error } = await bucket.list(prefix, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`Failed to list source prefix ${prefix || "/"}: ${error.message}`);

      for (const entry of data ?? []) {
        const key = joinedPath(prefix, entry.name);
        if (entry.id === null) {
          pending.push(key);
          continue;
        }

        const metadata = (entry.metadata ?? null) as Record<string, unknown> | null;
        const size = Number(metadata?.size);
        if (!Number.isFinite(size) || size < 0) {
          throw new Error(`Source object ${key} has invalid size metadata`);
        }
        objects.push({
          key,
          size,
          contentType: metadataString(metadata, "mimetype", "contentType") ?? "application/octet-stream",
          etag: metadataString(metadata, "eTag", "etag"),
          updatedAt: entry.updated_at ?? null,
        });
      }

      if (!data || data.length < 100) break;
      offset += data.length;
    }
  }

  return objects.sort((left, right) => left.key.localeCompare(right.key));
}

function createR2Client(config: MigrationConfig): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
}

async function inspectTarget(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<TargetStorageObject | null> {
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      size: result.ContentLength ?? -1,
      contentType: result.ContentType ?? null,
      metadata: result.Metadata ?? {},
    };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null;
    throw error;
  }
}

async function copyObject(input: {
  config: MigrationConfig;
  client: S3Client;
  source: SourceStorageObject;
}): Promise<string> {
  const sourceClient = createClient(input.config.sourceUrl, input.config.sourceServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await sourceClient.storage
    .from(input.config.sourceBucket)
    .download(input.source.key, {}, { cache: "no-store" });
  if (error || !data) {
    throw new Error(`Failed to download source object: ${error?.message ?? "empty response"}`);
  }

  const body = Buffer.from(await data.arrayBuffer());
  if (body.byteLength !== input.source.size) {
    throw new Error(`Source size changed during copy: expected ${input.source.size}, got ${body.byteLength}`);
  }
  const md5 = createHash("md5").update(body).digest("base64");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const sourceEtag = normalizeEtag(input.source.etag);

  await input.client.send(new PutObjectCommand({
    Bucket: input.config.targetBucket,
    Key: input.source.key,
    Body: body,
    ContentLength: body.byteLength,
    ContentType: input.source.contentType,
    ContentMD5: md5,
    Metadata: {
      "source-bucket": input.config.sourceBucket,
      "source-key": input.source.key,
      ...(sourceEtag ? { "source-etag": sourceEtag } : {}),
      ...(input.source.updatedAt ? { "source-updated-at": input.source.updatedAt } : {}),
      sha256,
    },
  }));

  const target = await inspectTarget(input.client, input.config.targetBucket, input.source.key);
  if (!target || target.size !== body.byteLength || target.contentType !== input.source.contentType) {
    throw new Error("R2 verification failed after upload");
  }
  if (sourceEtag && normalizeEtag(target.metadata["source-etag"]) !== sourceEtag) {
    throw new Error("R2 source ETag metadata verification failed after upload");
  }
  if (target.metadata["source-key"] !== input.source.key) {
    throw new Error("R2 source key metadata verification failed after upload");
  }
  if (
    input.source.updatedAt &&
    target.metadata["source-updated-at"] !== input.source.updatedAt
  ) {
    throw new Error("R2 source timestamp metadata verification failed after upload");
  }
  if (target.metadata.sha256 !== sha256) {
    throw new Error("R2 SHA-256 metadata verification failed after upload");
  }

  return sha256;
}

function argumentValue(prefix: string): string | null {
  const argument = process.argv.slice(2).find((value) => value.startsWith(`${prefix}=`));
  return argument ? argument.slice(prefix.length + 1) : null;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run storage:migrate -- [--apply] [--report=path]");
    console.log("Default mode is read-only dry-run. --apply also requires R2_MIGRATION_CONFIRM_BUCKET.");
    return;
  }

  const config = loadConfig(process.env);
  const apply = process.argv.includes("--apply");
  if (apply && process.env.R2_MIGRATION_CONFIRM_BUCKET?.trim() !== config.targetBucket) {
    throw new Error("R2_MIGRATION_CONFIRM_BUCKET must exactly match R2_BUCKET_NAME when using --apply");
  }

  const reportPath = argumentValue("--report");
  const reportReservation = reportPath
    ? await reserveMigrationReport(reportPath)
    : null;
  const records: MigrationRecord[] = [];
  let sourceObjectCount = 0;
  let fatalError: string | null = null;

  try {
    const r2 = createR2Client(config);
    const sourceObjects = await listSourceObjects(config);
    sourceObjectCount = sourceObjects.length;

    for (const source of sourceObjects) {
      const target = await inspectTarget(r2, config.targetBucket, source.key);
      const before = classifyStorageObject(source, target);
      const record: MigrationRecord = { ...source, before, after: "not-run" };

      if (apply && before !== "verified") {
        try {
          record.sha256 = await copyObject({ config, client: r2, source });
          record.after = "verified";
        } catch (error) {
          record.after = "failed";
          record.error = error instanceof Error ? error.message : "Unknown copy failure";
        }
      } else if (before === "verified") {
        record.after = "verified";
      }
      records.push(record);
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : "Unknown migration failure";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    sourceBucket: config.sourceBucket,
    targetBucket: config.targetBucket,
    fatalError,
    totals: {
      source: sourceObjectCount,
      processed: records.length,
      missing: records.filter((record) => record.before === "missing").length,
      needsCopy: records.filter((record) => record.before === "needs-copy").length,
      verified: records.filter((record) => record.after === "verified").length,
      failed: records.filter((record) => record.after === "failed").length,
    },
    objects: records,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportReservation) await reportReservation.finalize(serialized);
  console.log(serialized.trimEnd());

  if (fatalError || report.totals.failed > 0) process.exitCode = 1;
}

await main();
