#include "dw3000_ranging.h"

#include "esp_err.h"

esp_err_t dw3000_ranging_init(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

uint16_t dw3000_ranging_self_addr(void)
{
    return 0;
}

uint16_t dw3000_ranging_panid(void)
{
    return 0;
}

void dw3000_ranging_set_callback(dw3000_range_result_cb_t cb)
{
    (void)cb;
}

esp_err_t dw3000_ranging_apply_config(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t dw3000_range_to(uint16_t peer_addr, uint16_t *dist_cm,
                          uint32_t timeout_ms)
{
    (void)peer_addr;
    (void)dist_cm;
    (void)timeout_ms;
    return ESP_ERR_NOT_SUPPORTED;
}
