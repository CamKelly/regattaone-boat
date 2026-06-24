#!/usr/bin/env python3

import math
import numpy as np
import matplotlib.pyplot as plt


# ============================================================
# Editable simulation inputs
# ============================================================

DT = 0.25
STEPS = 80

# True geometry
TRUE_PORT = np.array([0.0, 0.0])
TRUE_STARBOARD = np.array([100.0, 0.0])
TRUE_BOAT_INITIAL = np.array([45.0, -35.0])

# Boat motion
BOAT_SPEED_MPS = 3.2
BOAT_COURSE_DEG = 65.0     # 0 = +x, 90 = +y

# Measurement noise / error
SIGMA_PORT_TO_STARBOARD = 0.15
SIGMA_STARBOARD_TO_PORT = 0.15
SIGMA_PORT_TO_BOAT = 0.25
SIGMA_STARBOARD_TO_BOAT = 0.25

# Optional fixed biases, in metres
BIAS_PORT_TO_STARBOARD = 0.20
BIAS_STARBOARD_TO_PORT = -0.10
BIAS_PORT_TO_BOAT = 0.15
BIAS_STARBOARD_TO_BOAT = -0.20

# Delay in UWB measurements, in seconds
UWB_DELAY_SECONDS = 0.75

# Random seed for repeatable results
RANDOM_SEED = 7


# ============================================================
# Utility functions
# ============================================================

def norm(v):
    return float(np.linalg.norm(v))


def heading_to_velocity(speed_mps, course_deg):
    rad = math.radians(course_deg)
    return np.array([
        speed_mps * math.cos(rad),
        speed_mps * math.sin(rad)
    ])


def measured_range(a, b, sigma, bias=0.0):
    return norm(b - a) + bias + np.random.normal(0.0, sigma)


# ============================================================
# Algorithm 1: Weighted Least Squares
# ============================================================

def weighted_least_squares(meas, initial=None, max_iter=30, damping=1e-6):
    """
    Solves:

        Port      = (0, 0)
        Starboard = (L, 0)
        Boat      = (x, y)

    Unknowns:

        L, x, y

    Measurements:

        ps = port -> starboard range
        sp = starboard -> port range
        pb = port -> boat range
        sb = starboard -> boat range
    """

    if initial is None:
        L = (meas["ps"][0] + meas["sp"][0]) / 2.0
        x = L / 2.0
        y = -20.0
    else:
        L, x, y = initial

    for _ in range(max_iter):
        rows = []
        rhs = []

        def add_residual(predicted, observed, sigma, jac):
            residual = predicted - observed
            w = 1.0 / max(sigma * sigma, 1e-12)
            sw = math.sqrt(w)
            rows.append(sw * np.array(jac))
            rhs.append(-sw * residual)

        ps, ps_sigma = meas["ps"]
        sp, sp_sigma = meas["sp"]
        pb, pb_sigma = meas["pb"]
        sb, sb_sigma = meas["sb"]

        add_residual(L, ps, ps_sigma, [1.0, 0.0, 0.0])
        add_residual(L, sp, sp_sigma, [1.0, 0.0, 0.0])

        d_pb = max(math.hypot(x, y), 1e-9)
        add_residual(d_pb, pb, pb_sigma, [0.0, x / d_pb, y / d_pb])

        dx = x - L
        dy = y
        d_sb = max(math.hypot(dx, dy), 1e-9)
        add_residual(d_sb, sb, sb_sigma, [-dx / d_sb, dx / d_sb, dy / d_sb])

        A = np.vstack(rows)
        b = np.array(rhs)

        normal_A = A.T @ A + damping * np.eye(3)
        normal_b = A.T @ b

        delta = np.linalg.solve(normal_A, normal_b)

        L += delta[0]
        x += delta[1]
        y += delta[2]

        L = max(L, 0.01)

        if np.linalg.norm(delta) < 1e-8:
            break

    return np.array([L, x, y])


# ============================================================
# Algorithm 2: EKF
# ============================================================

class StartLineEKF:
    """
    State:

        x[0] = port x
        x[1] = port y
        x[2] = starboard x
        x[3] = starboard y
        x[4] = boat x
        x[5] = boat y
        x[6] = boat vx
        x[7] = boat vy
    """

    def __init__(self, port, starboard, boat, velocity):
        self.x = np.array([
            port[0], port[1],
            starboard[0], starboard[1],
            boat[0], boat[1],
            velocity[0], velocity[1]
        ], dtype=float)

        self.P = np.diag([
            1.0, 1.0,
            1.0, 1.0,
            9.0, 9.0,
            1.0, 1.0
        ])

    def predict(self, dt, accel_sigma=0.6, mark_drift_sigma=0.02):
        F = np.eye(8)
        F[4, 6] = dt
        F[5, 7] = dt

        self.x = F @ self.x

        q_pos = 0.25 * dt**4 * accel_sigma**2
        q_vel = dt**2 * accel_sigma**2
        q_cross = 0.5 * dt**3 * accel_sigma**2

        Q = np.zeros((8, 8))

        Q[0, 0] = mark_drift_sigma**2 * dt
        Q[1, 1] = mark_drift_sigma**2 * dt
        Q[2, 2] = mark_drift_sigma**2 * dt
        Q[3, 3] = mark_drift_sigma**2 * dt

        Q[4, 4] = q_pos
        Q[5, 5] = q_pos
        Q[6, 6] = q_vel
        Q[7, 7] = q_vel

        Q[4, 6] = q_cross
        Q[6, 4] = q_cross
        Q[5, 7] = q_cross
        Q[7, 5] = q_cross

        self.P = F @ self.P @ F.T + Q

    def update_velocity(self, velocity, sigma=0.35):
        self._update_linear(np.array([0, 0, 0, 0, 0, 0, 1, 0]), velocity[0], sigma**2)
        self._update_linear(np.array([0, 0, 0, 0, 0, 0, 0, 1]), velocity[1], sigma**2)

    def update_range(self, ia, ib, measured, sigma):
        ax = self.x[ia]
        ay = self.x[ia + 1]
        bx = self.x[ib]
        by = self.x[ib + 1]

        dx = bx - ax
        dy = by - ay
        predicted = max(math.hypot(dx, dy), 1e-9)

        H = np.zeros(8)
        H[ia] = -dx / predicted
        H[ia + 1] = -dy / predicted
        H[ib] = dx / predicted
        H[ib + 1] = dy / predicted

        self._update_nonlinear(H, measured, predicted, sigma**2)

    def _update_linear(self, H, z, R):
        predicted = H @ self.x
        self._update_nonlinear(H, z, predicted, R)

    def _update_nonlinear(self, H, z, predicted, R):
        innovation = z - predicted
        S = H @ self.P @ H.T + R

        if S <= 0:
            return

        K = self.P @ H.T / S

        self.x = self.x + K * innovation

        I = np.eye(8)
        KH = np.outer(K, H)

        # Joseph form, more numerically stable
        self.P = (I - KH) @ self.P @ (I - KH).T + R * np.outer(K, K)

    def estimate(self):
        port = self.x[0:2]
        starboard = self.x[2:4]
        boat = self.x[4:6]
        velocity = self.x[6:8]

        line = starboard - port
        line_len = norm(line)

        signed_distance = np.cross(line, boat - port) / max(line_len, 1e-9)

        return {
            "port": port,
            "starboard": starboard,
            "boat": boat,
            "velocity": velocity,
            "line_length": line_len,
            "signed_distance_to_line": signed_distance
        }


# ============================================================
# Simulation
# ============================================================

def main():
    np.random.seed(RANDOM_SEED)

    true_velocity = heading_to_velocity(BOAT_SPEED_MPS, BOAT_COURSE_DEG)

    true_boats = []
    ls_boats = []
    ekf_boats = []

    line_lengths_true = []
    line_lengths_ls = []
    line_lengths_ekf = []

    distance_to_line_true = []
    distance_to_line_ls = []
    distance_to_line_ekf = []

    times = []

    true_boat = TRUE_BOAT_INITIAL.copy()

    initial_meas = {
        "ps": (measured_range(TRUE_PORT, TRUE_STARBOARD, SIGMA_PORT_TO_STARBOARD, BIAS_PORT_TO_STARBOARD), SIGMA_PORT_TO_STARBOARD),
        "sp": (measured_range(TRUE_STARBOARD, TRUE_PORT, SIGMA_STARBOARD_TO_PORT, BIAS_STARBOARD_TO_PORT), SIGMA_STARBOARD_TO_PORT),
        "pb": (measured_range(TRUE_PORT, true_boat, SIGMA_PORT_TO_BOAT, BIAS_PORT_TO_BOAT), SIGMA_PORT_TO_BOAT),
        "sb": (measured_range(TRUE_STARBOARD, true_boat, SIGMA_STARBOARD_TO_BOAT, BIAS_STARBOARD_TO_BOAT), SIGMA_STARBOARD_TO_BOAT),
    }

    ls_state = weighted_least_squares(initial_meas)
    initial_L, initial_x, initial_y = ls_state

    ekf = StartLineEKF(
        port=np.array([0.0, 0.0]),
        starboard=np.array([initial_L, 0.0]),
        boat=np.array([initial_x, initial_y]),
        velocity=true_velocity
    )

    measurement_delay_steps = int(round(UWB_DELAY_SECONDS / DT))
    true_history = []

    last_ls_state = ls_state.copy()

    for k in range(STEPS):
        t = k * DT
        times.append(t)

        true_boat = TRUE_BOAT_INITIAL + true_velocity * t
        true_history.append(true_boat.copy())

        delayed_index = max(0, k - measurement_delay_steps)
        delayed_boat = true_history[delayed_index]

        meas = {
            "ps": (
                measured_range(TRUE_PORT, TRUE_STARBOARD, SIGMA_PORT_TO_STARBOARD, BIAS_PORT_TO_STARBOARD),
                SIGMA_PORT_TO_STARBOARD
            ),
            "sp": (
                measured_range(TRUE_STARBOARD, TRUE_PORT, SIGMA_STARBOARD_TO_PORT, BIAS_STARBOARD_TO_PORT),
                SIGMA_STARBOARD_TO_PORT
            ),
            "pb": (
                measured_range(TRUE_PORT, delayed_boat, SIGMA_PORT_TO_BOAT, BIAS_PORT_TO_BOAT),
                SIGMA_PORT_TO_BOAT
            ),
            "sb": (
                measured_range(TRUE_STARBOARD, delayed_boat, SIGMA_STARBOARD_TO_BOAT, BIAS_STARBOARD_TO_BOAT),
                SIGMA_STARBOARD_TO_BOAT
            ),
        }

        # Weighted least squares estimates the delayed geometry.
        last_ls_state = weighted_least_squares(meas, initial=last_ls_state)
        L_ls, x_ls_delayed, y_ls_delayed = last_ls_state

        # Compensate delayed least-squares boat position forward using speed/course.
        delay_comp = true_velocity * UWB_DELAY_SECONDS
        boat_ls_now = np.array([x_ls_delayed, y_ls_delayed]) + delay_comp

        # EKF predicts to now, then updates using delayed UWB as though received now.
        # This intentionally demonstrates the effect of delay.
        # A production filter would either:
        # 1. rewind/update/replay, or
        # 2. forward-project delayed measurements before update.
        ekf.predict(DT)
        ekf.update_velocity(true_velocity)

        ekf.update_range(0, 2, meas["ps"][0], meas["ps"][1])
        ekf.update_range(2, 0, meas["sp"][0], meas["sp"][1])
        ekf.update_range(0, 4, meas["pb"][0], meas["pb"][1])
        ekf.update_range(2, 4, meas["sb"][0], meas["sb"][1])

        est = ekf.estimate()

        true_boats.append(true_boat.copy())
        ls_boats.append(boat_ls_now.copy())
        ekf_boats.append(est["boat"].copy())

        true_line_len = norm(TRUE_STARBOARD - TRUE_PORT)
        line_lengths_true.append(true_line_len)
        line_lengths_ls.append(L_ls)
        line_lengths_ekf.append(est["line_length"])

        distance_to_line_true.append(true_boat[1])
        distance_to_line_ls.append(boat_ls_now[1])
        distance_to_line_ekf.append(est["signed_distance_to_line"])

    true_boats = np.array(true_boats)
    ls_boats = np.array(ls_boats)
    ekf_boats = np.array(ekf_boats)

    print()
    print("Final true boat position:       ", true_boats[-1])
    print("Final least-squares position:   ", ls_boats[-1])
    print("Final EKF position:             ", ekf_boats[-1])
    print()
    print("Final true start-line length:   ", line_lengths_true[-1])
    print("Final least-squares line length:", line_lengths_ls[-1])
    print("Final EKF line length:          ", line_lengths_ekf[-1])
    print()

    plot_geometry(true_boats, ls_boats, ekf_boats)
    plot_line_length(times, line_lengths_true, line_lengths_ls, line_lengths_ekf)
    plot_distance_to_line(times, distance_to_line_true, distance_to_line_ls, distance_to_line_ekf)

    plt.show()


# ============================================================
# Plotting
# ============================================================

def plot_geometry(true_boats, ls_boats, ekf_boats):
    plt.figure(figsize=(10, 7))

    plt.plot([TRUE_PORT[0], TRUE_STARBOARD[0]], [TRUE_PORT[1], TRUE_STARBOARD[1]], "k-", label="True start line")
    plt.scatter([TRUE_PORT[0]], [TRUE_PORT[1]], marker="o", s=80, label="Port mark")
    plt.scatter([TRUE_STARBOARD[0]], [TRUE_STARBOARD[1]], marker="o", s=80, label="Starboard mark")

    plt.plot(true_boats[:, 0], true_boats[:, 1], label="True boat path")
    plt.plot(ls_boats[:, 0], ls_boats[:, 1], label="Weighted least-squares estimate")
    plt.plot(ekf_boats[:, 0], ekf_boats[:, 1], label="EKF estimate")

    plt.axhline(0, linestyle="--", linewidth=1)
    plt.axis("equal")
    plt.grid(True)
    plt.xlabel("x position, metres")
    plt.ylabel("y position, metres")
    plt.title("Boat Position Estimate")
    plt.legend()


def plot_line_length(times, true_len, ls_len, ekf_len):
    plt.figure(figsize=(10, 5))

    plt.plot(times, true_len, label="True start-line length")
    plt.plot(times, ls_len, label="Weighted least-squares")
    plt.plot(times, ekf_len, label="EKF")

    plt.grid(True)
    plt.xlabel("time, seconds")
    plt.ylabel("start-line length, metres")
    plt.title("Estimated Start-Line Length")
    plt.legend()


def plot_distance_to_line(times, true_dist, ls_dist, ekf_dist):
    plt.figure(figsize=(10, 5))

    plt.plot(times, true_dist, label="True distance to line")
    plt.plot(times, ls_dist, label="Weighted least-squares")
    plt.plot(times, ekf_dist, label="EKF")

    plt.axhline(0, linestyle="--", linewidth=1)
    plt.grid(True)
    plt.xlabel("time, seconds")
    plt.ylabel("signed distance to line, metres")
    plt.title("Signed Distance to Start Line")
    plt.legend()


if __name__ == "__main__":
    main()