import * as T from "three";

function oval(
  radiusX: number,
  radiusZ: number,
  y: number,
  thickness: number,
  color: number,
  roughness: number,
) {
  const mesh = new T.Mesh(
    new T.CylinderGeometry(1, 1, thickness, 96),
    new T.MeshStandardMaterial({ color, roughness, metalness: 0.12 }),
  );
  mesh.scale.set(radiusX, 1, radiusZ);
  mesh.position.y = y;
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}
export function createTable(): T.Group {
  const group = new T.Group();
  group.add(oval(2.95, 4.65, -0.26, 0.48, 0x171d25, 0.42));
  group.add(oval(2.98, 4.68, -0.09, 0.06, 0x9a8052, 0.32));
  group.add(oval(2.85, 4.55, 0.03, 0.23, 0x18262a, 0.8));
  const felt = oval(2.59, 4.24, 0.13, 0.08, 0x124d43, 0.98);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#a0a0a0";
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 128; i += 2) {
    ctx.fillStyle = i % 4 ? "#aaa" : "#999";
    ctx.fillRect(i, 0, 1, 128);
    ctx.fillRect(0, i, 128, 1);
  }
  const texture = new T.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  texture.repeat.set(12, 18);
  (felt.material as T.MeshStandardMaterial).bumpMap = texture;
  (felt.material as T.MeshStandardMaterial).bumpScale = 0.035;
  group.add(felt);
  // Padded continuous elliptical rail, with thin restrained brass piping.
  for (const [r, y, color] of [
    [0.19, 0.18, 0x263332],
    [0.018, 0.29, 0xb69c65],
  ] as const) {
    const rail = new T.Mesh(
      new T.TorusGeometry(1, r, 10, 96),
      new T.MeshStandardMaterial({
        color,
        roughness: 0.6,
        metalness: r < 0.1 ? 0.6 : 0.05,
      }),
    );
    rail.rotation.x = -Math.PI / 2;
    rail.scale.set(2.65, 4.28, 1);
    rail.position.y = y;
    rail.receiveShadow = true;
    group.add(rail);
  }
  const logoCanvas = document.createElement("canvas");
  logoCanvas.width = 512;
  logoCanvas.height = 128;
  const l = logoCanvas.getContext("2d")!;
  l.textAlign = "center";
  l.fillStyle = "#55917f";
  l.font = "500 38px sans-serif";
  l.fillText("F I B E R   P O K E R", 256, 60);
  l.font = "18px sans-serif";
  l.fillText("A U T H O R I T A T I V E  ·  A U D I T A B L E", 256, 100);
  const logo = new T.Mesh(
    new T.PlaneGeometry(2.8, 0.7),
    new T.MeshBasicMaterial({
      map: new T.CanvasTexture(logoCanvas),
      transparent: true,
      depthWrite: false,
    }),
  );
  logo.rotation.x = -Math.PI / 2;
  logo.position.set(0, 0.19, -1.7);
  group.add(logo);
  const ground = new T.Mesh(
    new T.PlaneGeometry(200, 200),
    new T.MeshStandardMaterial({ color: 0x080f16, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.8;
  ground.receiveShadow = true;
  group.add(ground);
  return group;
}
