import { inspectBand, type Product } from "@/lib/imaging";
export default function Spectrum({
  product,
  pixel,
  width,
  height,
  inspectFlagged,
}: {
  product: Product;
  pixel: [number, number] | null;
  width: number;
  height: number;
  inspectFlagged: boolean;
}) {
  const [x, y] = pixel ?? [Math.floor(width / 2), Math.floor(height / 2)];
  const index = y * width + x;
  const rgb = product.planes.length === 3;
  const points = product.inputs.map((f, i) => ({
    id: f.observation_id,
    wave: f.wavelength_um,
    value: product.planes[i][index],
    details: product.sourcePlanes?.[i]?.quality
      ? inspectBand(product.sourcePlanes[i], index, inspectFlagged)
      : undefined,
    color: ["#ff6666", "#66cc77", "#6699ff"][i],
  }));
  const valid = points.filter((p) => p.wave != null && Number.isFinite(p.value));
  const lo = Math.min(...valid.map((p) => p.value)),
    hi = Math.max(...valid.map((p) => p.value));
  const left = Math.min(...valid.map((p) => p.wave!)),
    right = Math.max(...valid.map((p) => p.wave!));
  return (
    <figure className="pixel-inspector" aria-label="Selected pixel">
      <figcaption>
        {rgb ? "Brightness vs wavelength" : "Pixel measurement"} · pixel {x + 1}, {y + 1}
      </figcaption>
      {rgb && <svg
        viewBox="0 0 180 80"
        role="img"
        aria-label="Three wavelength brightness measurements"
      >
        <path d="M8 5 V72 H175" stroke="currentColor" fill="none" />
        {valid.map((p, i) => (
          <circle
            key={i}
            cx={12 + (155 * (p.wave! - left)) / (right - left || 1)}
            cy={68 - (60 * (p.value - lo)) / (hi - lo || 1)}
            r="4"
            fill={p.color}
          />
        ))}
      </svg>}
      {points.map((p, i) => {
        const d = p.details;
        return (
          <div className="pixel-band" key={p.id}>
            <strong style={rgb ? { color: p.color } : undefined}>
              {rgb && ["Red · ", "Green · ", "Blue · "][i]}
              {p.wave != null ? p.wave.toFixed(4) + " µm" : p.id}
            </strong>
            {d ? (
              <>
                <span>Archived brightness · {Number.isFinite(d.archived) ? d.archived.toPrecision(5) + " MJy/sr" : String(d.archived)}</span>
                <span className={d.warning ? "pixel-warning" : undefined}>{d.treatment}</span>
                {d.uncertaintyUnavailable && <span>Uncertainty unavailable</span>}
                {d.flags.length > 0 && <span className="pixel-flags">Flags · {d.flags.join(", ")}</span>}
              </>
            ) : (
              <span>{Number.isFinite(p.value) ? p.value.toPrecision(5) + " MJy/sr" : "No valid measurement"}</span>
            )}
          </div>
        );
      })}
    </figure>
  );
}
