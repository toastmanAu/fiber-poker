import { Object3D, Vector3 } from "three";

/** Bounded cosmetic timeline. A newer commit finishes every old transition first. */
export class Animations {
  private jobs: {
    start: number;
    duration: number;
    update: (t: number) => void;
  }[] = [];
  get active(): boolean {
    return this.jobs.length > 0;
  }
  reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  add(update: (t: number) => void, duration = 550, delay = 0): void {
    if (this.reduced) {
      update(1);
      return;
    }
    update(0);
    this.jobs.push({ start: performance.now() + delay, duration, update });
  }
  move(
    object: Object3D,
    from: Vector3,
    to: Vector3,
    delay = 0,
    flip = false,
    done?: () => void,
  ): void {
    this.add(
      (t) => {
        const eased = 1 - Math.pow(1 - t, 3);
        object.position.lerpVectors(from, to, eased);
        object.position.y += Math.sin(t * Math.PI) * 0.45;
        if (flip) object.rotation.z = (1 - eased) * Math.PI;
        if (t === 1) done?.();
      },
      600,
      delay,
    );
  }
  tick(now: number): void {
    this.jobs = this.jobs.filter((job) => {
      const t = Math.max(0, Math.min(1, (now - job.start) / job.duration));
      job.update(t);
      return t < 1;
    });
  }
  finish(): void {
    for (const job of this.jobs) job.update(1);
    this.jobs = [];
  }
}
