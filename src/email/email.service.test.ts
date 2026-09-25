import assert from "node:assert/strict";
import test from "node:test";

import type { ResendEmailClient } from "./resend.client.js";
import { createResendAuthEmailService } from "./email.service.js";

const config = {
  from: "Vapt <contato@vapt.example>",
  verifyAccountTemplate: "account-confirmation",
  resetPasswordTemplate: "password-reset",
};

function createFakeClient(result: unknown) {
  const sent: unknown[] = [];
  const client = {
    emails: {
      async send(payload: unknown) {
        sent.push(payload);
        return result;
      },
    },
  } as ResendEmailClient;

  return { client, sent };
}

test("verification email uses only the published Resend template contract", async () => {
  const { client, sent } = createFakeClient({
    data: { id: "email-verification-1" },
    error: null,
  });
  const service = createResendAuthEmailService(client, config);

  await service.sendVerification({
    to: "gestor@vapt.test",
    confirmationCode: "verification-token-redacted",
    confirmationUrl:
      "https://api.preview.example/api/auth/verify-email?token=redacted",
  });

  assert.deepEqual(sent, [{
    from: "Vapt <contato@vapt.example>",
    to: "gestor@vapt.test",
    template: {
      id: "account-confirmation",
      variables: {
        CONFIRMATION_CODE: "verification-token-redacted",
        CONFIRMATION_URL:
          "https://api.preview.example/api/auth/verify-email?token=redacted",
      },
    },
  }]);
  assert.equal("html" in (sent[0] as object), false);
  assert.equal("text" in (sent[0] as object), false);
  assert.equal("subject" in (sent[0] as object), false);
});

test("password reset email uses only the published Resend template contract", async () => {
  const { client, sent } = createFakeClient({
    data: { id: "email-reset-1" },
    error: null,
  });
  const service = createResendAuthEmailService(client, config);

  await service.sendPasswordReset({
    to: "gestor@vapt.test",
    resetPasswordUrl:
      "https://app.preview.example/reset-password?token=redacted",
  });

  assert.deepEqual(sent, [{
    from: "Vapt <contato@vapt.example>",
    to: "gestor@vapt.test",
    template: {
      id: "password-reset",
      variables: {
        RESET_PASSWORD_URL:
          "https://app.preview.example/reset-password?token=redacted",
      },
    },
  }]);
  assert.equal("html" in (sent[0] as object), false);
  assert.equal("text" in (sent[0] as object), false);
  assert.equal("subject" in (sent[0] as object), false);
});

test("Resend errors are sanitized before leaving the email boundary", async () => {
  const recipient = "gestor@vapt.test";
  const actionUrl =
    "https://api.preview.example/api/auth/verify-email?token=sensitive-token";
  const { client } = createFakeClient({
    data: null,
    error: {
      message: `Could not send to ${recipient} using ${actionUrl}`,
      name: "validation_error",
    },
  });
  const service = createResendAuthEmailService(client, config);

  await assert.rejects(
    service.sendVerification({
      to: recipient,
      confirmationCode: "sensitive-token",
      confirmationUrl: actionUrl,
    }),
    (error: Error) => {
      assert.match(error.message, /verification email/i);
      assert.doesNotMatch(error.message, new RegExp(recipient));
      assert.doesNotMatch(error.message, /sensitive-token/);
      assert.doesNotMatch(error.message, /api\.preview\.example/);
      return true;
    },
  );
});

test("success logs contain only template kind and Resend request ID", async () => {
  const { client } = createFakeClient({
    data: { id: "email-verification-1" },
    error: null,
  });
  const entries: unknown[] = [];
  const service = createResendAuthEmailService(client, config, {
    info(fields, message) {
      entries.push({ fields, message });
    },
  });

  await service.sendVerification({
    to: "gestor@vapt.test",
    confirmationCode: "sensitive-token",
    confirmationUrl:
      "https://api.preview.example/api/auth/verify-email?token=sensitive-token",
  });

  assert.deepEqual(entries, [{
    fields: {
      templateKind: "verification",
      resendRequestId: "email-verification-1",
    },
    message: "Auth email sent",
  }]);
  assert.doesNotMatch(JSON.stringify(entries), /gestor@vapt\.test/);
  assert.doesNotMatch(JSON.stringify(entries), /sensitive-token/);
});
