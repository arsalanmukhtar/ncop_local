// map-source-spec.js
// Layer registries keep the source id inside the source object
// ({ id, type, ... }). Mapbox takes the id as addSource()'s first argument and
// warns 'unknown property "id"' when it validates a geojson / image / video
// spec that still carries it. (vector / raster specs accept extra properties,
// and custom sources are class instances, so both are passed through as-is.)
const STRICT_TYPES = new Set(["geojson", "image", "video"]);

export function sourceSpec(source) {
  if (!source || !STRICT_TYPES.has(source.type) || !("id" in source)) return source;
  const { id: _id, ...spec } = source;
  return spec;
}
