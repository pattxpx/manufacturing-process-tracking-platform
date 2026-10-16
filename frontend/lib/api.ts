// The browser talks only to its own website: /api/* is passed on to the backend by Next.js (see next.config.ts).
// So the session cookie is first-party, and nothing here ever stores a credential: the cookie is HttpOnly
// (JavaScript cannot read it) and the CSRF token lives only in memory.
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/production/";

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Turns FastAPI error bodies (a string, or a list of validation errors) into one readable message. */
function errorMessage(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d: { loc?: string[]; msg?: string }) => {
        const field = d.loc?.filter((part) => part !== "body").join(".");
        const msg = (d.msg ?? "").replace(/^Value error, /, "");
        return field ? `${field}: ${msg}` : msg;
      })
      .join("; ");
  }
  return fallback;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (UNSAFE.has(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Cannot reach the server. Is the backend running?", 0);
  }
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    // The session ended (logged out elsewhere, expired, or the account was disabled): go back to sign-in
    if (response.status === 401 && !path.startsWith("/api/auth/login") && typeof window !== "undefined") {
      window.dispatchEvent(new Event("session-expired"));
    }
    throw new ApiError(errorMessage(body, `Request failed (${response.status})`), response.status);
  }
  return body as T;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
