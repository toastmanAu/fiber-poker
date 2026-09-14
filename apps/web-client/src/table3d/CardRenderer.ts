import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export class CardRenderer {
  private body = new RoundedBoxGeometry(0.63, 0.038, 0.9, 2, 0.035);
  private face = new T.PlaneGeometry(0.59, 0.86);
  private edge = new T.MeshStandardMaterial({
    color: 0xe8e4d8,
    roughness: 0.6,
  });
  private materials = new Map<string, T.MeshBasicMaterial>();
  material(value: string): T.MeshBasicMaterial {
    const cached = this.materials.get(value);
    if (cached) return cached;
    const c = document.createElement("canvas");
    c.width = 192;
    c.height = 280;
    const x = c.getContext("2d")!;
    x.fillStyle = value === "back" ? "#183b40" : "#fffaf0";
    x.fillRect(0, 0, 192, 280);
    if (value === "back") {
      x.strokeStyle = "#518879";
      x.lineWidth = 2;
      for (let y = -40; y < 340; y += 28)
        for (let a = -30; a < 230; a += 28) {
          x.beginPath();
          x.moveTo(a, y - 14);
          x.lineTo(a + 14, y);
          x.lineTo(a, y + 14);
          x.lineTo(a - 14, y);
          x.closePath();
          x.stroke();
        }
      x.fillStyle = "#183b40";
      x.fillRect(55, 104, 82, 72);
      x.fillStyle = "#b9d8ad";
      x.font = "bold 44px sans-serif";
      x.textAlign = "center";
      x.fillText("F", 96, 157);
      x.strokeStyle = "#c0c7a3";
      x.strokeRect(9, 9, 174, 262);
    } else {
      const suit =
        ({ c: "♣", d: "♦", h: "♥", s: "♠" } as Record<string, string>)[
          value[1]!
        ] ?? "";
      const rank = value[0] === "T" ? "10" : value[0]!;
      x.fillStyle = /[hd]$/.test(value) ? "#ae3442" : "#192c38";
      x.font = "bold 49px Georgia";
      x.fillText(rank, 14, 52);
      x.font = "37px Georgia";
      x.fillText(suit, 17, 91);
      x.textAlign = "center";
      x.font = "bold 86px Georgia";
      x.fillText(rank, 100, 162);
      x.font = "62px Georgia";
      x.fillText(suit, 100, 228);
      x.save();
      x.translate(192, 280);
      x.rotate(Math.PI);
      x.textAlign = "left";
      x.font = "bold 40px Georgia";
      x.fillText(rank, 14, 47);
      x.restore();
    }
    const texture = new T.CanvasTexture(c);
    texture.colorSpace = T.SRGBColorSpace;
    const mat = new T.MeshBasicMaterial({ map: texture });
    this.materials.set(value, mat);
    return mat;
  }
  create(): T.Group {
    const group = new T.Group();
    const body = new T.Mesh(this.body, this.edge);
    body.castShadow = true;
    group.add(body);
    const top = new T.Mesh(this.face, this.material("back"));
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.021;
    group.add(top);
    const back = new T.Mesh(this.face, this.material("back"));
    back.rotation.x = Math.PI / 2;
    back.position.y = -0.021;
    group.add(back);
    group.visible = false;
    return group;
  }
  set(card: T.Group, label: string): void {
    (card.children[1] as T.Mesh).material = this.material(label);
  }
  dispose(): void {
    this.body.dispose();
    this.face.dispose();
    this.edge.dispose();
    for (const m of this.materials.values()) {
      m.map?.dispose();
      m.dispose();
    }
  }
}
