/** Acceleration estimated from consecutive OBD speed readings, in m/s². */
export class TripMotion {
  private points: { t: number; speed: number }[] = [];
  acceleration: number | null = null;

  update(t: number, speed: number | null): void {
    const previous = this.points[this.points.length - 1];
    if (!Number.isFinite(t) || speed == null || !Number.isFinite(speed) || speed < 0) {
      this.points = [];
      this.acceleration = null;
      return;
    }
    if (previous && (t <= previous.t || t - previous.t > 15)) this.points = [];
    this.points.push({ t, speed });
    // About four seconds smooth out the speed PID's 1 km/h rounding. Keep a
    // preceding anchor for adapters whose complete sensor cycle is slower.
    while (this.points.length > 2 && this.points[1].t <= t - 4) this.points.shift();
    const anchor = this.points[0];
    const seconds = t - anchor.t;
    this.acceleration = seconds >= 2 && seconds <= 15 ? (speed - anchor.speed) / 3.6 / seconds : null;
  }
}
