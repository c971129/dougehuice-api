export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];

const radians = (value: number): number => value * Math.PI / 180;
const degrees = (value: number): number => value * 180 / Math.PI;

export function redmeanDistance(left: Rgb, right: Rgb): number {
  const redMean = (left[0] + right[0]) / 2;
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return (2 + redMean / 256) * red ** 2 + 4 * green ** 2 + (2 + (255 - redMean) / 256) * blue ** 2;
}

export function rgbToLab(red: number, green: number, blue: number): Lab {
  const linear = (channel: number): number => {
    const value = Math.max(0, Math.min(255, channel)) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  const r = linear(red), g = linear(green), b = linear(blue);
  const x = (r * .4124564 + g * .3575761 + b * .1804375) / .95047;
  const y = r * .2126729 + g * .7151522 + b * .072175;
  const z = (r * .0193339 + g * .119192 + b * .9503041) / 1.08883;
  const pivot = (value: number): number => value > .008856451679 ? Math.cbrt(value) : 7.787037037 * value + 16 / 116;
  const fx = pivot(x), fy = pivot(y), fz = pivot(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE2000(left: Lab, right: Lab): number {
  const [l1, a1, b1] = left, [l2, a2, b2] = right;
  const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2), cBar = (c1 + c2) / 2;
  const cBar7 = cBar ** 7;
  const g = .5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));
  const a1p = (1 + g) * a1, a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1), c2p = Math.hypot(a2p, b2);
  const hue = (a: number, b: number): number => {
    if (a === 0 && b === 0) return 0;
    const value = degrees(Math.atan2(b, a));
    return value < 0 ? value + 360 : value;
  };
  const h1p = hue(a1p, b1), h2p = hue(a2p, b2);
  const dh = h2p - h1p;
  const dhd = c1p * c2p === 0 ? 0 : Math.abs(dh) <= 180 ? dh : dh > 180 ? dh - 360 : dh + 360;
  const dLp = l2 - l1, dCp = c2p - c1p;
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(radians(dhd / 2));
  const lBar = (l1 + l2) / 2, cBarp = (c1p + c2p) / 2;
  const hBar = c1p * c2p === 0 ? h1p + h2p
    : Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2
      : h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  const t = 1 - .17 * Math.cos(radians(hBar - 30)) + .24 * Math.cos(radians(2 * hBar))
    + .32 * Math.cos(radians(3 * hBar + 6)) - .2 * Math.cos(radians(4 * hBar - 63));
  const dt = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const c7 = cBarp ** 7, rc = 2 * Math.sqrt(c7 / (c7 + 25 ** 7));
  const sl = 1 + .015 * ((lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + .045 * cBarp, sh = 1 + .015 * cBarp * t;
  const rt = -Math.sin(radians(2 * dt)) * rc;
  const lt = dLp / sl, ct = dCp / sc, ht = dHp / sh;
  return Math.sqrt(lt ** 2 + ct ** 2 + ht ** 2 + rt * ct * ht);
}



