import { Resend } from "resend";

export type ResendEmailClient = {
  emails: Pick<Resend["emails"], "send">;
};

export function createResendEmailClient(apiKey: string): ResendEmailClient {
  return new Resend(apiKey);
}
