// Anemometer bottom plate — plate on build plate (z = 0); socket extends upward (+Z).
// Print: lay flat on the plate; flip 180° for mast assembly (socket over pole).

include <common.scad>

part_bottom_z = 0;
socket_z = LID_LENGTH;
part_height = LID_LENGTH + POLE_CYL_LENGTH;
pole_pin_z = socket_z + POLE_CYL_LENGTH / 2;

difference() {
    union() {
        cylinder(h=LID_LENGTH, r=LID_RADIUS);
        translate([0, 0, socket_z])
            cylinder(h=POLE_CYL_LENGTH, r=POLE_CYL_RADIUS);
    }

    bolt_holes(part_height, part_bottom_z);

    // Pole bore — socket only; solid plate at center (z = 0 … LID_LENGTH).
    translate([0, 0, socket_z - 0.01])
        cylinder(h=POLE_CYL_LENGTH + 0.02, r=POLE_HOLE_RADIUS);

    // Pin / set-screw bore through socket wall, halfway along the socket (along X).
    translate([0, 0, pole_pin_z])
        rotate([0, 90, 0])
            cylinder(h=POLE_CYL_RADIUS * 2 + 2, r=POLE_PIN_RADIUS, center=true);
}
