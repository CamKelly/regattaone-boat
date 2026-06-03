set(regattaone_srcs
    "boat_id.c"
    "boat_note.c"
    "device_type.c"
    "presence_sync.c"
    "ryuw122_uart.c"
    "blues_notecard.c"
    "i2c_bus_mux.c"
    "msp430_fw_upload.c"
    "msp430_bsl_flash.c"
    "msp430_bsl_invoke.c"
    "regattaone-laser.c"
    "sen0140_10dof.c"
    "ble_sen0140.c"
    "msp430_uart_rx.c"
    "gps_nmea.c"
    "sx1262_lora.cpp")

# RadioLib + SPI are always declared: sx1262_lora.cpp is compiled unconditionally
# (body is #if CONFIG_REGATTAONE_SX1262_ENABLE). PRIV_REQUIRES so main's own
# sources (radiolib_esp_hal.hpp) get RadioLib include paths.
idf_component_register(SRCS ${regattaone_srcs}
                       PRIV_REQUIRES spi_flash esp_driver_i2c esp_driver_gpio esp_driver_uart
                                     esp_driver_spi bt nvs_flash esp_timer esp_system RadioLib
                       INCLUDE_DIRS "")

# RadioLib headers trigger -Werror=overloaded-virtual under ESP-IDF GCC 15.
target_compile_options(${COMPONENT_LIB} PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:-Wno-error=overloaded-virtual>")
