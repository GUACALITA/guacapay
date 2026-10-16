// Application error with a stable code and an HTTP status.
// The message is safe to show to the client.
export class AppError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}
