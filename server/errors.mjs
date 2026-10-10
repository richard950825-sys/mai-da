export class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message); this.name = 'AppError'; this.code = code; this.status = status; this.details = details;
  }
}
export function publicError(error) {
  if (error instanceof AppError) return { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
  return { error: { code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求，请稍后重试' } };
}
export function assert(condition, code, message, status = 400, details) {
  if (!condition) throw new AppError(code, message, status, details);
}
