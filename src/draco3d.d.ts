declare module "draco3d" {
  export function createEncoderModule(options?: {
    locateFile?: (path: string) => string;
  }): Promise<unknown>;

  export type DracoDecoderGeometry = {
    num_faces(): number;
    num_points(): number;
  };

  export type DracoDecoderBuffer = {
    Init(data: Int8Array, byteLength: number): void;
  };

  export type DracoDecoderStatus = {
    ok(): boolean;
  };

  export type DracoFloat32Array = {
    size(): number;
    GetValue(index: number): number;
  };

  export type DracoDecoder = {
    DecodeBufferToMesh(
      buffer: DracoDecoderBuffer,
      mesh: DracoDecoderGeometry,
    ): DracoDecoderStatus;
    GetAttributeId(mesh: DracoDecoderGeometry, attributeType: number): number;
    GetAttribute(mesh: DracoDecoderGeometry, attributeId: number): object;
    GetAttributeFloatForAllPoints(
      mesh: DracoDecoderGeometry,
      attribute: object,
      output: DracoFloat32Array,
    ): void;
  };

  export type DracoDecoderModule = {
    Decoder: new () => DracoDecoder;
    DecoderBuffer: new () => DracoDecoderBuffer;
    DracoFloat32Array: new () => DracoFloat32Array;
    Mesh: new () => DracoDecoderGeometry;
    POSITION: number;
    destroy(value: object): void;
  };

  export function createDecoderModule(options?: {
    locateFile?: (path: string) => string;
  }): Promise<DracoDecoderModule>;
}

declare module "draco3d/draco_decoder.wasm" {
  const url: string;
  export default url;
}

declare module "draco3d/draco_encoder.wasm" {
  const url: string;
  export default url;
}
