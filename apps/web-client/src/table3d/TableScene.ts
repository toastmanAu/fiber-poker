import * as T from "three";
import type { PublicTableState } from "@fiber-poker/protocol";
import { createTable } from "./TableGeometry.ts";
import { CardRenderer } from "./CardRenderer.ts";
import { ChipRenderer } from "./ChipRenderer.ts";
import { SeatRenderer } from "./SeatRenderer.ts";
import { Animations } from "./animations.ts";
import {
  cardLabel,
  displayedPot,
  formatCkb,
  payoutsCommitted,
  SEAT_POSITIONS,
  seatMapping,
} from "./stateAdapter.ts";

export interface HandResult {
  handId: string;
  showdowns: { playerId: string; cards: (number | string)[] }[];
}
export interface TurnData {
  deadlineUnixMs?: number;
}

/** No protocol IO, signing, settlement or poker rules: this is a disposable view. */
export class TableScene {
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera = new T.OrthographicCamera(-4, 4, 5, -5, 0.1, 60);
  private cards = new CardRenderer();
  private chips = new ChipRenderer();
  private animations = new Animations();
  private labels: SeatRenderer[];
  private board = Array.from({ length: 5 }, () => this.cards.create());
  private hands = Array.from({ length: 6 }, () => [
    this.cards.create(),
    this.cards.create(),
  ]);
  private bets = Array.from({ length: 6 }, () => this.chips.create());
  private stacks = Array.from({ length: 6 }, () => this.chips.create());
  private transfers = Array.from({ length: 6 }, () => this.chips.create());
  private pot = this.chips.create();
  private dealer = new T.Mesh(
    new T.CylinderGeometry(0.19, 0.19, 0.07, 32),
    new T.MeshStandardMaterial({ color: 0xf3e9c9, roughness: 0.4 }),
  );
  private halo = new T.Mesh(
    new T.RingGeometry(0.44, 0.47, 48),
    new T.MeshBasicMaterial({
      color: 0xa0dcb3,
      transparent: true,
      opacity: 0.6,
      side: T.DoubleSide,
    }),
  );
  private pulse = new T.Mesh(
    new T.SphereGeometry(0.065, 12, 8),
    new T.MeshBasicMaterial({ color: 0xa8f3d0 }),
  );
  private potLabel = document.createElement("div");
  private previous: PublicTableState | null = null;
  private localId = "";
  private result: HandResult | null = null;
  private pending = false;
  private turn: TurnData | null = null;
  private turnDuration = 1;
  private width = 1;
  private height = 1;
  private yaw = 0;
  private elevation = 0.94;
  private zoom = 1;
  private raf = 0;
  private lastTimerPaint = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private events = new AbortController();
  private pointers = new Map<number, { x: number; y: number }>();
  private lastTap = 0;
  private tapStart = { x: 0, y: 0, time: 0 };
  private projection = new T.Vector3();
  private source = new T.Vector3();
  private target = new T.Vector3();

  constructor(
    private host: HTMLElement,
    overlay: HTMLElement,
  ) {
    this.renderer = new T.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Three-dimensional poker table. Drag to look, pinch to zoom, double tap to reset.",
    );
    host.prepend(this.renderer.domElement);
    this.scene.add(createTable());
    this.scene.add(new T.HemisphereLight(0xc6e8ec, 0x142621, 2.4));
    const key = new T.DirectionalLight(0xffedce, 3.2);
    key.position.set(-3, 9, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, {
      left: -6,
      right: 6,
      top: 6,
      bottom: -6,
    });
    key.shadow.normalBias = 0.035;
    this.scene.add(key);
    const rim = new T.DirectionalLight(0x8dced1, 1.7);
    rim.position.set(4, 4, -5);
    this.scene.add(rim);
    this.labels = SEAT_POSITIONS.map((_, i) => new SeatRenderer(overlay, i));
    this.potLabel.className = "pot-label";
    overlay.append(this.potLabel);
    this.scene.add(
      ...this.board,
      ...this.hands.flat(),
      ...this.bets,
      ...this.stacks,
      ...this.transfers,
      this.pot,
      this.dealer,
      this.halo,
      this.pulse,
    );
    this.transfers.forEach((t) => (t.visible = false));
    this.dealer.visible = this.halo.visible = this.pulse.visible = false;
    this.pot.position.set(0, 0.25, 1.1);
    this.halo.rotation.x = -Math.PI / 2;
    const shoe = this.cards.create();
    shoe.visible = true;
    shoe.position.set(1.7, 0.23, -1.25);
    shoe.rotation.y = -0.2;
    this.scene.add(shoe);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) {
          cancelAnimationFrame(this.raf);
          this.animations.finish();
        } else this.frame(performance.now());
      },
      { signal: this.events.signal },
    );
    host.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault();
        host.dataset.renderError = "Graphics paused. Restoring…";
      },
      { capture: true, signal: this.events.signal },
    );
    host.addEventListener(
      "webglcontextrestored",
      () => {
        delete host.dataset.renderError;
        this.resize();
      },
      { capture: true, signal: this.events.signal },
    );
    this.wireCamera();
    this.resize();
    this.frame(performance.now());
  }

  syncState(
    state: PublicTableState,
    localPlayerId: string,
    holeCards: (number | string)[],
    animate = true,
  ): void {
    this.renderer.shadowMap.needsUpdate = true;
    const old = this.previous;
    const commitChanged =
      old?.sequence !== state.sequence || old?.handId !== state.handId;
    if (commitChanged) this.animations.finish();
    if (old?.handId !== state.handId) this.result = null;
    this.localId = localPlayerId;
    const mapping = seatMapping(state, localPlayerId);
    for (let slot = 0; slot < 6; slot++) {
      const mapped = mapping.find((m) => m.slot === slot);
      const seat = mapped?.seat;
      this.labels[slot]!.sync(seat, state, !!mapped?.local);
      const [x, z] = SEAT_POSITIONS[slot]!;
      const target = new T.Vector3(x * 0.68, 0.27, z * 0.68);
      const stackTarget = new T.Vector3(
        x * 0.88 + (slot === 0 || slot === 3 ? 0.8 : 0),
        0.25,
        z * 0.86,
      );
      this.stacks[slot]!.position.copy(stackTarget);
      this.chips.sync(this.stacks[slot]!, seat?.playerId ? seat.stack : "0");
      const bet = this.bets[slot]!;
      bet.position.copy(target);
      this.chips.sync(bet, seat?.playerId ? seat.streetContribution : "0");
      const before =
        old?.handId === state.handId
          ? old.seats.find((s) => s.seat === seat?.seat)
          : undefined;
      if (
        animate &&
        commitChanged &&
        before &&
        seat &&
        BigInt(seat.streetContribution) > BigInt(before.streetContribution)
      )
        this.animations.move(bet, stackTarget, target);
      if (
        animate &&
        commitChanged &&
        before &&
        seat &&
        BigInt(before.streetContribution) > 0n &&
        BigInt(seat.streetContribution) < BigInt(before.streetContribution)
      ) {
        const transfer = this.transfers[slot]!;
        this.chips.sync(transfer, before.streetContribution);
        transfer.visible = true;
        this.animations.move(
          transfer,
          target,
          this.pot.position.clone(),
          0,
          false,
          () => (transfer.visible = false),
        );
      }
      if (animate && commitChanged && seat?.allIn && !before?.allIn) {
        this.labels[slot]!.element.animate(
          [
            { boxShadow: "0 0 0px #e5bf78" },
            { boxShadow: "0 0 24px #e5bf78" },
            { boxShadow: "0 0 0px #e5bf78" },
          ],
          { duration: this.animations.reduced ? 0 : 900 },
        );
      }
      for (let i = 0; i < 2; i++) {
        const card = this.hands[slot]![i]!;
        const hasCards =
          !!seat?.playerId && !!seat.holeCardsHash && !seat.sittingOut;
        const face =
          mapped?.local && holeCards.length === 2
            ? cardLabel(holeCards[i]!)
            : "back";
        this.cards.set(card, face);
        const destination = new T.Vector3(
          x * 0.8 + (i - 0.5) * 0.46,
          0.25 + i * 0.008,
          z * 0.8 + (slot === 0 ? -0.6 : 0.1),
        );
        card.rotation.y = (i - 0.5) * -0.15;
        card.scale.setScalar(mapped?.local ? 1.15 : 0.8);
        if (commitChanged || !old) {
          card.visible = hasCards && !seat?.folded;
          card.position.copy(destination);
          if (hasCards && seat?.folded && !before?.folded && animate) {
            card.visible = true;
            this.animations.move(
              card,
              destination,
              new T.Vector3(-1.75, 0.23, -0.9),
              0,
              false,
              () => (card.visible = false),
            );
          } else if (
            hasCards &&
            !seat?.folded &&
            (!before?.holeCardsHash || old?.handId !== state.handId) &&
            animate
          ) {
            this.animations.move(
              card,
              new T.Vector3(1.7, 0.3, -1.25),
              destination,
              slot * 65 + i * 110,
              mapped?.local,
            );
          }
        }
      }
    }
    this.board.forEach((card, i) => {
      const value = state.board[i];
      if (value === undefined) {
        card.visible = false;
        return;
      }
      this.cards.set(card, cardLabel(value));
      card.visible = true;
      const dest = new T.Vector3((i - 2) * 0.72, 0.25, -0.15);
      if (commitChanged) {
        card.position.copy(dest);
        if (
          animate &&
          (old?.handId !== state.handId || old?.board[i] !== value)
        )
          this.animations.move(
            card,
            new T.Vector3(1.7, 0.4, -1.25),
            dest,
            Math.max(0, i - (old?.board.length ?? 0)) * 140,
            true,
          );
      }
    });
    this.chips.sync(
      this.pot,
      state.phase === "HAND_COMPLETE" ? "0" : displayedPot(state),
    );
    this.potLabel.textContent =
      state.phase === "HAND_COMPLETE"
        ? "HAND COMPLETE"
        : `${state.phase === "SETTLEMENT" ? "SETTLING" : "POT"} · ${formatCkb(displayedPot(state))} CKB${state.pots.length > 1 ? ` · ${state.pots.length} pots` : ""}`;
    this.potLabel.title = state.pots
      .map((p) => `Pot ${p.potId}: ${formatCkb(p.amount)} CKB`)
      .join("\n");
    const dealer = mapping.find((m) => m.seat.seat === state.buttonSeat);
    this.dealer.visible = !!dealer;
    if (dealer && commitChanged) {
      const [x, z] = SEAT_POSITIONS[dealer.slot]!;
      const to = new T.Vector3(x * 0.65 + 0.47, 0.25, z * 0.75);
      if (animate && old)
        this.animations.move(this.dealer, this.dealer.position.clone(), to);
      else this.dealer.position.copy(to);
    }
    const acting = mapping.find((m) => m.seat.seat === state.actingSeat);
    this.halo.visible = !!acting;
    if (acting) {
      const [x, z] = SEAT_POSITIONS[acting.slot]!;
      this.halo.position.set(x * 0.88, 0.23, z * 0.88);
    }
    if (animate && payoutsCommitted(old, state)) {
      for (const award of old!.awards) {
        const winner = mapping.find((m) => m.seat.playerId === award.playerId);
        if (!winner) continue;
        this.labels[winner.slot]!.award(award.amount);
        const transfer = this.transfers[winner.slot]!;
        transfer.visible = true;
        this.chips.sync(transfer, award.amount);
        this.animations.move(
          transfer,
          this.pot.position.clone(),
          this.stacks[winner.slot]!.position.clone(),
          0,
          false,
          () => (transfer.visible = false),
        );
      }
    }
    this.previous = state;
    if (this.result) this.showdown(this.result);
    this.projectLabels();
  }
  setTurn(turn: TurnData | null): void {
    if (turn?.deadlineUnixMs !== this.turn?.deadlineUnixMs)
      this.turnDuration = Math.max(
        1,
        (turn?.deadlineUnixMs ?? Date.now()) - Date.now(),
      );
    this.turn = turn;
  }
  setConnectionStatus(status: {
    wsConnected: boolean;
    channelReady: boolean;
  }): void {
    this.host.classList.toggle("disconnected", !status.wsConnected);
    this.host.dataset.channelReady = String(status.channelReady);
  }
  setPaymentPending(pending: boolean): void {
    this.pending = pending;
    this.pulse.visible = pending;
  }
  handleHandResult(result: HandResult): void {
    if (result.handId !== this.previous?.handId) return;
    this.result = result;
    this.showdown(result); // reveal only; awards never animate here
  }
  private showdown(result: HandResult): void {
    if (!this.previous) return;
    for (const reveal of result.showdowns) {
      const mapped = seatMapping(this.previous, this.localId).find(
        (m) => m.seat.playerId === reveal.playerId,
      );
      if (!mapped || mapped.seat.folded) continue;
      reveal.cards
        .slice(0, 2)
        .forEach((c, i) =>
          this.cards.set(this.hands[mapped.slot]![i]!, cardLabel(c)),
        );
    }
  }
  handleDeckReveal(handId: string): void {
    this.host.dataset.revealedHand = handId;
  }
  resetCamera(): void {
    this.yaw = 0;
    this.elevation = 0.94;
    this.zoom = 1;
    this.resize();
  }
  private resize(): void {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    const sizeChanged = this.width !== width || this.height !== height;
    this.width = width;
    this.height = height;
    // Orthographic projection keeps far-edge cards readable; fit both axes on rotation.
    const aspect = width / height;
    const viewHeight = Math.max(9.6, 7.7 / aspect) / this.zoom;
    this.camera.left = (-viewHeight * aspect) / 2;
    this.camera.right = (viewHeight * aspect) / 2;
    this.camera.top = viewHeight / 2;
    this.camera.bottom = -viewHeight / 2;
    this.camera.updateProjectionMatrix();
    if (sizeChanged) {
      this.renderer.setPixelRatio(
        Math.min(
          window.devicePixelRatio || 1,
          1.5,
          Math.sqrt(1_600_000 / (width * height)),
        ),
      );
      this.renderer.setSize(width, height, false);
    }
    this.updateCamera();
  }
  private updateCamera(): void {
    this.camera.position.set(
      Math.sin(this.yaw) * 15 * Math.cos(this.elevation),
      15 * Math.sin(this.elevation),
      Math.cos(this.yaw) * 15 * Math.cos(this.elevation),
    );
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.projectLabels();
  }
  private projectLabels(): void {
    this.labels.forEach((label, slot) => {
      const [x, z] = SEAT_POSITIONS[slot]!;
      this.projection
        .set(x, 0.55, slot === 0 ? z + 0.65 : z)
        .project(this.camera);
      label.position(
        Math.max(
          47,
          Math.min(this.width - 47, ((this.projection.x + 1) * this.width) / 2),
        ),
        ((1 - this.projection.y) * this.height) / 2,
      );
    });
    this.projection.set(0, 0.3, 0.67).project(this.camera);
    this.potLabel.style.left = `${((this.projection.x + 1) * this.width) / 2}px`;
    this.potLabel.style.top = `${((1 - this.projection.y) * this.height) / 2}px`;
  }
  private wireCamera(): void {
    const canvas = this.renderer.domElement;
    const options = { signal: this.events.signal };
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.tapStart = { x: e.clientX, y: e.clientY, time: performance.now() };
      },
      options,
    );
    canvas.addEventListener(
      "pointermove",
      (e) => {
        const prev = this.pointers.get(e.pointerId);
        if (!prev) return;
        const other = [...this.pointers.entries()].find(
          ([id]) => id !== e.pointerId,
        )?.[1];
        if (other) {
          const oldDistance = Math.hypot(prev.x - other.x, prev.y - other.y);
          const newDistance = Math.hypot(
            e.clientX - other.x,
            e.clientY - other.y,
          );
          if (oldDistance > 5)
            this.zoom = T.MathUtils.clamp(
              (this.zoom * newDistance) / oldDistance,
              0.92,
              1.06,
            );
        } else {
          this.yaw = T.MathUtils.clamp(
            this.yaw - (e.clientX - prev.x) * 0.0018,
            -0.12,
            0.12,
          );
          this.elevation = T.MathUtils.clamp(
            this.elevation + (e.clientY - prev.y) * 0.001,
            0.88,
            1.04,
          );
        }
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.resize();
      },
      options,
    );
    const release = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (
        e.type === "pointerup" &&
        performance.now() - this.tapStart.time < 250 &&
        Math.hypot(e.clientX - this.tapStart.x, e.clientY - this.tapStart.y) < 8
      ) {
        if (performance.now() - this.lastTap < 320) this.resetCamera();
        this.lastTap = performance.now();
      }
    };
    canvas.addEventListener("pointerup", release, options);
    canvas.addEventListener("pointercancel", release, options);
  }
  private frame = (now: number): void => {
    if (this.disposed || document.hidden) return;
    if (this.animations.active) this.renderer.shadowMap.needsUpdate = true;
    this.animations.tick(now);
    (this.halo.material as T.MeshBasicMaterial).opacity = this.animations
      .reduced
      ? 0.6
      : 0.5 + Math.sin(now / 700) * 0.13;
    if (this.pending && this.previous) {
      const local = seatMapping(this.previous, this.localId).find(
        (m) => m.local,
      );
      this.pulse.visible = !!local;
      if (local) {
        const [x, z] = SEAT_POSITIONS[local.slot]!;
        this.source.set(x * 0.8, 0.45, z * 0.8);
        this.target.set(0, 0.4, 1.1);
        this.pulse.position.lerpVectors(
          this.source,
          this.target,
          this.animations.reduced ? 0.5 : (now % 1500) / 1500,
        );
      }
    }
    if (now - this.lastTimerPaint > 200) {
      this.lastTimerPaint = now;
      const left = Math.max(0, (this.turn?.deadlineUnixMs ?? 0) - Date.now());
      const local = this.previous
        ? seatMapping(this.previous, this.localId).find((m) => m.local)
        : undefined;
      this.labels.forEach((label, slot) =>
        label.timer(
          this.turn?.deadlineUnixMs && local?.slot === slot
            ? Math.ceil(left / 1000)
            : null,
          Math.min(1, left / this.turnDuration),
        ),
      );
    }
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.frame);
  };
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.animations.finish();
    this.resizeObserver.disconnect();
    this.events.abort();
    this.labels.forEach((l) => l.dispose());
    this.potLabel.remove();
    const geometries = new Set<T.BufferGeometry>();
    const materials = new Set<T.Material>();
    const textures = new Set<T.Texture>();
    this.scene.traverse((o) => {
      if (o instanceof T.Mesh) {
        geometries.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          materials.add(m);
      }
      if (o instanceof T.InstancedMesh) o.dispose();
    });
    materials.forEach((m) => {
      Object.values(m).forEach((v) => {
        if (v instanceof T.Texture) textures.add(v);
      });
      m.dispose();
    });
    geometries.forEach((g) => g.dispose());
    textures.forEach((t) => t.dispose());
    this.cards.dispose();
    this.chips.dispose();
    this.scene.traverse((o) => {
      if (o instanceof T.DirectionalLight) o.shadow.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
