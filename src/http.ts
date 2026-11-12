import type { FetchLike } from "./types.js";

export class ProviderError extends Error {
  constructor(
    public provider: string,
    message: string,
    public status?: number,
  ) {
    super(`[${provider}] ${message}`);
  }
}

const TIMEOUT_MS = 15_000;

export async function fetchJson<T>(
  provider: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ProviderError(provider, `request failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(provider, `HTTP ${res.status}: ${redact(text).slice(0, 500)}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, `invalid JSON response: ${redact(text).slice(0, 200)}`);
  }
}

/** Never echo API keys back into tool output. */
export function redact(s: string): string {
  return s.replace(/([?&]key=)[^&\s"]+/gi, "$1***");
}
