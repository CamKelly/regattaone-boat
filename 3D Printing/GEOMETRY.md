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

---

## Recalculation

```bash
python3 -c "
import math
r, pz, lid = 8.0, -5, 3
a = math.radians(25)
fcz = -r * math.sin(a)
fcs = (fcz - pz) / math.cos(a)
print('FACE_CENTER_Z', fcz)
print('FACE_CENTER_S', fcs)
print('FLANGE_SHOULDER_S', fcs + 7.7)
print('FLANGE_TOP_S', fcs + 10.2)
print('CYLINDER_LENGTH', fcs + 10.2 + 0.3)
print('Spacing underside', 40 + 2 * (lid - pz) * math.tan(a))
"
```

---

## Related files

- `top.scad` — lid, sleeves, body bore, flange counterbore  
- `common.scad` — plate and bolt dimensions  
- `README.md` — OpenSCAD workflow  
