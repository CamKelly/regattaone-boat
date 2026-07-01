set(regattaone_srcs
    "boat_id.c"
    "device_type.c"
    "ryuw122_uart.c"
    "sc16is752.c"
    "meshtastic_uart.c"
    "meshtastic_client.c"
    "gps_nmea.c"
    "gps_pps.c"
    "i2c_bus_mux.c"
    "regattaone-laser.c"
    "sen0140_10dof.c"
    "ble_sen0140.c"
    "sx1262_lora.cpp"
    "lora_stats.c"
    "lora_mesh.c")

# RadioLib: components/RadioLib (vendored). HAL: main/EspHal.h (ESP-IDF example style, S3 SPI).
# sx1262_lora.cpp is compiled unconditionally; body is #if CONFIG_REGATTAONE_SX1262_ENABLE.
idf_component_register(SRCS ${regattaone_srcs}
                       PRIV_REQUIRES spi_flash esp_driver_i2c esp_driver_gpio esp_driver_uart
                                     esp_driver_spi bt nvs_flash
                                     esp_timer esp_system RadioLib
                       INCLUDE_DIRS "")

# RadioLib headers trigger -Werror=overloaded-virtual under ESP-IDF GCC 15.
target_compile_options(${COMPONENT_LIB} PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:-Wno-error=overloaded-virtual>")
