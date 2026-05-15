#include "i2c_bus_mux.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "i2c_mux";

static SemaphoreHandle_t s_mux;

void i2c_bus_mux_init(void)
{
    if (s_mux != NULL) {
        return;
    }
    s_mux = xSemaphoreCreateRecursiveMutex();
    if (s_mux == NULL) {
        ESP_LOGE(TAG, "recursive mutex create failed");
    }
}

void i2c_bus_mux_lock(void)
{
    if (s_mux != NULL) {
        (void)xSemaphoreTakeRecursive(s_mux, portMAX_DELAY);
    }
}

void i2c_bus_mux_unlock(void)
{
    if (s_mux != NULL) {
        (void)xSemaphoreGiveRecursive(s_mux);
    }
}
