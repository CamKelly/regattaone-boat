#include "gps_hw_timer.h"

#include "esp_check.h"
#include "esp_log.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_GPS_HW_CAPTURE

static const char *TAG = "gps_hw_tmr";

static gptimer_handle_t s_gptimer;
static bool s_started;

esp_err_t gps_hw_timer_init(void)
{
    if (s_gptimer != NULL) {
        return ESP_OK;
    }

    gptimer_config_t timer_config = {
        .clk_src = GPTIMER_CLK_SRC_DEFAULT,
        .direction = GPTIMER_COUNT_UP,
        .resolution_hz = GPS_HW_TIMER_RESOLUTION_HZ,
        .intr_priority = 1,
    };
    ESP_RETURN_ON_ERROR(gptimer_new_timer(&timer_config, &s_gptimer), TAG, "new_timer");
    ESP_LOGI(TAG, "GPTimer created @ %u Hz (enable after alarm callbacks registered)", (unsigned)GPS_HW_TIMER_RESOLUTION_HZ);
    return ESP_OK;
}

esp_err_t gps_hw_timer_start(void)
{
    if (s_gptimer == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (s_started) {
        return ESP_OK;
    }
    ESP_RETURN_ON_ERROR(gptimer_enable(s_gptimer), TAG, "enable");
    ESP_RETURN_ON_ERROR(gptimer_start(s_gptimer), TAG, "start");
    s_started = true;
    ESP_LOGI(TAG, "GPTimer running");
    return ESP_OK;
}

uint64_t IRAM_ATTR gps_hw_timer_now_ticks(void)
{
    if (s_gptimer == NULL || !s_started) {
        return 0;
    }
    uint64_t count = 0;
    if (gptimer_get_raw_count(s_gptimer, &count) != ESP_OK) {
        return 0;
    }
    return count;
}

void IRAM_ATTR gps_hw_timer_sync_to_capture(uint64_t cap_ticks)
{
    if (s_gptimer == NULL || !s_started) {
        return;
    }
    (void)gptimer_set_raw_count(s_gptimer, cap_ticks);
}

gptimer_handle_t gps_hw_timer_handle(void)
{
    return s_gptimer;
}

#else

esp_err_t gps_hw_timer_init(void)
{
    return ESP_OK;
}

esp_err_t gps_hw_timer_start(void)
{
    return ESP_OK;
}

uint64_t gps_hw_timer_now_ticks(void)
{
    return 0;
}

void gps_hw_timer_sync_to_capture(uint64_t cap_ticks)
{
    (void)cap_ticks;
}

gptimer_handle_t gps_hw_timer_handle(void)
{
    return NULL;
}

#endif /* CONFIG_REGATTAONE_GPS_HW_CAPTURE */
