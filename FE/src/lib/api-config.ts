/** Normalize the public backend setting before constructing any request URL. */
export function normalizeApiBase(value: string): string {
  const input = value.trim();
  if (!input)
    throw new Error("Set NEXT_PUBLIC_API_BASE_URL to the backend URL.");
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(
    input,
  );
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
    ? input
    : `${local ? "http" : "https"}://${input}`;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must be a valid backend URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL must be an HTTP(S) backend URL without credentials, query parameters, or fragments.",
    );
  }
  if (/\/(docs|redoc|openapi\.json|api)\/?$/.test(url.pathname)) {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL must be the backend base URL, without /api, /docs, /redoc, or /openapi.json.",
    );
  }
  return url.href.replace(/\/+$/, "");
}
