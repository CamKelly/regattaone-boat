#include "gps_pps_capture.h"

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_REGATTAONE_GPS_HW_CAPTURE

#include "driver/mcpwm_prelude.h"

#include "gps_hw_timer.h"
#include "gps_nmea.h"
#include "gps_timebase.h"
#include "tdma_scheduler.h"

static const char *TAG = "gps_pps_cap";

static TaskHandle_t s_notify_task;
static mcpwm_cap_timer_handle_t s_cap_timer;
static mcpwm_cap_channel_handle_t s_cap_chan;

static bool IRAM_ATTR gps_pps_cap_on_edge(mcpwm_cap_channel_handle_t cap_channel,
                                          const mcpwm_capture_event_data_t *edata, void *user_data)
{
    (void)cap_channel;
    (void)user_data;
    if (edata->cap_edge != MCPWM_CAP_EDGE_POS) {
        return false;
    }

    const uint64_t cap_ticks = edata->cap_value;
    gps_hw_timer_sync_to_capture(cap_ticks);
    gps_timebase_on_pps_hw_isr(cap_ticks);

    BaseType_t woken = pdFALSE;
    if (s_notify_task != NULL) {
        vTaskNotifyGiveFromISR(s_notify_task, &woken);
    }

#if CONFIG_TDMA_GPTIMER_SCHEDULER
    tdma_scheduler_on_pps_isr();
#endif

    return woken == pdTRUE;
}

esp_err_t gps_pps_capture_init(TaskHandle_t notify_task)
{
#if GPS_PPS_GPIO < 0
    ESP_LOGW(TAG, "PPS disabled (GPS_PPS_GPIO=-1)");
    return ESP_OK;
#else
    s_notify_task = notify_task;

    ESP_RETURN_ON_ERROR(gps_hw_timer_init(), TAG, "hw timer init");

    mcpwm_capture_timer_config_t cap_timer_config = {
        .group_id = 0,
        .clk_src = MCPWM_CAPTURE_CLK_SRC_DEFAULT,
        .resolution_hz = GPS_HW_TIMER_RESOLUTION_HZ,
    };
    ESP_RETURN_ON_ERROR(mcpwm_new_capture_timer(&cap_timer_config, &s_cap_timer), TAG, "cap timer");

    mcpwm_capture_channel_config_t cap_chan_config = {
        .gpio_num = GPS_PPS_GPIO,
        .prescale = 1,
        .flags.pos_edge = true,
        .flags.neg_edge = false,
    };
    ESP_RETURN_ON_ERROR(mcpwm_new_capture_channel(s_cap_timer, &cap_chan_config, &s_cap_chan), TAG, "cap chan");

    mcpwm_capture_event_callbacks_t cbs = {
        .on_cap = gps_pps_cap_on_edge,
    };
    ESP_RETURN_ON_ERROR(mcpwm_capture_channel_register_event_callbacks(s_cap_chan, &cbs, NULL), TAG, "callbacks");

    ESP_RETURN_ON_ERROR(mcpwm_capture_channel_enable(s_cap_chan), TAG, "cap enable");
    ESP_RETURN_ON_ERROR(mcpwm_capture_timer_enable(s_cap_timer), TAG, "timer enable");
    ESP_RETURN_ON_ERROR(mcpwm_capture_timer_start(s_cap_timer), TAG, "timer start");

    ESP_LOGI(TAG, "MCPWM capture on GPIO%d @ %u Hz → GPTimer sync", GPS_PPS_GPIO,
             (unsigned)GPS_HW_TIMER_RESOLUTION_HZ);
    return ESP_OK;
#endif
}

#else

esp_err_t gps_pps_capture_init(TaskHandle_t notify_task)
{
    (void)notify_task;
    return ESP_OK;
}

#endif /* CONFIG_REGATTAONE_GPS_HW_CAPTURE */
