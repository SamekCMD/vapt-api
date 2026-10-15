export type BetterAuthSession = {
  user: {
    id: string;
    email: string;
    name: string;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
  };
};

export type AuthRuntime = {
  handler(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<BetterAuthSession | null>;
  close(): Promise<void>;
};

export type BackgroundTaskRunner = (task: Promise<unknown>) => void;
