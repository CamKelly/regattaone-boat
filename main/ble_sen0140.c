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
#include "boat_id.h"
#include "device_type.h"
#if CONFIG_REGATTAONE_RYUW122_ENABLE
#include "ryuw122_uart.h"
#endif
#if CONFIG_REGATTAONE_SX1262_ENABLE
#include "lora_mesh.h"
#include "lora_stats.h"
#include "sx1262_lora.h"
#endif

static const char *TAG = "ble_sen0140";

/** 16-bit UUIDs (full: 0000XXXX-0000-1000-8000-00805f9b34fb). */
#define SEN0140_GATT_SVC_UUID      0xfef0
#define SEN0140_GATT_CHR_UUID      0xfef1
#define SEN0140_GATT_LORA_TX_UUID        0xfef7
#define SEN0140_GATT_LORA_LINE_UUID      0xfef8
#define SEN0140_GATT_GPS_LINE_UUID       0xfefd
#define SEN0140_GATT_UWB_LINE_UUID      0xfef9
/** Write: UTF-8 AT command (CRLF appended if missing); response lines on FEF9 notify. */
#define SEN0140_GATT_UWB_AT_UUID        0xfefa
/** Read/write: user-assigned boat id (UTF-8, max 32 chars, persisted in NVS). */
#define SEN0140_GATT_BOAT_ID_UUID       0xfefb
/** Read/write: device type — port | starboard | fixed_dgps_mark | waypoint | boat. */
#define SEN0140_GATT_DEVICE_TYPE_UUID     0xfefc
/** Read: LoRa stats JSON. Write: `stream=1` / `stream=0`. Notify: JSON on change. */
#define SEN0140_GATT_LORA_STATS_UUID      0xfefe

/** Max payload per notify (ATT MTU typically 23–247 after negotiation). */
#define SEN0140_BLE_UART_CHUNK_MAX 200U
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
static uint16_t s_lora_line_chr_val_handle;
static uint16_t s_lora_stats_chr_val_handle;
static bool s_lora_stats_notify_enabled;
static uint16_t s_gps_line_chr_val_handle;
static uint16_t s_uwb_line_chr_val_handle;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static bool s_notify_enabled;
static bool s_lora_line_notify_enabled;
static char s_lora_stats_json[8192];
static bool s_gps_line_notify_enabled;
static bool s_uwb_line_notify_enabled;
static uint16_t s_seq;

#if CONFIG_REGATTAONE_RYUW122_ENABLE
#define UWB_LINE_BUF_MAX 384U
static char s_uwb_line_buf[UWB_LINE_BUF_MAX];
static size_t s_uwb_line_len;

static void uwb_line_store(const uint8_t *data, size_t len)
{
    if (!data || len == 0U) {
        return;
    }
    if (s_uwb_line_len > 0U && s_uwb_line_len < (UWB_LINE_BUF_MAX - 1U)) {
        s_uwb_line_buf[s_uwb_line_len++] = '\n';
    }
    size_t room = UWB_LINE_BUF_MAX - 1U - s_uwb_line_len;
    size_t n = len < room ? len : room;
    memcpy(s_uwb_line_buf + s_uwb_line_len, data, n);
    s_uwb_line_len += n;
    s_uwb_line_buf[s_uwb_line_len] = '\0';
}
#endif

#if CONFIG_REGATTAONE_SX1262_ENABLE
#define LORA_LINE_BUF_MAX 384U
static char s_lora_line_buf[LORA_LINE_BUF_MAX];
static size_t s_lora_line_len;

static void lora_line_store(const uint8_t *data, size_t len)
{
    if (!data || len == 0U) {
        return;
    }
    size_t room = LORA_LINE_BUF_MAX - 1U - s_lora_line_len;
    size_t n = len < room ? len : room;
    memcpy(s_lora_line_buf + s_lora_line_len, data, n);
    s_lora_line_len += n;
    s_lora_line_buf[s_lora_line_len] = '\0';
}
#endif

#if CONFIG_REGATTAONE_GPS_ENABLE
#define GPS_LINE_BUF_MAX 384U
static char s_gps_line_buf[GPS_LINE_BUF_MAX];
static size_t s_gps_line_len;

static void gps_line_store(const uint8_t *data, size_t len)
{
    if (!data || len == 0U) {
        s_gps_line_len = 0U;
        s_gps_line_buf[0] = '\0';
        return;
    }
    size_t n = len < (GPS_LINE_BUF_MAX - 1U) ? len : (GPS_LINE_BUF_MAX - 1U);
    memcpy(s_gps_line_buf, data, n);
    s_gps_line_buf[n] = '\0';
    s_gps_line_len = n;
}
#endif

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
static void ble_apply_gap_name(void);

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

static int gatt_svr_access_boat_id(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                   void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const char *id = boat_id_get();
        size_t n = strlen(id);
        if (n == 0U) {
            return 0;
        }
        return os_mbuf_append(ctxt->om, id, (uint16_t)n) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint16_t om_len = OS_MBUF_PKTLEN(ctxt->om);
        if (om_len > BOAT_ID_MAX_LEN) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        char buf[BOAT_ID_MAX_LEN + 1U];
        if (om_len > 0U) {
            if (os_mbuf_copydata(ctxt->om, 0, om_len, buf) != 0) {
                return BLE_ATT_ERR_UNLIKELY;
            }
        }
        buf[om_len] = '\0';
        if (boat_id_set(buf, om_len) != ESP_OK) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        ble_apply_gap_name();
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int gatt_svr_access_device_type(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                       void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const char *type = device_type_to_string(device_type_get());
        size_t n = strlen(type);
        return os_mbuf_append(ctxt->om, type, (uint16_t)n) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint16_t om_len = OS_MBUF_PKTLEN(ctxt->om);
        if (om_len > DEVICE_TYPE_STR_MAX) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        char buf[DEVICE_TYPE_STR_MAX + 1U];
        if (om_len > 0U) {
            if (os_mbuf_copydata(ctxt->om, 0, om_len, buf) != 0) {
                return BLE_ATT_ERR_UNLIKELY;
            }
        }
        buf[om_len] = '\0';
        device_type_t type;
        if (!device_type_from_string(buf, om_len, &type)) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        if (device_type_set(type) != ESP_OK) {
            return BLE_ATT_ERR_UNLIKELY;
        }
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static void ble_apply_gap_name(void)
{
    const char *name = boat_id_ble_name();
    int rc = ble_svc_gap_device_name_set(name);
    if (rc != 0) {
        ESP_LOGW(TAG, "gap device_name_set rc=%d", rc);
    }
    if (s_conn_handle == BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_adv_stop();
        ble_advertise();
    }
}

#if CONFIG_REGATTAONE_SX1262_ENABLE
static int gatt_svr_access_lora_tx(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                   void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_READ_NOT_PERMITTED;
    }
    uint16_t om_len = OS_MBUF_PKTLEN(ctxt->om);
    if (om_len == 0U || om_len > 255U) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    uint8_t buf[256];
    if (os_mbuf_copydata(ctxt->om, 0, om_len, buf) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (lora_mesh_active()) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    s_lora_line_len = 0U;
    s_lora_line_buf[0] = '\0';
    esp_err_t err = sx1262_lora_transmit(buf, om_len);
    if (err == ESP_OK) {
        return 0;
    }
    if (err == ESP_ERR_NO_MEM || err == ESP_ERR_INVALID_STATE) {
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int gatt_svr_access_lora_stats(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                      void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const size_t n = lora_stats_format_json(s_lora_stats_json, sizeof(s_lora_stats_json));
        if (n == 0U) {
            return 0;
        }
        return os_mbuf_append(ctxt->om, s_lora_stats_json, (uint16_t)n) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }

    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint16_t om_len = OS_MBUF_PKTLEN(ctxt->om);
        if (om_len == 0U || om_len > 32U) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        char buf[33];
        if (os_mbuf_copydata(ctxt->om, 0, om_len, buf) != 0) {
            return BLE_ATT_ERR_UNLIKELY;
        }
        buf[om_len] = '\0';
        if (strncmp(buf, "stream=1", 8) == 0) {
            if (lora_mesh_active()) {
                return BLE_ATT_ERR_UNLIKELY;
            }
            lora_stats_set_stream_active(true);
            lora_stats_request_notify();
            return 0;
        }
        if (strncmp(buf, "stream=0", 8) == 0) {
            lora_stats_set_stream_active(false);
            lora_stats_request_notify();
            return 0;
        }
        if (strncmp(buf, "mesh=1", 6) == 0) {
            lora_stats_set_stream_active(false);
            lora_mesh_set_active(true);
            return 0;
        }
        if (strncmp(buf, "mesh=0", 6) == 0) {
            lora_mesh_set_active(false);
            lora_stats_request_notify();
            return 0;
        }
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    return BLE_ATT_ERR_READ_NOT_PERMITTED;
}

static int gatt_svr_access_lora_line(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                     void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        if (s_lora_line_len > 0U) {
            return os_mbuf_append(ctxt->om, s_lora_line_buf, (uint16_t)s_lora_line_len) == 0 ? 0
                                                                                                : BLE_ATT_ERR_INSUFFICIENT_RES;
        }
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}
#endif

#if CONFIG_REGATTAONE_GPS_ENABLE
static int gatt_svr_access_gps_line(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                    void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        if (s_gps_line_len > 0U) {
            return os_mbuf_append(ctxt->om, s_gps_line_buf, (uint16_t)s_gps_line_len) == 0 ? 0
                                                                                            : BLE_ATT_ERR_INSUFFICIENT_RES;
        }
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}
#endif

static int gatt_svr_access_uwb_line(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                    void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
#if CONFIG_REGATTAONE_RYUW122_ENABLE
        if (s_uwb_line_len > 0U) {
            return os_mbuf_append(ctxt->om, s_uwb_line_buf, (uint16_t)s_uwb_line_len) == 0 ? 0
                                                                                             : BLE_ATT_ERR_INSUFFICIENT_RES;
        }
#endif
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int gatt_svr_access_uwb_at(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt,
                                  void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

#if CONFIG_REGATTAONE_RYUW122_ENABLE
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_READ_NOT_PERMITTED;
    }
    uint16_t om_len = OS_MBUF_PKTLEN(ctxt->om);
    if (om_len == 0U || om_len > 256U) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    uint8_t buf[260];
    if (os_mbuf_copydata(ctxt->om, 0, om_len, buf) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    size_t n = om_len;
    if (n < 2U || buf[n - 2U] != '\r' || buf[n - 1U] != '\n') {
        if (n >= sizeof(buf) - 2U) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        if (n > 0U && buf[n - 1U] == '\n') {
            buf[n - 1U] = '\r';
            buf[n++] = '\n';
        } else {
            buf[n++] = '\r';
            buf[n++] = '\n';
        }
    }
    s_uwb_line_len = 0U;
    s_uwb_line_buf[0] = '\0';
    esp_err_t err = ryuw122_uart_queue_ble_at(buf, n);
    return (err == ESP_OK) ? 0 : BLE_ATT_ERR_UNLIKELY;
#else
    (void)ctxt;
    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
#endif
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
#if CONFIG_REGATTAONE_SX1262_ENABLE
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_LORA_TX_UUID),
                    .access_cb = gatt_svr_access_lora_tx,
                    .flags = BLE_GATT_CHR_F_WRITE,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_LORA_LINE_UUID),
                    .access_cb = gatt_svr_access_lora_line,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_lora_line_chr_val_handle,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_LORA_STATS_UUID),
                    .access_cb = gatt_svr_access_lora_stats,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_lora_stats_chr_val_handle,
                },
#endif
#if CONFIG_REGATTAONE_GPS_ENABLE
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_GPS_LINE_UUID),
                    .access_cb = gatt_svr_access_gps_line,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_gps_line_chr_val_handle,
                },
#endif
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_UWB_LINE_UUID),
                    .access_cb = gatt_svr_access_uwb_line,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_uwb_line_chr_val_handle,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_UWB_AT_UUID),
                    .access_cb = gatt_svr_access_uwb_at,
                    .flags = BLE_GATT_CHR_F_WRITE,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_BOAT_ID_UUID),
                    .access_cb = gatt_svr_access_boat_id,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE,
                },
                {
                    .uuid = BLE_UUID16_DECLARE(SEN0140_GATT_DEVICE_TYPE_UUID),
                    .access_cb = gatt_svr_access_device_type,
                    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE,
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
        s_lora_line_notify_enabled = false;
        s_lora_stats_notify_enabled = false;
        s_gps_line_notify_enabled = false;
        s_uwb_line_notify_enabled = false;
        ble_advertise();
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        ble_advertise();
        return 0;

    case BLE_GAP_EVENT_SUBSCRIBE:
        ESP_LOGI(TAG, "subscribe attr=%u imu_chr=%u notify=%d",
                 (unsigned)event->subscribe.attr_handle, (unsigned)s_chr_val_handle,
                 (int)event->subscribe.cur_notify);
        if (subscribe_attr_matches_chr(event->subscribe.attr_handle, s_chr_val_handle)) {
            s_notify_enabled = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "imu notify=%d", (int)s_notify_enabled);
        }
        if (subscribe_attr_matches_chr(event->subscribe.attr_handle, s_lora_line_chr_val_handle)) {
            s_lora_line_notify_enabled = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "lora line notify=%d", (int)s_lora_line_notify_enabled);
#if CONFIG_REGATTAONE_SX1262_ENABLE
            if (s_lora_line_notify_enabled) {
                sx1262_lora_on_line_notify_subscribed();
            }
#endif
        }
        if (subscribe_attr_matches_chr(event->subscribe.attr_handle, s_lora_stats_chr_val_handle)) {
            s_lora_stats_notify_enabled = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "lora stats notify=%d", (int)s_lora_stats_notify_enabled);
#if CONFIG_REGATTAONE_SX1262_ENABLE
            if (s_lora_stats_notify_enabled) {
                const size_t n = lora_stats_format_json(s_lora_stats_json, sizeof(s_lora_stats_json));
                if (n > 0U) {
                    ble_sen0140_lora_stats_notify((const uint8_t *)s_lora_stats_json, n);
                }
            }
#endif
        }
        if (subscribe_attr_matches_chr(event->subscribe.attr_handle, s_gps_line_chr_val_handle)) {
            s_gps_line_notify_enabled = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "gps line notify=%d", (int)s_gps_line_notify_enabled);
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

    const char *name = boat_id_ble_name();
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
        ESP_LOGI(TAG, "GAP advertising (connectable), name %s", name);
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

    rc = ble_svc_gap_device_name_set(boat_id_ble_name());
    if (rc != 0) {
        ESP_LOGE(TAG, "device_name rc=%d", rc);
    }

    nimble_port_freertos_init(host_task);

    ble_sen0140_notify_mtx_init();

    ESP_LOGI(TAG, "NimBLE host task started — watch for \"stack sync\" then \"GAP advertising\"");
    ESP_LOGI(TAG,
             "NimBLE GATT (svc %04x imu %04x lora_tx %04x lora_rx %04x lora_stats %04x gps %04x uwb %04x uwb_at %04x)",
             SEN0140_GATT_SVC_UUID, SEN0140_GATT_CHR_UUID, SEN0140_GATT_LORA_TX_UUID,
             SEN0140_GATT_LORA_LINE_UUID, SEN0140_GATT_LORA_STATS_UUID, SEN0140_GATT_GPS_LINE_UUID,
             SEN0140_GATT_UWB_LINE_UUID, SEN0140_GATT_UWB_AT_UUID);
    return ESP_OK;
}

void ble_sen0140_notify_if_active(const sen0140_sample_t *sample)
{
    if (!sample || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_notify_enabled) {
        return;
    }

    /* Comms responses share the NimBLE mbuf pool — throttle IMU while line notifies are on. */
    static TickType_t s_last_imu_notify;
    if (s_uwb_line_notify_enabled || s_lora_line_notify_enabled || s_gps_line_notify_enabled) {
        const TickType_t now = xTaskGetTickCount();
        if (now - s_last_imu_notify < pdMS_TO_TICKS(200)) {
            return;
        }
        s_last_imu_notify = now;
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

static void ble_line_notify(uint16_t chr_val_handle, bool notify_enabled, const uint8_t *data, size_t len)
{
    if (s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !notify_enabled) {
        return;
    }
    ble_notify_take();
    const uint8_t *p = data;
    while (len > 0U) {
        size_t chunk = len > SEN0140_BLE_UART_CHUNK_MAX ? SEN0140_BLE_UART_CHUNK_MAX : len;
        struct os_mbuf *om = ble_hs_mbuf_from_flat(p, (uint16_t)chunk);
        if (!om) {
            break;
        }
        int nrc = ble_gatts_notify_custom(s_conn_handle, chr_val_handle, om);
        if (nrc != 0) {
            ESP_LOGW(TAG, "line notify rc=%d", nrc);
        }
        p += chunk;
        len -= chunk;
    }
    ble_notify_give();
}

void ble_sen0140_lora_line_notify(const uint8_t *data, size_t len)
{
    if (!data || len == 0U) {
        return;
    }
#if CONFIG_REGATTAONE_SX1262_ENABLE
    lora_line_store(data, len);
#endif
    ble_line_notify(s_lora_line_chr_val_handle, s_lora_line_notify_enabled, data, len);
}

void ble_sen0140_lora_stats_notify(const uint8_t *data, size_t len)
{
    if (!data || len == 0U) {
        return;
    }
    ble_line_notify(s_lora_stats_chr_val_handle, s_lora_stats_notify_enabled, data, len);
}

void ble_sen0140_gps_line_notify(const uint8_t *data, size_t len)
{
    if (!data || len == 0U) {
        return;
    }
#if CONFIG_REGATTAONE_GPS_ENABLE
    gps_line_store(data, len);
    ble_line_notify(s_gps_line_chr_val_handle, s_gps_line_notify_enabled, data, len);
#endif
}

void ble_sen0140_uwb_line_notify(const uint8_t *data, size_t len)
{
    if (!data || len == 0U) {
        return;
    }
#if CONFIG_REGATTAONE_RYUW122_ENABLE
    uwb_line_store(data, len);
#endif
    if (s_conn_handle == BLE_HS_CONN_HANDLE_NONE || !s_uwb_line_notify_enabled) {
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
