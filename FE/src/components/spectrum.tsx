import type { Product } from "@/lib/imaging";
export default function Spectrum({
  product,
  pixel,
  width,
  height,
}: {
  product: Product;
  pixel: [number, number] | null;
  width: number;
  height: number;
}) {
  const [x, y] = pixel ?? [Math.floor(width / 2), Math.floor(height / 2)];
  const points = product.inputs.map((f, i) => ({
    wave: f.wavelength_um!,
    value: product.planes[i][y * width + x],
    color: ["#ff6666", "#66cc77", "#6699ff"][i],
  }));
  const valid = points.filter((p) => Number.isFinite(p.value));
  const lo = Math.min(...valid.map((p) => p.value)),
    hi = Math.max(...valid.map((p) => p.value));
  const left = Math.min(...points.map((p) => p.wave)),
    right = Math.max(...points.map((p) => p.wave));
  return (
    <figure>
      <figcaption>
        Brightness vs wavelength · pixel {x + 1}, {y + 1}
      </figcaption>
      <svg
        viewBox="0 0 180 80"
        role="img"
        aria-label="Three wavelength brightness measurements"
      >
        <path d="M8 5 V72 H175" stroke="currentColor" fill="none" />
        {valid.map((p, i) => (
          <circle
            key={i}
            cx={12 + (155 * (p.wave - left)) / (right - left || 1)}
            cy={68 - (60 * (p.value - lo)) / (hi - lo || 1)}
            r="4"
            fill={p.color}
          />
        ))}
      </svg>
      {points.map((p, i) => (
        <p key={i} style={{ color: p.color }}>
          {p.wave.toFixed(4)} µm ·{" "}
          {Number.isFinite(p.value)
            ? p.value.toPrecision(5) + " MJy/sr"
            : "No valid measurement"}
        </p>
      ))}
    </figure>
  );
}
