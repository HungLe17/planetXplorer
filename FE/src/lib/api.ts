import { Frame, Job, Manifest, Query } from "./types";
export const base = (
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000"
).replace(/\/$/, "");
export async function request<T>(
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch(base + path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "The processing queue is full. Please try again shortly."
        : response.status === 404
          ? "This request has expired. Search again to retrieve observations."
          : `The archive service returned an error (${response.status}). Try again shortly.`,
    );
  return response.json();
}
export function assetUrl(path: string) {
  const url = new URL(path, base + "/");
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Unsupported image address.");
  return url.href;
}
export function validateManifest(input: Manifest): Manifest {
  if (!input || !Array.isArray(input.frames) || input.frames.length > 12)
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
