/*
 * BLE notify: binary IMU frame for Web Bluetooth + app-side Madgwick fusion.
 */
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_att.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "sdkconfig.h"

#include "ble_sen0140.h"
#if CONFIG_REGATTAONE_NOTECARD_ENABLE
#include "blues_notecard.h"
#endif
#include "msp430_bsl_invoke.h"
#include "msp430_fw_upload.h"
#if CONFIG_REGATTAONE_MSP430_ENABLE
#include "msp430_uart_rx.h"
#endif

static const char *TAG = "ble_sen0140";

/** 16-bit UUIDs (full: 0000XXXX-0000-1000-8000-00805f9b34fb). */
#define SEN0140_GATT_SVC_UUID      0xfef0
#define SEN0140_GATT_CHR_UUID      0xfef1
#define SEN0140_GATT_UART_CHR_UUID 0xfef2
#define SEN0140_GATT_BSL_CHR_UUID  0xfef3
#define SEN0140_GATT_FW_CHR_UUID         0xfef4
#define SEN0140_GATT_PROG_STATUS_CHR_UUID 0xfef5
/** Write 2 B: [RST level][TEST level] — each 0x00 = low, 0x01 = high (scope / continuity check). */
#define SEN0140_GATT_GPIO_CHR_UUID      0xfef6
/** Write: UTF-8 Notecard JSON request (must end with `\n`). Triggers I2C transaction; response on FEF8. */
#define SEN0140_GATT_NOTECARD_REQ_UUID  0xfef7
#define SEN0140_GATT_NOTECARD_RSP_UUID  0xfef8
#define SEN0140_GATT_UWB_LINE_UUID      0xfef9

/** Max payload per notify (ATT MTU typically 23–247 after negotiation). */
#define SEN0140_BLE_UART_CHUNK_MAX 200U
/** Max single FW upload ATT write (opcode + length + chunk). */
#define SEN0140_BLE_FW_CHUNK_MAX 230U

#define SEN0140_BLE_FLAG_ADXL       0x01U
#define SEN0140_BLE_FLAG_ITG        0x02U
#define SEN0140_BLE_FLAG_MAG        0x04U
#define SEN0140_BLE_FLAG_BARO_TEMP  0x08U
#define SEN0140_BLE_FLAG_BARO_PRESS 0x10U

/** v1 = 34 bytes IMU only; v2 = +8 bytes temp_c + press_hpa (float32 LE). */
#define SEN0140_BLE_VER           2U

typedef struct __attribute__((packed)) {
    uint8_t version;
    uint8_t flags;
    uint16_t seq;
    float ax, ay, az;
    float gx, gy, gz;
    int16_t mx, my, mz;
    float temp_c;
    float press_hpa;
} sen0140_ble_imu_pkt_t;

_Static_assert(sizeof(sen0140_ble_imu_pkt_t) == 42, "BLE IMU packet size");

static uint16_t s_chr_val_handle;
static uint16_t s_uart_chr_val_handle;
static uint16_t s_bsl_chr_val_handle;
static uint16_t s_fw_chr_val_handle;
static uint16_t s_prog_status_chr_val_handle;
static uint16_t s_notecard_rsp_chr_val_handle;
static uint16_t s_uwb_line_chr_val_handle;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static bool s_notify_enabled;
static bool s_uart_notify_enabled;
static bool s_prog_notify_enabled;
static bool s_notecard_rsp_notify_enabled;
static bool s_uwb_line_notify_enabled;
static uint16_t s_seq;

/**
 * Serialize mbuf alloc + `ble_gatts_notify_custom` if additional characteristics are added later.
 */
static SemaphoreHandle_t s_ble_notify_mtx;

static void ble_sen0140_notify_mtx_init(void)
{
    if (s_ble_notify_mtx != NULL) {
        return;
    }
    s_ble_notify_mtx = xSemaphoreCreateRecursiveMutex();
    if (s_ble_notify_mtx == NULL) {
        ESP_LOGE(TAG, "BLE notify mutex create failed");
    }
}

static void ble_notify_take(void)
{
    if (s_ble_notify_mtx != NULL) {
        (void)xSemaphoreTakeRecursive(s_ble_notify_mtx, portMAX_DELAY);
    }
}

static void ble_notify_give(void)
{
    if (s_ble_notify_mtx != NULL) {
        (void)xSemaphoreGiveRecursive(s_ble_notify_mtx);
    }
}

/**
 * `BLE_GAP_EVENT_SUBSCRIBE.attr_handle` is the characteristic value handle on NimBLE, but some
 * clients/stacks surface the CCCD handle (typically value + 1). Accept either.
 */
static bool subscribe_attr_matches_chr(uint16_t sub_attr_handle, uint16_t chr_val_handle)
{
    return chr_val_handle != 0U &&
           (sub_attr_handle == chr_val_handle || sub_attr_handle == chr_val_handle + 1U);
}

/** Default BLE_OWN_ADDR_PUBLIC until `ble_hs_id_infer_auto` in `on_sync`. */
static uint8_t s_ble_own_addr_type;

static void ble_advertise(void);

static int gatt_svr_access_imu(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                               void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        static const sen0140_ble_imu_pkt_t zero;
        return os_mbuf_append(ctxt->om, &zero, sizeof(zero)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int gatt_svr_access_uart(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        /* Notify carries live data; static read is empty. */
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int gatt_svr_access_bsl(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                               void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_READ_NOT_PERMITTED;
    }

    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    if (len > 32) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    if (!msp430_bsl_invoke_ready()) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }

#if CONFIG_REGATTAONE_MSP430_ENABLE
    /* Match TI UART BSL (9600 8E1) before RST/TEST entry — same preamble idea as `msp430_bsl_flash_ti_txt`. */
    msp430_uart_bridge_set_enabled(false);
    vTaskDelay(pdMS_TO_TICKS(10));
    msp430_uart_flush_rx();
    esp_err_t u = msp430_uart_apply_config(9600, UART_PARITY_EVEN);
    if (u != ESP_OK) {
        ESP_LOGW(TAG, "BSL UART 9600 config failed: %s", esp_err_to_name(u));
        (void)msp430_uart_apply_config(115200, UART_PARITY_DISABLE);
        msp430_uart_bridge_set_enabled(true);
        return BLE_ATT_ERR_UNLIKELY;
    }
    vTaskDelay(pdMS_TO_TICKS(30));
#endif

    esp_err_t err = msp430_bsl_invoke_hardware();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "BSL invoke failed: %s", esp_err_to_name(err));
#if CONFIG_REGATTAONE_MSP430_ENABLE
        (void)msp430_uart_apply_config(115200, UART_PARITY_DISABLE);
        msp430_uart_flush_rx();
        msp430_uart_bridge_set_enabled(true);
#endif
        return BLE_ATT_ERR_UNLIKELY;
    }
#if CONFIG_REGATTAONE_MSP430_ENABLE
    msp430_uart_flush_rx();
    /* Stay at 9600 8E1; bridge off until Flash MSP430 or BLE disconnect restores application UART. */
#endif
    return 0;
}

static int gatt_svr_access_fw(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_READ_NOT_PERMITTED;
    }

    uint16_t om_len = OS_MBUF_PKTLEN(ctxt->om);
    if (om_len == 0 || om_len > SEN0140_BLE_FW_CHUNK_MAX) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    uint8_t buf[SEN0140_BLE_FW_CHUNK_MAX];
    if (os_mbuf_copydata(ctxt->om, 0, om_len, buf) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    esp_err_t e = msp430_fw_upload_ble_packet(buf, om_len);
    if (e == ESP_OK) {
        return 0;
    }
    if (e == ESP_ERR_INVALID_ARG || e == ESP_ERR_INVALID_SIZE) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (e == ESP_ERR_NO_MEM) {
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int gatt_svr_access_gpio_levels(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                       void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_READ_NOT_PERMITTED;
    }

    uint16_t om_len = OS_MBUF_PKTLEN(ctxt->om);
    if (om_len != 2) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    uint8_t b[2];
    if (os_mbuf_copydata(ctxt->om, 0, 2, b) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (b[0] > 1U || b[1] > 1U) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    if (!msp430_bsl_invoke_ready()) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }

    esp_err_t err = msp430_bsl_gpio_manual_levels(b[0] != 0, b[1] != 0);
    if (err != ESP_OK) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    return 0;
}

static int gatt_svr_access_prog_status(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                       void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        static const uint8_t zero;
        return os_mbuf_append(ctxt->om, &zero, 1) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int gatt_svr_access_notecard_req(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                        void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

#if CONFIG_REGATTAONE_NOTECARD_ENABLE
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_READ_NOT_PERMITTED;
    }
    uint16_t om_len = OS_MBUF_PKTLEN(ctxt->om);
    if (om_len == 0U || om_len > 512U) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    char buf[513];
    if (os_mbuf_copydata(ctxt->om, 0, om_len, buf) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    buf[om_len] = '\0';

    char *rsp = NULL;
    esp_err_t err = blues_notecard_transaction(buf, om_len, &rsp);
    if (err == ESP_OK && rsp != NULL) {
        size_t n = strlen(rsp);
        ble_sen0140_notecard_rsp_notify_chunk((const uint8_t *)rsp, n);
        free(rsp);
        return 0;
    }
    const char *fallback = "{\"err\":\"notecard_tx_failed\"}\n";
    ble_sen0140_notecard_rsp_notify_chunk((const uint8_t *)fallback, strlen(fallback));
    if (rsp) {
        free(rsp);
    }
    return 0;
#else
    (void)ctxt;
    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
#endif
}

static int gatt_svr_access_notecard_rsp(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                        void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int gatt_svr_access_uwb_line(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                    void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_svc_def s_gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_SVC_UUID),
        .characteristics =
            (struct ble_gatt_chr_def[]){
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_CHR_UUID),
                    .access_cb = gatt_svr_access_imu,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_chr_val_handle,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_UART_CHR_UUID),
                    .access_cb = gatt_svr_access_uart,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_uart_chr_val_handle,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_BSL_CHR_UUID),
                    .access_cb = gatt_svr_access_bsl,
                    .flags = BLE_GATT_CHR_F_WRITE,
                    .val_handle = &s_bsl_chr_val_handle,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_FW_CHR_UUID),
                    .access_cb = gatt_svr_access_fw,
                    .flags = BLE_GATT_CHR_F_WRITE,
                    .val_handle = &s_fw_chr_val_handle,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_PROG_STATUS_CHR_UUID),
                    .access_cb = gatt_svr_access_prog_status,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_prog_status_chr_val_handle,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_GPIO_CHR_UUID),
                    .access_cb = gatt_svr_access_gpio_levels,
                    .flags = BLE_GATT_CHR_F_WRITE,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_NOTECARD_REQ_UUID),
                    .access_cb = gatt_svr_access_notecard_req,
                    .flags = BLE_GATT_CHR_F_WRITE,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_NOTECARD_RSP_UUID),
                    .access_cb = gatt_svr_access_notecard_rsp,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_notecard_rsp_chr_val_handle,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_UWB_LINE_UUID),
                    .access_cb = gatt_svr_access_uwb_line,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_uwb_line_chr_val_handle,
                },
                {
                    0,
                },
            },
    },
    {
        0,
    },
};

static void gatt_svr_register_cb(struct ble_gatt_register_ctxt *ctxt, void *arg)
{
    (void)arg;
    char buf[BLE_UUID_STR_LEN];

    switch (ctxt->op) {
    case BLE_GATT_REGISTER_OP_SVC:
        ESP_LOGD(TAG, "registered service %s handle=%d", ble_uuid_to_str(ctxt->svc.svc_def->uuid, buf),
                 ctxt->svc.handle);
        break;
    case BLE_GATT_REGISTER_OP_CHR:
        ESP_LOGD(TAG, "characteristic %s val_handle=%d", ble_uuid_to_str(ctxt->chr.chr_def->uuid, buf),
                 ctxt->chr.val_handle);
        break;
    default:
        break;
    }
}

static int gatt_svr_init(void)
{
    int rc;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    rc = ble_gatts_count_cfg(s_gatt_svcs);
    if (rc != 0) {
        return rc;
    }
    rc = ble_gatts_add_svcs(s_gatt_svcs);
    return rc;
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;

    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        ESP_LOGI(TAG, "connect status=%d", event->connect.status);
        if (event->connect.status == 0) {
            s_conn_handle = event->connect.conn_handle;
        } else {
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            ble_advertise();
        }
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnect reason=%d", event->disconnect.reason);
        s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        s_notify_enabled = false;
        s_uart_notify_enabled = false;
        s_prog_notify_enabled = false;
        s_notecard_rsp_notify_enabled = false;
        s_uwb_line_notify_enabled = false;
        msp430_fw_upload_abort();
#if CONFIG_REGATTAONE_MSP430_ENABLE
        (void)msp430_uart_apply_config(115200, UART_PARITY_DISABLE);
        msp430_uart_flush_rx();
        msp430_uart_bridge_set_enabled(true);
#endif
        ble_advertise();
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        ble_advertise();
        return 0;

    case BLE_GAP_EVENT_SUBSCRIBE:
        ESP_LOGI(TAG, "subscribe attr=%u imu_chr=%u uart_chr=%u notify=%d",
                 (unsigned)event->subscribe.attr_handle, (unsigned)s_chr_val_handle,
                 (unsigned)s_uart_chr_val_handle, (int)event->subscribe.cur_notify);
        if (subscribe_attr_matches_chr(event->subscribe.attr_handle, s_chr_val_handle)) {
            s_notify_enabled = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "imu notify=%d", (int)s_notify_enabled);
        }
        if (subscribe_attr_matches_chr(event->subscribe.attr_handle, s_uart_chr_val_handle)) {
            s_uart_notify_enabled = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "uart notify=%d", (int)s_uart_notify_enabled);
        }
        if (subscribe_attr_matches_chr(event->subscribe.attr_handle, s_prog_status_chr_val_handle)) {
            s_prog_notify_enabled = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "prog status notify=%d", (int)s_prog_notify_enabled);
        }
        if (subscribe_attr_matches_chr(event->subscribe.attr_handle, s_notecard_rsp_chr_val_handle)) {
            s_notecard_rsp_notify_enabled = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "notecard rsp notify=%d", (int)s_notecard_rsp_notify_enabled);
        }
        if (subscribe_attr_matches_chr(event->subscribe.attr_handle, s_uwb_line_chr_val_handle)) {
            s_uwb_line_notify_enabled = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "uwb line notify=%d", (int)s_uwb_line_notify_enabled);
        }
        return 0;

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "mtu=%d", event->mtu.value);
        return 0;

    default:
        return 0;
    }
}

static void ble_advertise(void)
{
    struct ble_gap_adv_params adv_params;
    struct ble_hs_adv_fields fields;
    int rc;

    memset(&fields, 0, sizeof(fields));
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.tx_pwr_lvl_is_present = 1;
    fields.tx_pwr_lvl = BLE_HS_ADV_TX_PWR_LVL_AUTO;

    const char *name = "RegattaOne-Boat";
    fields.name = (uint8_t *)name;
    fields.name_len = strlen(name);
    fields.name_is_complete = 1;

    fields.uuids16 = (ble_uuid16_t[]){ BLE_UUID16_INIT(SEN0140_GATT_SVC_UUID) };
    fields.num_uuids16 = 1;
    fields.uuids16_is_complete = 1;

    rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_set_fields rc=%d", rc);
        return;
    }

    memset(&adv_params, 0, sizeof(adv_params));
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(s_ble_own_addr_type, NULL, BLE_HS_FOREVER, &adv_params, gap_event, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_start rc=%d", rc);
    } else {
        ESP_LOGI(TAG, "GAP advertising (connectable), name RegattaOne-Boat");
    }
}

static void on_reset(int reason)
{
    ESP_LOGE(TAG, "nimble reset reason=%d", reason);
}

static void on_sync(void)
{
    ESP_LOGI(TAG, "NimBLE stack sync — configuring identity & GAP advertise");
    int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) {
        ESP_LOGE(TAG, "ensure_addr rc=%d (BT controller / identity — check sdkconfig BT enabled)", rc);
        return;
    }
    rc = ble_hs_id_infer_auto(0, &s_ble_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "addr infer rc=%d", rc);
        return;
    }
    ble_advertise();
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

esp_err_t ble_sen0140_init(void)
{
    ESP_LOGI(TAG, "BLE: nimble_port_init…");
    esp_err_t ret = nimble_port_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init %s — is CONFIG_BT_ENABLED=y for this target?", esp_err_to_name(ret));
        return ret;
    }

    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.gatts_register_cb = gatt_svr_register_cb;

    int rc = gatt_svr_init();
    if (rc != 0) {
        ESP_LOGE(TAG, "gatt_svr_init rc=%d", rc);
        nimble_port_deinit();
        return ESP_FAIL;
    }

    rc = ble_svc_gap_device_name_set("RegattaOne-Boat");
    if (rc != 0) {
        ESP_LOGE(TAG, "device_name rc=%d", rc);
    }

    nimble_port_freertos_init(host_task);

    ble_sen0140_notify_mtx_init();

    ESP_LOGI(TAG, "NimBLE host task started — watch for \"stack sync\" then \"GAP advertising\"");
    ESP_LOGI(TAG,
             "NimBLE GATT (svc %04x imu %04x uart %04x bsl %04x fw %04x prog %04x gpio %04x nc_req %04x nc_rsp %04x uwb %04x)",
             SEN0140_GATT_SVC_UUID, SEN0140_GATT_CHR_UUID, SEN0140_GATT_UART_CHR_UUID,
             SEN0140_GATT_BSL_CHR_UUID, SEN0140_GATT_FW_CHR_UUID, SEN0140_GATT_PROG_STATUS_CHR_UUID,
             SEN0140_GATT_GPIO_CHR_UUID, SEN0140_GATT_NOTECARD_REQ_UUID, SEN0140_GATT_NOTECARD_RSP_UUID,
             SEN0140_GATT_UWB_LINE_UUID);
    return ESP_OK;
}

void ble_sen0140_prog_status_notify(const char *msg)
{
    if (!msg || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_prog_notify_enabled) {
        return;
    }

    size_t n = strlen(msg);
    if (n > 180) {
        n = 180;
    }

    ble_notify_take();
    struct os_mbuf *om = ble_hs_mbuf_from_flat(msg, (uint16_t)n);
    if (om) {
        int nrc = ble_gatts_notify_custom(s_conn_handle, s_prog_status_chr_val_handle, om);
        if (nrc != 0) {
            ESP_LOGW(TAG, "prog notify_custom rc=%d", nrc);
        }
    }
    ble_notify_give();
}

void ble_sen0140_uart_notify_chunk(const uint8_t *data, size_t len)
{
    if (!data || len == 0U || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_uart_notify_enabled) {
        return;
    }

    ble_notify_take();
    const uint8_t *p = data;
    while (len > 0U) {
        size_t chunk = len > SEN0140_BLE_UART_CHUNK_MAX ? SEN0140_BLE_UART_CHUNK_MAX : len;
        struct os_mbuf *om = ble_hs_mbuf_from_flat(p, (uint16_t)chunk);
        if (!om) {
            ESP_LOGW(TAG, "uart mbuf alloc failed");
            break;
        }
        int nrc = ble_gatts_notify_custom(s_conn_handle, s_uart_chr_val_handle, om);
        if (nrc != 0) {
            ESP_LOGW(TAG, "uart notify_custom rc=%d", nrc);
        }
        p += chunk;
        len -= chunk;
    }
    ble_notify_give();
}

void ble_sen0140_notify_if_active(const sen0140_sample_t *sample)
{
    if (!sample || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_notify_enabled) {
        return;
    }

    sen0140_ble_imu_pkt_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.version = SEN0140_BLE_VER;
    pkt.seq = s_seq++;

    const float deg2rad = (float)(M_PI / 180.0);
    if (sample->adxl_ok) {
        pkt.flags |= SEN0140_BLE_FLAG_ADXL;
        pkt.ax = sample->ax;
        pkt.ay = sample->ay;
        pkt.az = sample->az;
    }
    if (sample->itg_ok) {
        pkt.flags |= SEN0140_BLE_FLAG_ITG;
        pkt.gx = sample->gx * deg2rad;
        pkt.gy = sample->gy * deg2rad;
        pkt.gz = sample->gz * deg2rad;
    }
    if (sample->mag_ok) {
        pkt.flags |= SEN0140_BLE_FLAG_MAG;
        pkt.mx = sample->mx;
        pkt.my = sample->my;
        pkt.mz = sample->mz;
    }
    if (sample->baro_temp_ok) {
        pkt.flags |= SEN0140_BLE_FLAG_BARO_TEMP;
        pkt.temp_c = sample->temp_c;
    } else {
        pkt.temp_c = NAN;
    }
    if (sample->baro_press_ok) {
        pkt.flags |= SEN0140_BLE_FLAG_BARO_PRESS;
        pkt.press_hpa = sample->press_hpa;
    } else {
        pkt.press_hpa = NAN;
    }

    ble_notify_take();
    struct os_mbuf *om = ble_hs_mbuf_from_flat(&pkt, (uint16_t)sizeof(pkt));
    if (!om) {
        ESP_LOGW(TAG, "mbuf alloc failed");
        ble_notify_give();
        return;
    }

    int nrc = ble_gatts_notify_custom(s_conn_handle, s_chr_val_handle, om);
    ble_notify_give();
    if (nrc != 0) {
        ESP_LOGW(TAG, "notify_custom rc=%d", nrc);
    }
}

void ble_sen0140_notecard_rsp_notify_chunk(const uint8_t *data, size_t len)
{
    if (!data || len == 0U || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_notecard_rsp_notify_enabled) {
        return;
    }
    ble_notify_take();
    const uint8_t *p = data;
    while (len > 0U) {
        size_t chunk = len > SEN0140_BLE_UART_CHUNK_MAX ? SEN0140_BLE_UART_CHUNK_MAX : len;
        struct os_mbuf *om = ble_hs_mbuf_from_flat(p, (uint16_t)chunk);
        if (!om) {
            ESP_LOGW(TAG, "notecard rsp mbuf alloc failed");
            break;
        }
        int nrc = ble_gatts_notify_custom(s_conn_handle, s_notecard_rsp_chr_val_handle, om);
        if (nrc != 0) {
            ESP_LOGW(TAG, "notecard rsp notify rc=%d", nrc);
        }
        p += chunk;
        len -= chunk;
    }
    ble_notify_give();
}

void ble_sen0140_uwb_line_notify(const uint8_t *data, size_t len)
{
    if (!data || len == 0U || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_uwb_line_notify_enabled) {
        return;
    }
    ble_notify_take();
    const uint8_t *p = data;
    while (len > 0U) {
        size_t chunk = len > SEN0140_BLE_UART_CHUNK_MAX ? SEN0140_BLE_UART_CHUNK_MAX : len;
        struct os_mbuf *om = ble_hs_mbuf_from_flat(p, (uint16_t)chunk);
        if (!om) {
            ESP_LOGW(TAG, "uwb mbuf alloc failed");
            break;
        }
        int nrc = ble_gatts_notify_custom(s_conn_handle, s_uwb_line_chr_val_handle, om);
        if (nrc != 0) {
            ESP_LOGW(TAG, "uwb notify rc=%d", nrc);
        }
        p += chunk;
        len -= chunk;
    }
    ble_notify_give();
}
