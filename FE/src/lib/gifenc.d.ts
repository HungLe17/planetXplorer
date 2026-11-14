declare module "gifenc" {
  export function quantize(a: Uint8ClampedArray, n: number): number[][];
  export function applyPalette(a: Uint8ClampedArray, p: number[][]): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(
      a: Uint8Array,
      w: number,
      h: number,
      o: { delay: number; repeat: number; palette: number[][] },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}
