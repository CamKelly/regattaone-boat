#include "tdma_scheduler.h"

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_TDMA_GPTIMER_SCHEDULER

#include "driver/gptimer.h"

#include "gps_hw_timer.h"
#include "gps_timebase.h"
#include "tdma.h"

static const char *TAG = "tdma_sched";

typedef enum {
    TDMA_ALARM_OPEN = 0,
    TDMA_ALARM_CLOSE,
} tdma_alarm_kind_t;

static volatile bool s_in_window;
static volatile tdma_alarm_kind_t s_next_alarm;
static TaskHandle_t s_slot_task;

static gptimer_alarm_config_t s_alarm_cfg;

static void tdma_scheduler_arm_at_ticks(uint64_t alarm_ticks, tdma_alarm_kind_t kind)
{
    gptimer_handle_t timer = gps_hw_timer_handle();
    if (timer == NULL) {
        return;
    }
    s_next_alarm = kind;
    s_alarm_cfg.alarm_count = alarm_ticks;
    s_alarm_cfg.flags.auto_reload_on_alarm = 0;
    (void)gptimer_set_alarm_action(timer, &s_alarm_cfg);
}

static bool IRAM_ATTR tdma_scheduler_alarm_cb(gptimer_handle_t timer, const gptimer_alarm_event_data_t *edata,
                                              void *user_data)
{
    (void)timer;
    (void)edata;
    (void)user_data;

    s_in_window = (s_next_alarm == TDMA_ALARM_OPEN);

    BaseType_t woken = pdFALSE;
    if (s_slot_task != NULL) {
        vTaskNotifyGiveFromISR(s_slot_task, &woken);
    }
    return woken == pdTRUE;
}

void tdma_scheduler_arm_next(void)
{
    if (!gps_timebase_utc_valid()) {
        s_in_window = false;
        return;
    }

    const int64_t now_utc = gps_timebase_now_us();
    if (now_utc <= 0) {
        return;
    }

    if (tdma_in_tx_window(now_utc)) {
        s_in_window = true;
        const int64_t remain = tdma_us_remaining_in_slot();
        const uint64_t close_at = gps_hw_timer_now_ticks() + (uint64_t)(remain > 0 ? remain : 1);
        tdma_scheduler_arm_at_ticks(close_at, TDMA_ALARM_CLOSE);
        return;
    }

    s_in_window = false;
    const int64_t wait = tdma_us_until_tx_window();
    if (wait < 0) {
        return;
    }
    const uint64_t open_at = gps_hw_timer_now_ticks() + (uint64_t)wait;
    tdma_scheduler_arm_at_ticks(open_at, TDMA_ALARM_OPEN);
}

static void tdma_slot_task(void *arg)
{
    (void)arg;
    for (;;) {
        (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        tdma_scheduler_arm_next();
    }
}

esp_err_t tdma_scheduler_init(void)
{
    gptimer_handle_t timer = gps_hw_timer_handle();
    if (timer == NULL) {
        ESP_LOGW(TAG, "GPTimer not ready");
        return ESP_ERR_INVALID_STATE;
    }

    gptimer_event_callbacks_t cbs = {
        .on_alarm = tdma_scheduler_alarm_cb,
    };
    ESP_RETURN_ON_ERROR(gptimer_register_event_callbacks(timer, &cbs, NULL), TAG, "callbacks");
    ESP_RETURN_ON_ERROR(gps_hw_timer_start(), TAG, "timer start");

    const uint32_t stack = 3072;
    if (xTaskCreate(tdma_slot_task, "tdma_slot", stack, NULL, configMAX_PRIORITIES - 2, &s_slot_task) != pdPASS) {
        s_slot_task = NULL;
        ESP_LOGW(TAG, "slot task create failed");
    }

    tdma_scheduler_arm_next();
    ESP_LOGI(TAG, "GPTimer one-shot TDMA slot alarms enabled");
    return ESP_OK;
}

void IRAM_ATTR tdma_scheduler_on_pps_isr(void)
{
    BaseType_t woken = pdFALSE;
    if (s_slot_task != NULL) {
        vTaskNotifyGiveFromISR(s_slot_task, &woken);
    }
    if (woken == pdTRUE) {
        portYIELD_FROM_ISR();
    }
}

bool tdma_scheduler_in_window(void)
{
    return s_in_window;
}

#endif /* CONFIG_TDMA_GPTIMER_SCHEDULER */
