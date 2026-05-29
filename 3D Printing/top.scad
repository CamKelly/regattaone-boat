include <common.scad>

TRANSDUCER_RADIUS = 8.10;
ULTRASONIC_ANGLE = 25;
MOUNT_BASE_Z = -5;
INNER_BORE_EXTRA = 1; // inner cut extends this far past outer sleeve along axis
// Shortest inner bore rim above plate underside (z = 0), downhill side of tilt.
INNER_RIM_MIN_Z = 7.7;
CYLINDER_LENGTH =
    (INNER_RIM_MIN_Z - MOUNT_BASE_Z + TRANSDUCER_RADIUS * sin(ULTRASONIC_ANGLE))
        / cos(ULTRASONIC_ANGLE)
    - INNER_BORE_EXTRA;

difference() {

    union() {

        cylinder(h=LID_LENGTH, r=LID_RADIUS);

        translate([0, -20, MOUNT_BASE_Z])
        rotate([ULTRASONIC_ANGLE, 0, 0])
        cylinder(h=CYLINDER_LENGTH, r=TRANSDUCER_RADIUS+3);

        translate([0, 20, MOUNT_BASE_Z])
        rotate([-ULTRASONIC_ANGLE, 0, 0])
        cylinder(h=CYLINDER_LENGTH, r=TRANSDUCER_RADIUS+3);

        translate([20, 0, MOUNT_BASE_Z])
        rotate([0, ULTRASONIC_ANGLE, 0])
        cylinder(h=CYLINDER_LENGTH, r=TRANSDUCER_RADIUS+3);

        translate([-20, 0, MOUNT_BASE_Z])
        rotate([0, -ULTRASONIC_ANGLE, 0])
        cylinder(h=CYLINDER_LENGTH, r=TRANSDUCER_RADIUS+3);
    }

    union() {

        translate([0, 0, -20])
        cylinder(h=20, r=LID_RADIUS);

        translate([0, -20, MOUNT_BASE_Z])
        rotate([ULTRASONIC_ANGLE, 0, 0])
        cylinder(h=CYLINDER_LENGTH + INNER_BORE_EXTRA, r=TRANSDUCER_RADIUS);

        translate([0, 20, MOUNT_BASE_Z])
        rotate([-ULTRASONIC_ANGLE, 0, 0])
        cylinder(h=CYLINDER_LENGTH + INNER_BORE_EXTRA, r=TRANSDUCER_RADIUS);

        translate([20, 0, MOUNT_BASE_Z])
        rotate([0, ULTRASONIC_ANGLE, 0])
        cylinder(h=CYLINDER_LENGTH + INNER_BORE_EXTRA, r=TRANSDUCER_RADIUS);

        translate([-20, 0, MOUNT_BASE_Z])
        rotate([0, -ULTRASONIC_ANGLE, 0])
        cylinder(h=CYLINDER_LENGTH + INNER_BORE_EXTRA, r=TRANSDUCER_RADIUS);

        bolt_holes(80, -30);
    }
}
