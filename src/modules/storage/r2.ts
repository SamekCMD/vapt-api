import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { AppConfig } from "../../lib/config.js";
import type { MenuImageGateway } from "./service.js";

type R2Config = NonNullable<AppConfig["r2"]>;

export function createR2MenuImageGateway(config: R2Config): MenuImageGateway {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async createUploadUrl(input) {
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: input.objectKey,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
        }),
        {
          expiresIn: input.expiresInSeconds,
          signableHeaders: new Set(["content-length", "content-type"]),
        },
      );
    },

    async deleteObject({ objectKey }) {
      await client.send(new DeleteObjectCommand({
        Bucket: config.bucketName,
        Key: objectKey,
      }));
    },
  };
}
