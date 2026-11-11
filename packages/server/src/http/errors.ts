import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * An error that maps directly onto an API response. Ludus clients expect every
 * failure to be a JSON object of the form `{"error": "<message>"}`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    /** Optional replacement body for the few endpoints whose error shape differs. */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string) => new ApiError(400, message);
export const unauthorized = (message: string) => new ApiError(401, message);
export const forbidden = (message: string) => new ApiError(403, message);
export const notFound = (message: string) => new ApiError(404, message);
export const conflict = (message: string) => new ApiError(409, message);
export const serverError = (message: string) => new ApiError(500, message);

export function result(c: Context, message: unknown, status: ContentfulStatusCode = 200) {
  return c.json({ result: message }, status);
}

/** The response Ludus gives for enterprise-only endpoints when the plugin is absent. */
export function pluginNotLoaded(): ApiError {
  return notFound('This endpoint is implemented in a plugin that is not loaded');
}
