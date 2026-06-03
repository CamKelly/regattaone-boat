# Ultrasonic transducer mounting plate — geometry reference

Dimensions and derived geometry for `top.scad` (four ultrasonic transducers on the anemometer top plate). All values in **millimeters** unless noted. Sources: `top.scad`, `common.scad`.

## Transducers

[JKelec ultrasonic transducer (product page)](https://en.jkelec.com/index.php?c=content&a=show&id=404)

## Overview

Four ultrasonic transducers mount in a circular top plate. Each transducer is installed from the **top** of the plate, points **downward/outward** through an angled sleeve, and the **rear flange** (wire side) seats on a shoulder in the sleeve as a positive stop.

**Design intent:** the **highest point** of the tilted **16 mm** radiating face is **flush with the underside** of the plate (**z = 0**), so the active face is fully exposed below the plate.

| Installation | Detail |
| --- | --- |
| Insert from | Top of plate |
| Face direction | Downward / outward |
| Wire | Exits upward |
| Depth stop | Rear flange on shoulder (no adhesive for depth) |

---

## Coordinate system

- **X**, **Y**: plane of the lid; origin at disk center.
- **Z**: vertical; **underside** of plate **z = 0**, **top** **z = `LID_LENGTH`**.

OpenSCAD transforms apply **right to left**: `cylinder` → `rotate` → `translate`. Each sleeve rotates about the **center of its local bottom face** (the pivot).

---

## Plate geometry

From `common.scad` (shared with bottom plate for bolt pattern).

| Parameter | Value |
| --- | --- |
| Plate diameter | 80 |
| Plate radius (`LID_RADIUS`) | 40 |
| Plate thickness (`LID_LENGTH`) | 3 |
| Bolt hole radius (`BOLT_HOLE_RADIUS`) | 3 |
| Bolt hole offset (`BOLT_HOLE_OFFSET`) | 25 |

| Surface | **z** |
| --- | --- |
| Bottom of plate (underside) | 0 |
| Top of plate | 3 |

---

## Transducer specification

From the supplied transducer drawing (modeled in `top.scad`).

| Parameter | Value |
| --- | --- |
| Face diameter | 16.0 |
| Body diameter | 16.0 |
| Flange diameter | 18.0 |
| Flange thickness | 2.5 |
| Face to top of flange | 10.2 |
| Face to underside of flange | 7.7 |

| SCAD constant | Value |
| --- | --- |
| `TRANSDUCER_BODY_RADIUS` | 8.0 (face alignment) |
| `TRANSDUCER_BORE_RADIUS` | 8.10 (16.2 mm bore, ~0.2 mm clearance) |
| `TRANSDUCER_FLANGE_RADIUS` | 9.0 |
| `FLANGE_BORE_RADIUS` | 9.15 (18.3 mm counterbore, ~0.3 mm clearance) |
| `FLANGE_THICKNESS` | 2.5 |
| `FACE_TO_FLANGE_TOP` | 10.2 |
| `FACE_TO_FLANGE_UNDERSIDE` | 7.7 |

---

## Mounting sleeve geometry

### Sleeve pivot

```scad
MOUNT_BASE_Z = -5;
```

| Reference | Distance |
| --- | --- |
| Pivot → plate underside (z = 0) | 5 |
| Pivot → plate top (z = 3) | 8 |

### Sleeve angle

```scad
ULTRASONIC_ANGLE = 25;  // degrees from vertical
```

Equivalent: **65°** from horizontal.

### Mount positions and rotations

| Label | Position `[x, y, z]` | Rotation |
| --- | --- | --- |
| North | `(0, −20, −5)` | `[+25, 0, 0]` |
| South | `(0, +20, −5)` | `[−25, 0, 0]` |
| East | `(+20, 0, −5)` | `[0, +25, 0]` |
| West | `(−20, 0, −5)` | `[0, −25, 0]` |

Axis direction (example, North): `(0, −sin 25°, cos 25°)`.

### Outer sleeve

| Parameter | Value |
| --- | --- |
| `OUTER_SLEEVE_RADIUS` | `FLANGE_BORE_RADIUS + 3` = **12.15** |
| Outer diameter | **24.3** (~3 mm wall around flange pocket) |
| `CYLINDER_LENGTH` | **≈ 12.286** (see below) |
| `SLEEVE_TOP_CLEARANCE` | 0.3 above flange top |

---

## Bores (subtracted)

Two cuts per mount, aligned with the same pivot and rotation.

### Main body bore — 16.2 mm

| Parameter | Value |
| --- | --- |
| Radius | `TRANSDUCER_BORE_RADIUS` = **8.10** |
| Diameter | **16.2** |
| Length | `CYLINDER_LENGTH + BORE_EXTRA` (`BORE_EXTRA` = 1) |

Full-length cut from pivot; clears the **16 mm** body and keeps the face open below the plate.

### Flange counterbore — 18.3 mm

| Parameter | Value |
| --- | --- |
| Radius | `FLANGE_BORE_RADIUS` = **9.15** |
| Diameter | **18.3** |
| Starts at | `FLANGE_SHOULDER_S` along local axis |
| Role | Clearance for **18 mm** flange; **shoulder at `FLANGE_SHOULDER_S`** is the positive stop |

---

## Face alignment geometry

The radiating face is a **16 mm** disk perpendicular to the bore. With tilt **25°** from vertical, the **highest-Z** point on the rim is above the face center by:

```text
offset = TRANSDUCER_BODY_RADIUS × sin(25°)
       = 8.0 × 0.422618…
       ≈ 3.381 mm
```

For that highest rim to lie on **z = 0**:

```text
FACE_CENTER_Z = −TRANSDUCER_BODY_RADIUS × sin(25°) ≈ −3.381 mm
```

| Rim on face (world Z) | **z** |
| --- | --- |
| Highest (flush target) | **0** (underside) |
| Face center on axis | **≈ −3.381** |
| Lowest | **≈ −6.762** (below underside; pocket below plate) |

---

## Calculated positions along sleeve axis

Distance **S** is measured along the rotated local **+Z** from the pivot (bottom face of sleeve).

| Symbol | Formula | Value (mm) |
| --- | --- | --- |
| `FACE_CENTER_S` | `(FACE_CENTER_Z − MOUNT_BASE_Z) / cos 25°` | **≈ 1.786** |
| `FLANGE_SHOULDER_S` | `FACE_CENTER_S + 7.7` | **≈ 9.486** |
| `FLANGE_TOP_S` | `FACE_CENTER_S + 10.2` | **≈ 11.986** |
| `CYLINDER_LENGTH` | `FLANGE_TOP_S + 0.3` | **≈ 12.286** |

Rounded values from the design spec (same geometry):

| Parameter | Spec (rounded) |
| --- | --- |
| `FACE_CENTER_S` | 1.79 |
| `FLANGE_SHOULDER_S` | 9.49 |
| `FLANGE_TOP_S` | 11.99 |
| `CYLINDER_LENGTH` | 12.29 |

---

## Transducer center spacing

### Nominal spacing (vertical sleeves)

Centers at **±20 mm** on X or Y → **40.0 mm** center-to-center if sleeves were vertical.

### Effective spacing at plate underside

Tilt and pivot depth shift centers outward in plan view. For spacing at the **underside** (where the face is flush), use pivot-to-**top** height **8 mm** (same as face-center spacing reference in the build spec):

```text
horizontal offset per side = 8 × tan(25°) ≈ 3.730 mm

centre_to_centre = 40 + 2 × 8 × tan(25°)
                 ≈ 47.461 mm
```

**Opposing center-to-center at underside: ≈ 47.46 mm** (matches prototype calipers ~47.5 mm).

Example (North): face center **y ≈ −20 − FACE_CENTER_S·sin(25°)**; at **z = 0** the highest rim is on the underside, not the axis center.

### Reference: axis pierces underside at z = 0

If centers are taken where the **bore axis** crosses **z = 0** (not face-center height):

```text
offset = 5 × tan(25°) ≈ 2.332 mm
spacing ≈ 44.663 mm
```

Use **47.46 mm** for opposing **transducer face** centers at the underside; use **44.66 mm** only for axis–underside intersection.

---

## Acoustic path and bottom plate spacing

North/South (and East/West) pairs use a **V-path**: transmit from one
transducer face → specular reflection on the **top face** of
`bottom.scad` → receive at the opposite face. Wind speed along that axis
uses the **face-to-face path length** **L**, not the straight plate gap.

### Measurable gap **G**

**G** is the distance you can measure in assembly (calipers, standoffs,
shims):

| Reference | Surface |
| --- | --- |
| Top | Underside of top plate (**z = 0**) |
| Bottom | Top face of bottom reflector plate (reflecting surface) |

If you measure through the full stack to the **bottom** of the bottom
plate, subtract plate thickness: **G = stack − `LID_LENGTH`**.

The transducer **faces** sit below the top underside at
**z_face = −r·sin(α) ≈ −3.381 mm**; **G** is plate-to-plate, not
face-to-face.

### Symbols

| Symbol | Meaning | Value |
| --- | --- | --- |
| **M** | Pivot offset from center (±20 on Y or X) | 20 mm |
| **p** | \|`MOUNT_BASE_Z`\| | 5 mm |
| **r** | `TRANSDUCER_BODY_RADIUS` | 8 mm |
| **α** | `ULTRASONIC_ANGLE` | 25° |
| **F** | `FACE_CENTER_S` = (p − r·sin α) / cos α | ≈ 1.786 mm |

Face centers on the bore axis (North/South example):

```text
y_N = −M − F·sin(α) ≈ −20.755 mm
y_S = +M + F·sin(α) ≈ +20.755 mm
z_face = −r·sin(α) ≈ −3.381 mm
Δy = y_S − y_N = 2M + 2F·sin(α) ≈ 41.51 mm
```

Emission from each face is along the bore axis, **downward and toward
center**: North **(0, +sin α, −cos α)**, South **(0, −sin α, −cos α)**.

### Required gap (ray closure)

For the reflected pulse to hit the opposite transducer, **G** is fixed
by sleeve geometry (not a free parameter):

```text
G = p + M·cot(α)
  = 5 + 20·cot(25°)
  ≈ 47.88 mm
```

Small misalignment is tolerated by the ~16 mm face aperture; large
errors miss the receiver.

### Face-to-face path length **L**

When **G** is set correctly, the V-path is symmetric (equal down/up
legs). **L** is North face center → reflector → South face center (same
both directions at zero wind):

```text
L = 2·(G − r·sin(α)) / cos(α)
  = Δy / sin(α)
  = (2M + 2F·sin(α)) / sin(α)
  ≈ 98.22 mm
```

Each leg ≈ **49.11 mm**. East/West use the same formulas with **M = 20**
on **X**.

### Assembly workflow

1. Measure **G** (top underside → bottom reflector top).
2. Target **G ≈ 47.88 mm** (standoffs/spacers as needed).
3. Compute **L** from measured **G**, or use **L ≈ 98.22 mm** at nominal
   **G**.
4. Use **L** in delta–time-of-flight wind math along that axis.

### Wind component (reference)

Along North–South, with sound speed **c** and
**Δt = t_N→S − t_S→N**:

```text
v_NS ≈ (L / (2·cos(α))) · (Δt / t₀) · c     (t₀ ≈ L / c, first order)
```

A 1 mm error in **L** is ~1% velocity error.

---

## Bolt holes

`bolt_holes(80, -30)` in `top.scad`; defined in `common.scad`.

| Parameter | Value |
| --- | --- |
| Centers in XY | `(±25, ±25)` |
| Radius | 3 |
| Opposing through center (same X or Y) | **50** |
| Diagonal opposites | **50√2 ≈ 70.71** |

---

## Design checklist

- [x] Install from top; flange stops insertion depth  
- [x] Active face exposed below plate (upper rim of face at **z = 0**)  
- [x] 16.2 mm body bore + 18.3 mm flange counterbore  
- [x] Consistent geometry on all four channels  
- [x] Repeatable acoustic spacing (**≈ 47.46 mm** opposing centers at underside)
- [x] Bottom reflector gap **G ≈ 47.88 mm**; acoustic path **L ≈ 98.22 mm**

---

## Key dimensions summary

| Parameter | Value |
| --- | --- |
| Plate diameter | 80 mm |
| Plate thickness | 3 mm |
| Sleeve angle | 25° (65° from horizontal) |
| Body bore diameter | 16.2 mm |
| Flange counterbore diameter | 18.3 mm |
| Transducer body / face diameter | 16.0 mm |
| Flange diameter | 18.0 mm |
| Face to flange top | 10.2 mm |
| Sleeve pivot Z | −5 mm |
| Face center Z | ≈ −3.38 mm |
| Sleeve length | ≈ 12.29 mm |
| Opposing center spacing (underside) | ≈ 47.46 mm |
| Bottom reflector gap **G** (nominal) | ≈ 47.88 mm |
| Acoustic path **L** (face to face, N↔S) | ≈ 98.22 mm |

---

## Recalculation

```bash
python3 -c "
import math
r, pz, lid, mount = 8.0, -5, 3, 20
a = math.radians(25)
s, c = math.sin(a), math.cos(a)
p = -pz
fcz = -r * s
fcs = (fcz - pz) / c
G = p + mount / math.tan(a)
L = 2 * (G - r * s) / c
dy = 2 * mount + 2 * fcs * s
print('FACE_CENTER_Z', fcz)
print('FACE_CENTER_S', fcs)
print('FLANGE_SHOULDER_S', fcs + 7.7)
print('FLANGE_TOP_S', fcs + 10.2)
print('CYLINDER_LENGTH', fcs + 10.2 + 0.3)
print('Spacing underside', 40 + 2 * (lid - pz) * math.tan(a))
print('Face delta_y', dy)
print('Bottom gap G', G)
print('Acoustic path L', L)
print('Leg length', L / 2)
"
```

---

## Related files

- `top.scad` — lid, sleeves, body bore, flange counterbore  
- `bottom.scad` — reflector plate (top face at gap **G** below top underside)  
- `common.scad` — plate and bolt dimensions  
- `README.md` — OpenSCAD workflow  
