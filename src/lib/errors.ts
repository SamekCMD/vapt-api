export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly diagnostics?: Record<string, string | null>,
  ) {
    super(message);
    this.name = "AppError";
  }
}
