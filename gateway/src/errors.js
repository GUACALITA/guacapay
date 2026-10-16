// Error with a stable code and an HTTP status. `providerCode` is for logs only and is never returned to the app.
export class AppError extends Error {
  constructor(code, status, message, { providerCode } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
  }
}
