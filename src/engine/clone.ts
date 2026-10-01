// src/engine/clone.ts — host-portable snapshot copy for the pure
// reducers. The desktop guest runs on QuickJS/rquickjs, which has no
// structuredClone global (fleet review C06: the app threw on its first
// native frame). Every folded state is plain JSON-shaped data — switches,
// fibers, compiled programs, typed arrays are NOT part of these states — so
// a recursive value clone is enough and keeps the reducer free of host
// globals. undefined-valued keys are preserved (a held self switch is
// cleared by storing undefined, not by deleting the key).

export function deepClone<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const out = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = deepClone(v[i]);
    return out as T;
  }
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = Object.getPrototypeOf(src) === null
    ? Object.create(null) as Record<string, unknown>
    : {};
  for (const k of Object.keys(src)) {
    const value = deepClone(src[k]);
    // Only this legacy accessor needs defineProperty. Ordinary JSON keys can
    // take the VM's fast assignment path; battle states contain thousands of
    // them and are cloned several times per reducer frame.
    if (k === "__proto__" && Object.getPrototypeOf(out) !== null) {
      Object.defineProperty(out, k, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      out[k] = value;
    }
  }
  return out as T;
}

/** A JSON-shaped dictionary whose external string keys never consult the
 * Object prototype. Object.keys/JSON.stringify preserve its wire shape. */
export function keyedRecord<T>(src?: Readonly<Record<string, T>>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (src) {
    for (const key of Object.keys(src)) out[key] = src[key]!;
  }
  return out;
}
