import { Frame, Job, Manifest, Query } from "./types";
import { normalizeApiBase } from "./api-config";
export const base = normalizeApiBase(
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000",
);
export class ServiceError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
export async function request<T>(
  path: string,
  signal: AbortSignal,
  body?: unknown,
  timeoutMs = 30000,
): Promise<T> {
  const response = await fetch(base + path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const detail = await response.json().then(r => r?.detail, () => null);
    if (typeof detail?.message === "string" && typeof detail?.code === "string")
      throw new ServiceError(detail.message, detail.code);
    if (response.status === 404) {
      const pollingJob = !body && /^\/api\/jobs\/[^/]+$/.test(path);
      throw new Error(
        pollingJob
          ? "This search is no longer available. The backend may have restarted or the job expired. Search again."
          : `Backend endpoint not found: ${path}. Check NEXT_PUBLIC_API_BASE_URL and redeploy the frontend.`,
      );
    }
    if (response.status === 429) {
      throw new Error(
        typeof detail === "string"
          ? detail
          : "The processing queue is full. Please try again shortly.",
      );
    }
    throw new Error(
      `The archive service returned an error (${response.status}). Try again shortly.`,
    );
  }
  return response.json();
}
export function assetUrl(path: string) {
  const url = new URL(path, base + "/");
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Unsupported image address.");
  return url.href;
}
export function validateManifest(input: Manifest): Manifest {
  if (!input || !Array.isArray(input.frames) || input.frames.length > 512)
    throw new Error("The service returned an invalid observation sequence.");
  const frames = input.frames.map((f: Frame) => {
    if (
      !f.id ||
      !f.observation_id ||
      !f.url ||
      !Number.isFinite(Date.parse(f.observed_at))
    )
      throw new Error(
        "An observation is missing its image, source identifier, or date.",
      );
    return { ...f, url: assetUrl(f.url) };
  });
  return {
    ...input,
    frames: frames.sort(
      (a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at),
    ),
  };
}
export async function submit(query: Query, signal: AbortSignal) {
  const value = await request<{ job_id: string }>("/api/jobs", signal, query);
  if (!value.job_id)
    throw new Error("The service did not return a request identifier.");
  return value.job_id;
}
export const poll = (id: string, signal: AbortSignal) =>
  request<Job>("/api/jobs/" + encodeURIComponent(id), signal);

export const cancelJob = (id: string) =>
  request<Job>(
    "/api/jobs/" + encodeURIComponent(id) + "/cancel",
    AbortSignal.timeout(10000),
    {},
  );

export const loadObservations = async (
  id: string,
  signal: AbortSignal,
  observation_ids: string[] = [],
  detector?: string,
  channels?: Query["channels"],
) => {
  const data = await request<{ job_id: string }>(
    "/api/jobs/" + encodeURIComponent(id) + "/load",
    signal,
    {
      observation_ids,
      ...(detector ? { detector } : {}),
      ...(channels ? { channels } : {}),
    },
  );
  return data.job_id;
};
