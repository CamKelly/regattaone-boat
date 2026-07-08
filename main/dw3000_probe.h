#pragma once

#include "esp_err.h"

/** Init SPI/GPIO and read DW3000 device ID (DWM3000 evaluation). */
esp_err_t dw3000_probe_start(void);
