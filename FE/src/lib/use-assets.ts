import { useCallback, useEffect, useMemo, useState } from "react";

type Asset<T> = { abort: AbortController; value?: T; error?: string };

/** Reuse completed and in-flight assets across progressive catalog revisions. */
export function useAssets<T>(
  urls: string[],
  load: (url: string, signal: AbortSignal, retry?: boolean) => Promise<T>,
  capacity = 0,
) {
  const assets = useMemo(() => new Map<string, Asset<T>>(), [load]);
  const [version, refresh] = useState(0);
  const start = useCallback(
    (url: string, retry = false) => {
      const asset: Asset<T> = { abort: new AbortController() };
      assets.set(url, asset);
      const signal = AbortSignal.any([
        asset.abort.signal,
        AbortSignal.timeout(30000),
      ]);
      load(url, signal, retry)
        .then(
          (value) => {
            asset.value = value;
          },
          (error) => {
            asset.error =
              error instanceof Error ? error.message : String(error);
          },
        )
        .finally(() => {
          if (!asset.abort.signal.aborted) refresh((v) => v + 1);
        });
    },
    [assets, load],
  );
  useEffect(
    () => () => {
      for (const asset of assets.values()) asset.abort.abort();
      assets.clear();
    },
    [assets],
  );
  useEffect(() => {
    const needed = new Set(urls);
    for (const url of needed) {
      const cached = assets.get(url);
      if (!cached) start(url);
      else if (capacity) {
        // Refresh recency so stepping back through neighboring frames stays cheap.
        assets.delete(url);
        assets.set(url, cached);
      }
    }
    for (const [url, asset] of assets) {
      if (needed.has(url)) continue;
      if (capacity && assets.size <= capacity) break;
      asset.abort.abort();
      assets.delete(url);
    }
  }, [assets, capacity, start, urls]);
  const retry = useCallback(
    (url: string) => {
      if (!assets.get(url)?.error) return;
      start(url, true);
      refresh((v) => v + 1);
    },
    [assets, start],
  );
  return { assets, version, retry };
}
