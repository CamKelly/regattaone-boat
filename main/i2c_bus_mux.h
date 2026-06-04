#pragma once

/** Serialize I2C access when multiple clients share one bus. */
void i2c_bus_mux_init(void);
void i2c_bus_mux_lock(void);
void i2c_bus_mux_unlock(void);
