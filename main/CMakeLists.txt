set(regattaone_srcs
    "boat_id.c"
    "device_type.c"
    "dw3000_config.c"
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

# ESP-IDF 6 evaluates main/CMakeLists.txt before sdkconfig symbols are visible to
# if(CONFIG_*) — keep decadriver/libdeca in PRIV_REQUIRES unconditionally and pick
# the implementation file after reconfigure via the stub/ranging split.
set(regattaone_priv_requires spi_flash esp_driver_i2c esp_driver_gpio esp_driver_uart
                           esp_driver_spi bt nvs_flash esp_timer esp_system RadioLib
                           decadriver libdeca)
if(CONFIG_DW3000_RANGING_ENABLE)
    list(APPEND regattaone_srcs "dw3000_ranging.c")
else()
    list(APPEND regattaone_srcs "dw3000_ranging_stub.c")
    if(CONFIG_REGATTAONE_DW3000_ENABLE)
        list(APPEND regattaone_srcs "dw3000_probe.c")
    endif()
endif()

# RadioLib: components/RadioLib (vendored). HAL: main/EspHal.h (ESP-IDF example style, S3 SPI).
# sx1262_lora.cpp is compiled unconditionally; body is #if CONFIG_REGATTAONE_SX1262_ENABLE.
idf_component_register(SRCS ${regattaone_srcs}
                       PRIV_REQUIRES ${regattaone_priv_requires}
                       INCLUDE_DIRS "")

# RadioLib headers trigger -Werror=overloaded-virtual under ESP-IDF GCC 15.
target_compile_options(${COMPONENT_LIB} PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:-Wno-error=overloaded-virtual>")
