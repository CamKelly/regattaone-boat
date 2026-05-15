#pragma once

/** Serialize I2C between SEN0140 reads and Blues Notecard transactions on one bus. */
void i2c_bus_mux_init(void);
void i2c_bus_mux_lock(void);
void i2c_bus_mux_unlock(void);
