idf_component_register(SRCS "boat_id.c" "boat_note.c" "device_type.c" "ryuw122_uart.c" "blues_notecard.c" "i2c_bus_mux.c" "msp430_fw_upload.c" "msp430_bsl_flash.c" "msp430_bsl_invoke.c" "regattaone-laser.c" "sen0140_10dof.c" "ble_sen0140.c" "msp430_uart_rx.c"
                       PRIV_REQUIRES spi_flash esp_driver_i2c esp_driver_gpio esp_driver_uart bt nvs_flash esp_timer esp_system
                       INCLUDE_DIRS "")
