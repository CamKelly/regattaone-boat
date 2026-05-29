include <common.scad>

TRANSDUCER_RADIUS = 8.10;
CYLINDER_LENGTH = 20.304;
ULTRASONIC_ANGLE = 25;

difference() {

    union() {

        cylinder(h=LID_LENGTH, r=LID_RADIUS);

        translate([0, -20, -5])
        rotate([ULTRASONIC_ANGLE, 0, 0])
        cylinder(h=CYLINDER_LENGTH, r=TRANSDUCER_RADIUS+3);

        translate([0, 20, -5])
        rotate([-ULTRASONIC_ANGLE, 0, 0])
        cylinder(h=CYLINDER_LENGTH, r=TRANSDUCER_RADIUS+3);

        translate([20, 0, -5])
        rotate([0, ULTRASONIC_ANGLE, 0])
        cylinder(h=CYLINDER_LENGTH, r=TRANSDUCER_RADIUS+3);

        translate([-20, 0, -5])
        rotate([0, -ULTRASONIC_ANGLE, 0])
        cylinder(h=CYLINDER_LENGTH, r=TRANSDUCER_RADIUS+3);
    }

    union() {

        translate([0, 0, -20])
        cylinder(h=20, r=LID_RADIUS);

        translate([0, -20, -5])
        rotate([ULTRASONIC_ANGLE, 0, 0])
        cylinder(h=CYLINDER_LENGTH+1, r=TRANSDUCER_RADIUS);

        translate([0, 20, -5])
        rotate([-ULTRASONIC_ANGLE, 0, 0])
        cylinder(h=CYLINDER_LENGTH+1, r=TRANSDUCER_RADIUS);

        translate([20, 0, -5])
        rotate([0, ULTRASONIC_ANGLE, 0])
        cylinder(h=CYLINDER_LENGTH+1, r=TRANSDUCER_RADIUS);

        translate([-20, 0, -5])
        rotate([0, -ULTRASONIC_ANGLE, 0])
        cylinder(h=CYLINDER_LENGTH+1, r=TRANSDUCER_RADIUS);

        bolt_holes(80, -30);
    }
}
