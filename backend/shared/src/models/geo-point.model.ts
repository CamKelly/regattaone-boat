/** WGS84 geographic coordinate. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export function isValidGeoPoint(point: GeoPoint | undefined | null): point is GeoPoint {
  if (!point) {
    return false;
  }

  return (
    typeof point.latitude === 'number' &&
    typeof point.longitude === 'number' &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    point.longitude >= -180 &&
    point.longitude <= 180
  );
}
