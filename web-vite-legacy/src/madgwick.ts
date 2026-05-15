/**
 * Madgwick AHRS (MARG + IMU fallback). Gyro rad/s, accel g, mag arbitrary normalized.
 * Based on S. Madgwick, "An efficient orientation filter for inertial and
 * inertial/magnetic sensor arrays", 2010.
 */
export class Madgwick {
  beta = 0.12;
  readonly q = { w: 1, x: 0, y: 0, z: 0 };

  updateIMU(gx: number, gy: number, gz: number, ax: number, ay: number, az: number, dt: number): void {
    let { w: q0, x: q1, y: q2, z: q3 } = this.q;
    const beta = this.beta;

    let qDot0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let qDot1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let qDot2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let qDot3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);

    let n = Math.hypot(ax, ay, az);
    if (n >= 1e-8) {
      ax /= n;
      ay /= n;
      az /= n;

      const _2q0 = 2 * q0;
      const _2q1 = 2 * q1;
      const _2q2 = 2 * q2;
      const _2q3 = 2 * q3;
      const _4q0 = 4 * q0;
      const _4q1 = 4 * q1;
      const _4q2 = 4 * q2;
      const _8q1 = 8 * q1;
      const _8q2 = 8 * q2;
      const q0q0 = q0 * q0;
      const q1q1 = q1 * q1;
      const q2q2 = q2 * q2;
      const q3q3 = q3 * q3;

      // x-io / Stoffregen Madgwick IMU gradient (same as C reference)
      let s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
      let s1 = _4q1 * q3q3 - _2q3 * ax + 4 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
      let s2 = 4 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
      let s3 = 4 * q1q1 * q3 - _2q1 * ax + 4 * q2q2 * q3 - _2q2 * ay;
      n = Math.hypot(s0, s1, s2, s3);
      if (n >= 1e-8) {
        s0 /= n;
        s1 /= n;
        s2 /= n;
        s3 /= n;
        qDot0 -= beta * s0;
        qDot1 -= beta * s1;
        qDot2 -= beta * s2;
        qDot3 -= beta * s3;
      }
    }

    q0 += qDot0 * dt;
    q1 += qDot1 * dt;
    q2 += qDot2 * dt;
    q3 += qDot3 * dt;
    n = Math.hypot(q0, q1, q2, q3);
    this.q.w = q0 / n;
    this.q.x = q1 / n;
    this.q.y = q2 / n;
    this.q.z = q3 / n;
  }

  updateMARG(
    gx: number,
    gy: number,
    gz: number,
    ax: number,
    ay: number,
    az: number,
    mx: number,
    my: number,
    mz: number,
    dt: number,
  ): void {
    let { w: q0, x: q1, y: q2, z: q3 } = this.q;
    const beta = this.beta;

    let qDot0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let qDot1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let qDot2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let qDot3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);

    let n = Math.hypot(ax, ay, az);
    if (n < 1e-8) {
      q0 += qDot0 * dt;
      q1 += qDot1 * dt;
      q2 += qDot2 * dt;
      q3 += qDot3 * dt;
      n = Math.hypot(q0, q1, q2, q3);
      this.q.w = q0 / n;
      this.q.x = q1 / n;
      this.q.y = q2 / n;
      this.q.z = q3 / n;
      return;
    }
    ax /= n;
    ay /= n;
    az /= n;

    n = Math.hypot(mx, my, mz);
    if (n < 1e-8) {
      this.updateIMU(gx, gy, gz, ax, ay, az, dt);
      return;
    }
    mx /= n;
    my /= n;
    mz /= n;

    const _2q0mx = 2 * q0 * mx;
    const _2q0my = 2 * q0 * my;
    const _2q0mz = 2 * q0 * mz;
    const _2q1mx = 2 * q1 * mx;
    const _2q0 = 2 * q0;
    const _2q1 = 2 * q1;
    const _2q2 = 2 * q2;
    const _2q3 = 2 * q3;
    const _2q0q2 = 2 * q0 * q2;
    const _2q2q3 = 2 * q2 * q3;
    const q0q0 = q0 * q0;
    const q0q1 = q0 * q1;
    const q0q2 = q0 * q2;
    const q0q3 = q0 * q3;
    const q1q1 = q1 * q1;
    const q1q2 = q1 * q2;
    const q1q3 = q1 * q3;
    const q2q2 = q2 * q2;
    const q2q3 = q2 * q3;
    const q3q3 = q3 * q3;

    const hx = mx * q0q0 - _2q0my * q3 + _2q0mz * q2 + mx * q1q1 + _2q1 * my * q2 + _2q1 * mz * q3 - mx * q2q2 - mx * q3q3;
    const hy = _2q0mx * q3 + my * q0q0 - _2q0mz * q1 + _2q1mx * q2 - my * q1q1 + my * q2q2 + _2q2 * mz * q3 - my * q3q3;
    const _2bx = Math.hypot(hx, hy);
    const _2bz = -_2q0mx * q2 + _2q0my * q1 + mz * q0q0 + _2q1mx * q3 - mz * q1q1 + _2q2 * my * q3 - mz * q2q2 + mz * q3q3;
    const _4bx = 2 * _2bx;
    const _4bz = 2 * _2bz;

    let s0 = -_2q2 * (2 * q1q3 - _2q0q2 - ax) + _2q1 * (2 * q0q1 + _2q2q3 - ay) - _2bz * q2 * (_2bx * (0.5 - q2q2 - q3q3) + _2bz * (q1q3 - q0q2) - mx) + (-_2bx * q3 + _2bz * q1) * (_2bx * (q1q2 - q0q3) + _2bz * (q0q1 + q2q3) - my) + _2bx * q2 * (_2bx * (q0q2 + q1q3) + _2bz * (0.5 - q1q1 - q2q2) - mz);
    let s1 = _2q3 * (2 * q1q3 - _2q0q2 - ax) + _2q0 * (2 * q0q1 + _2q2q3 - ay) - 4 * q1 * (1 - 2 * q1q1 - 2 * q2q2 - az) + _2bz * q3 * (_2bx * (0.5 - q2q2 - q3q3) + _2bz * (q1q3 - q0q2) - mx) + (_2bx * q2 + _2bz * q0) * (_2bx * (q1q2 - q0q3) + _2bz * (q0q1 + q2q3) - my) + (_2bx * q3 - _4bz * q1) * (_2bx * (q0q2 + q1q3) + _2bz * (0.5 - q1q1 - q2q2) - mz);
    let s2 = -_2q0 * (2 * q1q3 - _2q0q2 - ax) + _2q3 * (2 * q0q1 + _2q2q3 - ay) - 4 * q2 * (1 - 2 * q1q1 - 2 * q2q2 - az) + (-_4bx * q2 - _2bz * q0) * (_2bx * (0.5 - q2q2 - q3q3) + _2bz * (q1q3 - q0q2) - mx) + (_2bx * q1 + _2bz * q3) * (_2bx * (q1q2 - q0q3) + _2bz * (q0q1 + q2q3) - my) + (_2bx * q0 - _4bz * q2) * (_2bx * (q0q2 + q1q3) + _2bz * (0.5 - q1q1 - q2q2) - mz);
    let s3 = _2q1 * (2 * q1q3 - _2q0q2 - ax) + _2q2 * (2 * q0q1 + _2q2q3 - ay) + (-_4bx * q3 + _2bz * q1) * (_2bx * (0.5 - q2q2 - q3q3) + _2bz * (q1q3 - q0q2) - mx) + (-_2bx * q0 + _2bz * q2) * (_2bx * (q1q2 - q0q3) + _2bz * (q0q1 + q2q3) - my) + _2bx * q1 * (_2bx * (q0q2 + q1q3) + _2bz * (0.5 - q1q1 - q2q2) - mz);

    n = Math.hypot(s0, s1, s2, s3);
    if (n >= 1e-8) {
      s0 /= n;
      s1 /= n;
      s2 /= n;
      s3 /= n;
      qDot0 -= beta * s0;
      qDot1 -= beta * s1;
      qDot2 -= beta * s2;
      qDot3 -= beta * s3;
    }

    q0 += qDot0 * dt;
    q1 += qDot1 * dt;
    q2 += qDot2 * dt;
    q3 += qDot3 * dt;
    n = Math.hypot(q0, q1, q2, q3);
    this.q.w = q0 / n;
    this.q.x = q1 / n;
    this.q.y = q2 / n;
    this.q.z = q3 / n;
  }
}
