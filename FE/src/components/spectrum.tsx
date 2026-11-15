import { useId, useMemo } from "react";
import { useSpectralPlanes } from "@/lib/use-images";
import {
  detectors,
  measureSpectrum,
  spectrumBins,
  type SpectrumBin,
  type PixelRect as Rect,
  type Plane,
} from "@/lib/imaging";

const nfmt = (v: number) =>
  Number.isFinite(v) ? Number(v.toPrecision(5)).toString() : "—";
export function SpectrumGraph({
  title,
  rows,
  domain,
  connect = true,
  logarithmic = false,
}: {
  title: string;
  rows: SpectrumBin[];
  domain: number[];
  connect?: boolean;
  logarithmic?: boolean;
}) {
  const clip = useId();
  const [xmin, xmax, linearMin, linearMax] = domain;
  const pts = rows.filter(
    (p) => Number.isFinite(p.wave) && Number.isFinite(p.mean) && (!logarithmic || p.mean > 0),
  );
  const values = pts.map(p => logarithmic ? Math.log(p.mean) : p.mean);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const padding = high === low ? 1 : (high - low) * 0.04;
  const ymin = logarithmic ? low - padding : linearMin;
  const ymax = logarithmic ? high + padding : linearMax;
  const x = (v: number) => 49 + ((v - xmin) / (xmax - xmin)) * 229;
  const y = (v: number) => 107 - (((logarithmic ? Math.log(v) : v) - ymin) / (ymax - ymin)) * 87;
  return (
    <figure className="spectrum-chart" aria-label={title + " spectrum"}>
      <figcaption>{title}</figcaption>
      <svg
        viewBox="0 0 300 146"
        role="img"
        aria-label={title + (logarithmic ? " · natural log intensity versus wavelength" : " · surface brightness versus wavelength")}
      >
        <g fill="currentColor" fontSize="10">
          <path d="M49 20 V107 H278" fill="none" stroke="currentColor" />
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <text x={49 + t * 229} y="121" textAnchor="middle">
                {nfmt(xmin + t * (xmax - xmin))}
              </text>
              <text x="45" y={110 - t * 87} textAnchor="end">
                {nfmt(ymin + t * (ymax - ymin))}
              </text>
            </g>
          ))}
          <text x="162" y="141" textAnchor="middle">
            Wavelength (µm)
          </text>
          <text x="49" y="13">
            {logarithmic ? "ln(Intensity / 1 MJy/sr)" : "Intensity (MJy/sr)"}
          </text>
        </g>
        <defs><clipPath id={clip}><rect x="48" y="18" width="232" height="89" /></clipPath></defs>
        <g clipPath={`url(#${clip})`}>
          {connect && <polyline points={pts.map(p => `${x(p.wave)},${y(p.mean)}`).join(" ")}
            fill="none" stroke="currentColor" strokeWidth="1" />}
          {pts.map(({ wave, mean, detector, finite }, index) => (
            <circle key={index} cx={x(wave)} cy={y(mean)} r="1.5" fill="currentColor">
              <title>{detector} · {nfmt(wave)} µm · {nfmt(mean)} MJy/sr · {finite} pixels</title>
            </circle>
          ))}
        </g>
      </svg>
      {!pts.length && <p>{logarithmic ? "No positive spectral samples available." : "No finite spectral samples available."}</p>}
      {logarithmic && rows.some(p => Number.isFinite(p.mean) && p.mean <= 0) &&
        <p>Zero and negative intensities are listed below and omitted from the logarithmic graph.</p>}
    </figure>
  );
}
export default function Spectrum({
  planes: brightness,
  pixel,
  region,
  width,
  height,
  pending = false,
}: {
  planes: Plane[];
  pixel: [number, number] | null;
  region?: Rect | null;
  width: number;
  height: number;
  pending?: boolean;
}) {
  const wavelengths = useSpectralPlanes(brightness, width * height);
  const planes = wavelengths.planes;
  const bins = useMemo(() => spectrumBins(planes), [planes]);
  const px = pixel?.[0] ?? Math.floor(width / 2),
    py = pixel?.[1] ?? Math.floor(height / 2);
  const x0 = Math.max(
    0,
    Math.min(width - 1, Math.min(region?.[0] ?? px, region?.[2] ?? px)),
  );
  const y0 = Math.max(
    0,
    Math.min(height - 1, Math.min(region?.[1] ?? py, region?.[3] ?? py)),
  );
  const x1 = Math.max(
    0,
    Math.min(width - 1, Math.max(region?.[0] ?? px, region?.[2] ?? px)),
  );
  const y1 = Math.max(
    0,
    Math.min(height - 1, Math.max(region?.[1] ?? py, region?.[3] ?? py)),
  );
  const selected = useMemo(
    () => measureSpectrum(planes, bins, width, [x0, y0, x1, y1], true),
    [planes, bins, width, x0, y0, x1, y1],
  );
  const regionSelected = x1 !== x0 || y1 !== y0;
  const acquired = [...new Set(planes.map((p) => p.frame.detector))].sort();
  const missing = detectors.filter((detector) => !acquired.includes(detector));
  const title = regionSelected ? "Selected region" : "Selected pixel";
  return (
    <section className="spectra-panels" aria-label="Visit spectra">
      {width > 0 && height > 0 && <p>
        {regionSelected
          ? `Region (${x0 + 1}, ${y0 + 1}) – (${x1 + 1}, ${y1 + 1})`
          : `Pixel (${x0 + 1}, ${y0 + 1})`}
      </p>}
      <p>
        {planes.length} loaded exposure{planes.length !== 1 ? "s" : ""}
        {acquired.length ? " · " + acquired.join(", ") : ""}
        {pending ? " · further coverage pending" : ""}
      </p>
      {wavelengths.loading && <p role="status">Loading per-pixel wavelengths…</p>}
      {wavelengths.failed > 0 && <p role="status">Per-pixel wavelengths unavailable.{" "}
        <button className="button" onClick={wavelengths.retry}>Retry wavelengths</button>
      </p>}
      <SpectrumGraph title={title} rows={selected.bins} domain={selected.domain} logarithmic />
      {!!planes.length && !!missing.length && (
        <p>No loaded exposures for {missing.join(", ")}.</p>
      )}
      {planes.some((p) => !p.frame.spectral && !p.wavelengths) && (
        <p>Legacy frames use the field-center wavelength.</p>
      )}
      {!!selected.samples.length && <details open>
        <summary>Selection measurements and flags</summary>
        {selected.samples.map((row) => (
          <div className="pixel-band" key={row.plane.frame.observation_id}>
            <strong>
              {row.plane.frame.detector} · {nfmt(row.wave)} µm
            </strong>
            <span>
              {regionSelected ? "Mean intensity" : "Archived intensity"} ·{" "}
              {Number.isFinite(row.mean)
                ? nfmt(row.mean) + " MJy/sr"
                : "NaN / unavailable"}
            </span>
            {regionSelected && (
              <span>
                Finite samples · {row.finite} / {row.total}
              </span>
            )}
            <span>
              {row.plane.quality
                ? "Flags · " +
                  ([...row.flags]
                    .map(([k, n]) => (regionSelected ? k + " (" + n + ")" : k))
                    .join(", ") || "none")
                : "Archive flags unavailable"}
            </span>
            {row.overflow > 0 && (
              <span>
                {row.overflow} overflow{" "}
                {row.overflow === 1 ? "marker" : "markers"} · excluded from
                means
              </span>
            )}
            {row.negative > 0 && (
              <span>{row.negative} negative · blank on image</span>
            )}
          </div>
        ))}
      </details>}
    </section>
  );
}
