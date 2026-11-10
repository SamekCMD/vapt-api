export type AccountConfirmationTemplateVariables = {
  confirmation_code: string;
  CONFIRMATION_URL: string;
};

export type PasswordResetTemplateVariables = {
  RESET_PASSWORD_URL: string;
};

export type AuthTemplateVariables =
  | AccountConfirmationTemplateVariables
  | PasswordResetTemplateVariables;

export type AuthEmailService = {
  sendVerification(input: {
    to: string;
    confirmationCode: string;
    confirmationUrl: string;
  }): Promise<void>;
  sendPasswordReset(input: {
    to: string;
    resetPasswordUrl: string;
  }): Promise<void>;
};

export type AuthEmailTemplateConfig = {
  from: string;
  verifyAccountTemplate: string;
  resetPasswordTemplate: string;
};

export type AuthEmailLogger = {
  info(
    fields: {
      templateKind: "verification" | "password-reset";
      resendRequestId: string;
    },
    message: "Auth email sent",
  ): void;
};
