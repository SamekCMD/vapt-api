import type { AppConfig } from "../../lib/config.js";
import { createR2MenuImageGateway } from "./r2.js";
import type { MenuImageGateway } from "./service.js";

export type WorkerR2Bucket = { delete(key: string): Promise<unknown> };

export function createWorkerMenuImageGateway(
  signing: NonNullable<AppConfig["r2"]>,
  bucket: WorkerR2Bucket,
): MenuImageGateway {
  let signer: MenuImageGateway | undefined;
  return {
    createUploadUrl(input) {
      signer ??= createR2MenuImageGateway(signing);
      return signer.createUploadUrl(input);
    },
    async deleteObject({ objectKey }) { await bucket.delete(objectKey); },
  };
}
