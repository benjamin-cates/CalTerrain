declare module "shpjs" {
  type Position = [number, number];
  export type ShapefileGeometry =
    | { type: "LineString"; coordinates: Position[] }
    | { type: "MultiLineString"; coordinates: Position[][] }
    | { type: "Polygon"; coordinates: Position[][] }
    | { type: "MultiPolygon"; coordinates: Position[][][] };
  export type ShapefileFeature = {
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: ShapefileGeometry | null;
  };
  export type ShapefileFeatureCollection = {
    type: "FeatureCollection";
    features: ShapefileFeature[];
  };
  export type ShapefileResult = ShapefileFeatureCollection | ShapefileFeatureCollection[];

  export default function shp(source: ArrayBuffer): Promise<ShapefileResult>;
}
