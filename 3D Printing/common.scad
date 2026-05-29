// Shared dimensions for anemometer top / bottom plates (millimeters).

$fn = 200;

LID_RADIUS = 40;
LID_LENGTH = 3;
BOLT_HOLE_RADIUS = 3;
BOLT_HOLE_OFFSET = 25;

// Pole mount (bottom plate only)
POLE_CYL_LENGTH = 1.5 * 25.4; // 38.1 mm
POLE_HOLE_RADIUS = (1 * 25.4) / 2; // 12.7 mm — 1 in bore
POLE_WALL = 3;
POLE_CYL_RADIUS = POLE_HOLE_RADIUS + POLE_WALL; // 15.7 mm OD
POLE_PIN_RADIUS = 2; // cross-bore for pin / set screw

module bolt_holes(height, z_bottom) {
    positions = [
        [BOLT_HOLE_OFFSET, BOLT_HOLE_OFFSET],
        [-BOLT_HOLE_OFFSET, -BOLT_HOLE_OFFSET],
        [-BOLT_HOLE_OFFSET, BOLT_HOLE_OFFSET],
        [BOLT_HOLE_OFFSET, -BOLT_HOLE_OFFSET],
    ];
    for (xy = positions) {
        translate([xy[0], xy[1], z_bottom - 0.01])
            cylinder(h=height + 0.02, r=BOLT_HOLE_RADIUS);
    }
}
