include <common.scad>

// -----------------------------------------------------------------------------
// Transducer mounting geometry
// -----------------------------------------------------------------------------
//
// Transducer is inserted from the TOP downward.
// Face points downward/outside the plate.
// Wire exits upward.
// Rear flange is on the wire side.
//
// Physical transducer dimensions:
//   body diameter:            16.0 mm
//   body bore clearance:      16.2 mm
//   rear flange diameter:     18.0 mm
//   flange pocket clearance:  18.3 mm
//   flange thickness:         2.5 mm
//   face to top of flange:    10.2 mm
//
// Design intent:
//   The highest point of the angled transducer face is flush with the
//   underside of the plate, z = 0.
//
// Plate:
//   bottom of plate: z = 0
//   top of plate:    z = 3
//
// OpenSCAD cylinder pivot:
//   A cylinder rotates around the center of its local bottom face.
//   Here that pivot is placed at MOUNT_BASE_Z = -5.
// -----------------------------------------------------------------------------

TRANSDUCER_BODY_RADIUS = 8.0;
TRANSDUCER_BORE_RADIUS = 8.10;      // 16.2 mm bore for print clearance

TRANSDUCER_FLANGE_RADIUS = 9.0;
FLANGE_BORE_RADIUS = 9.15;          // 18.3 mm counterbore for rear flange

FLANGE_THICKNESS = 2.5;
FACE_TO_FLANGE_TOP = 10.2;
FACE_TO_FLANGE_UNDERSIDE = FACE_TO_FLANGE_TOP - FLANGE_THICKNESS; // 7.7 mm

ULTRASONIC_ANGLE = 25;

MOUNT_BASE_Z = -5;

// The cylinder/sleeve rotates about this local origin.
// The highest rim of the angled face must be at z = 0.
// For a tilted circular face, the high rim is above the face center by:
//
//   TRANSDUCER_BODY_RADIUS * sin(ULTRASONIC_ANGLE)
//
// Therefore:
//
//   face_center_z = -TRANSDUCER_BODY_RADIUS * sin(ULTRASONIC_ANGLE)
//
FACE_CENTER_Z =
    -TRANSDUCER_BODY_RADIUS * sin(ULTRASONIC_ANGLE);

// Distance along the angled cylinder axis from pivot to face center.
FACE_CENTER_S =
    (FACE_CENTER_Z - MOUNT_BASE_Z) / cos(ULTRASONIC_ANGLE);

// The rear flange underside becomes the seating shoulder.
FLANGE_SHOULDER_S =
    FACE_CENTER_S + FACE_TO_FLANGE_UNDERSIDE;

// Top of the rear flange when seated.
FLANGE_TOP_S =
    FACE_CENTER_S + FACE_TO_FLANGE_TOP;

// Keep the sleeve top slightly above the flange top.
SLEEVE_TOP_CLEARANCE = 0.3;

// Total sleeve length along angled axis.
CYLINDER_LENGTH =
    FLANGE_TOP_S + SLEEVE_TOP_CLEARANCE;

// Outer sleeve radius.
// This gives approximately 3 mm wall around the 18.3 mm flange pocket.
OUTER_SLEEVE_RADIUS =
    FLANGE_BORE_RADIUS + 3;

// Inner bore cut should extend slightly beyond sleeve top.
BORE_EXTRA = 1;

// -----------------------------------------------------------------------------
// Helper modules
// -----------------------------------------------------------------------------

module angled_sleeve(pos, rot) {
    translate(pos)
    rotate(rot)
    cylinder(
        h = CYLINDER_LENGTH,
        r = OUTER_SLEEVE_RADIUS
    );
}

module angled_body_bore(pos, rot) {
    // Main 16.2 mm bore.
    // Starts below the desired face center so the transducer face is open
    // and not blocked by material.
    translate(pos)
    rotate(rot)
    cylinder(
        h = CYLINDER_LENGTH + BORE_EXTRA,
        r = TRANSDUCER_BORE_RADIUS
    );
}

module angled_flange_counterbore(pos, rot) {
    // Larger 18.3 mm counterbore from the flange shoulder to the top.
    // The shoulder at FLANGE_SHOULDER_S is what stops the rear flange.
    translate(pos)
    rotate(rot)
    translate([0, 0, FLANGE_SHOULDER_S])
    cylinder(
        h = CYLINDER_LENGTH - FLANGE_SHOULDER_S + BORE_EXTRA,
        r = FLANGE_BORE_RADIUS
    );
}

// -----------------------------------------------------------------------------
// Main model
// -----------------------------------------------------------------------------

difference() {

    union() {

        // Main circular lid plate.
        cylinder(h = LID_LENGTH, r = LID_RADIUS);

        // North / South transducer sleeves.
        angled_sleeve(
            [0, -20, MOUNT_BASE_Z],
            [ULTRASONIC_ANGLE, 0, 0]
        );

        angled_sleeve(
            [0, 20, MOUNT_BASE_Z],
            [-ULTRASONIC_ANGLE, 0, 0]
        );

        // East / West transducer sleeves.
        angled_sleeve(
            [20, 0, MOUNT_BASE_Z],
            [0, ULTRASONIC_ANGLE, 0]
        );

        angled_sleeve(
            [-20, 0, MOUNT_BASE_Z],
            [0, -ULTRASONIC_ANGLE, 0]
        );
    }

    union() {

        // Remove everything below the plate disk so the underside stays flat.
        translate([0, 0, -20])
        cylinder(h = 20, r = LID_RADIUS);

        // Main 16.2 mm body bores.
        angled_body_bore(
            [0, -20, MOUNT_BASE_Z],
            [ULTRASONIC_ANGLE, 0, 0]
        );

        angled_body_bore(
            [0, 20, MOUNT_BASE_Z],
            [-ULTRASONIC_ANGLE, 0, 0]
        );

        angled_body_bore(
            [20, 0, MOUNT_BASE_Z],
            [0, ULTRASONIC_ANGLE, 0]
        );

        angled_body_bore(
            [-20, 0, MOUNT_BASE_Z],
            [0, -ULTRASONIC_ANGLE, 0]
        );

        // 18.3 mm flange counterbores.
        angled_flange_counterbore(
            [0, -20, MOUNT_BASE_Z],
            [ULTRASONIC_ANGLE, 0, 0]
        );

        angled_flange_counterbore(
            [0, 20, MOUNT_BASE_Z],
            [-ULTRASONIC_ANGLE, 0, 0]
        );

        angled_flange_counterbore(
            [20, 0, MOUNT_BASE_Z],
            [0, ULTRASONIC_ANGLE, 0]
        );

        angled_flange_counterbore(
            [-20, 0, MOUNT_BASE_Z],
            [0, -ULTRASONIC_ANGLE, 0]
        );

        // Bolt holes.
        bolt_holes(80, -30);
    }
}