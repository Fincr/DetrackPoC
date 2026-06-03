/** PostgREST returns PostGIS geography columns as EWKB hex. For a PoC we
 *  only ever store SRID-tagged 2D points, so a tiny parser beats pulling in a
 *  geometry library. Layout (little-endian):
 *    byte 0       endian flag (01)
 *    bytes 1-4    geometry type with SRID flag (01000020)
 *    bytes 5-8    SRID (E6100000 = 4326)
 *    bytes 9-16   lng (float64 LE)
 *    bytes 17-24  lat (float64 LE)
 */
export function parseEwkbPoint(hex: unknown): { lat: number; lng: number } | null {
  if (typeof hex !== 'string' || hex.length < 50 || !hex.startsWith('01')) return null
  try {
    const readDouble = (hexOffset: number): number => {
      const dv = new DataView(new ArrayBuffer(8))
      for (let i = 0; i < 8; i++) {
        dv.setUint8(i, parseInt(hex.slice(hexOffset + i * 2, hexOffset + i * 2 + 2), 16))
      }
      return dv.getFloat64(0, true)
    }
    const lng = readDouble(18)
    const lat = readDouble(34)
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null
    return { lat, lng }
  } catch {
    return null
  }
}
