import type { ConsentRequest, ErrorCode, Fix } from "./types.js";

/** Throw from a handler to send a teaching ERROR reply (SPEC §7). */
export class ParleyError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public extra: { fix?: Fix[]; need?: unknown[]; consent?: ConsentRequest; retry?: number | null } = {},
  ) {
    super(message);
    this.name = "ParleyError";
  }
}

/** Build a fix: a sentence plus an optional params merge patch that should make the request succeed. */
export const fix = (say: string, params?: Record<string, unknown>): Fix => (params ? { say, params } : { say });

export const fail = (code: ErrorCode, message: string, extra?: ParleyError["extra"]): never => {
  throw new ParleyError(code, message, extra);
};
