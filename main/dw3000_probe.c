#include "dw3000_probe.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_DW3000_ENABLE

#include "deca_device_api.h"
#include "dw3000_hw.h"

#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "dw3000_probe";

esp_err_t dw3000_probe_start(void)
{
    ESP_RETURN_ON_ERROR(dw3000_hw_init(), TAG, "hw init");
    dw3000_hw_reset();

    const uint32_t dev_id = dwt_readdevid();
    ESP_LOGI(TAG, "DEVID 0x%08lx (expect 0xDECA0302 DW3110 or 0xDECA0312 DW3120)",
             (unsigned long)dev_id);

    if (dev_id != 0xDECA0302UL && dev_id != 0xDECA0312UL) {
        ESP_LOGW(TAG, "unexpected DEVID — check SPI wiring and menuconfig GPIOs");
        return ESP_ERR_NOT_FOUND;
    }
    return ESP_OK;
}

#else

esp_err_t dw3000_probe_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

#endif /* CONFIG_REGATTAONE_DW3000_ENABLE */
