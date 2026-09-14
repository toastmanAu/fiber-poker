import * as T from "three";

/** Decorative stack heights only. Exact committed amounts live in the DOM. */
export class ChipRenderer {
  private geometry = new T.CylinderGeometry(0.14, 0.14, 0.055, 24);
  private material: T.MeshStandardMaterial;
  constructor() {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 32;
    const x = c.getContext("2d")!;
    x.fillStyle = "#fff";
    x.fillRect(0, 0, 128, 32);
    x.fillStyle = "#394a48";
    for (let i = 0; i < 128; i += 16) x.fillRect(i, 0, 6, 32);
    const map = new T.CanvasTexture(c);
    map.colorSpace = T.SRGBColorSpace;
    this.material = new T.MeshStandardMaterial({
      map,
      roughness: 0.55,
      metalness: 0.12,
    });
  }
  create(): T.InstancedMesh {
    const m = new T.InstancedMesh(this.geometry, this.material, 24);
    m.count = 0;
    m.castShadow = true;
    m.frustumCulled = false;
    return m;
  }
  sync(mesh: T.InstancedMesh, amount: string): void {
    const n = BigInt(amount);
    mesh.count =
      n === 0n ? 0 : Math.min(24, Math.max(3, n.toString().length * 2));
    const dummy = new T.Object3D();
    const color = new T.Color();
    for (let i = 0; i < mesh.count; i++) {
      dummy.position.set(Math.floor(i / 8) * 0.31 - 0.15, (i % 8) * 0.058, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(
        i,
        color.set([0xb89357, 0x438d7f, 0xb4545f][Math.floor(i / 8)]!),
      );
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  dispose(): void {
    this.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}
