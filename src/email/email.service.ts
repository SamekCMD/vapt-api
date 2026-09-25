import type { CreateEmailOptions } from "resend";

import type { ResendEmailClient } from "./resend.client.js";
import type {
  AccountConfirmationTemplateVariables,
  AuthEmailLogger,
  AuthEmailService,
  AuthEmailTemplateConfig,
  PasswordResetTemplateVariables,
} from "./types.js";

const silentLogger: AuthEmailLogger = {
  info() {},
};

class AuthEmailDeliveryError extends Error {
  constructor(templateKind: "verification" | "password-reset") {
    super(`Failed to send ${templateKind} email`);
    this.name = "AuthEmailDeliveryError";
  }
}

export function createResendAuthEmailService(
  client: ResendEmailClient,
  config: AuthEmailTemplateConfig,
  logger: AuthEmailLogger = silentLogger,
): AuthEmailService {
  async function send(
    templateKind: "verification" | "password-reset",
    payload: CreateEmailOptions,
  ): Promise<void> {
    try {
      const result = await client.emails.send(payload);

      if (result.error || !result.data?.id) {
        throw new AuthEmailDeliveryError(templateKind);
      }

      logger.info(
        {
          templateKind,
          resendRequestId: result.data.id,
        },
        "Auth email sent",
      );
    } catch {
      throw new AuthEmailDeliveryError(templateKind);
    }
  }

  return {
    async sendVerification(input) {
      const variables: AccountConfirmationTemplateVariables = {
        CONFIRMATION_CODE: input.confirmationCode,
        CONFIRMATION_URL: input.confirmationUrl,
      };

      await send("verification", {
        from: config.from,
        to: input.to,
        template: {
          id: config.verifyAccountTemplate,
          variables,
        },
      });
    },

    async sendPasswordReset(input) {
      const variables: PasswordResetTemplateVariables = {
        RESET_PASSWORD_URL: input.resetPasswordUrl,
      };

      await send("password-reset", {
        from: config.from,
        to: input.to,
        template: {
          id: config.resetPasswordTemplate,
          variables,
        },
      });
    },
  };
}
