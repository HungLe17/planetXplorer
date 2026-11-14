import { useEffect, useMemo, useState } from "react";

type Asset<T> = { abort: AbortController; value?: T; error?: string };

/** Keep completed and in-flight assets when a live manifest grows or reorders. */
export function useAssets<T>(
  urls: string[],
  load: (url: string, signal: AbortSignal) => Promise<T>,
) {
  const assets = useMemo(() => new Map<string, Asset<T>>(), [load]);
  const [version, refresh] = useState(0);
  useEffect(
    () => () => {
      for (const asset of assets.values()) asset.abort.abort();
      assets.clear();
    },
    [assets],
  );
  useEffect(() => {
    const needed = new Set(urls);
    for (const [url, asset] of assets) {
      if (!needed.has(url)) {
        asset.abort.abort();
        assets.delete(url);
      }
    }
    for (const url of needed) {
      if (assets.has(url)) continue;
      const asset: Asset<T> = { abort: new AbortController() };
      assets.set(url, asset);
      const signal = AbortSignal.any([
        asset.abort.signal,
        AbortSignal.timeout(30000),
      ]);
      load(url, signal)
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
    }
  }, [assets, load, urls]);
  return { assets, version };
}
