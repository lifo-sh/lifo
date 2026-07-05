import type * as http from 'node:http';

/** Parsed route parameters (e.g. { id: "a1b2c3" }). */
export interface RouteParams {
  [key: string]: string;
}

/** Extended request with parsed route params and raw body. */
export interface ApiRequest extends http.IncomingMessage {
  params: RouteParams;
  body?: unknown;
}

/** Session object returned by the API. */
export interface ApiSession {
  id: string;
  pid: number;
  socketPath: string;
  mountPath: string;
  startedAt: string;
  port?: number;
  alive: boolean;
}

/** Standard error response. */
export interface ApiError {
  error: string;
}

/** Route handler function. */
export type RouteHandler = (
  req: ApiRequest,
  res: http.ServerResponse,
) => void | Promise<void>;

/** Middleware function — calls next() to continue, or responds and stops. */
export type Middleware = (
  req: ApiRequest,
  res: http.ServerResponse,
  next: () => void,
) => void | Promise<void>;
