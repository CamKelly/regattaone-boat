#include "sc16is752.h"

#include "sdkconfig.h"

#if CONFIG_REGATTAONE_SC16IS752_ENABLE

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "i2c_bus_mux.h"
#include "sen0140_10dof.h"

static const char *TAG = "sc16is752";

#define SC16IS752_I2C_FREQ_HZ 100000
#define SC16IS752_XFER_TIMEOUT_MS 120

#define SC16IS752_REG_RHR 0x00U
#define SC16IS752_REG_THR 0x00U
#define SC16IS752_REG_IER 0x01U
#define SC16IS752_REG_FCR 0x02U
#define SC16IS752_REG_LCR 0x03U
#define SC16IS752_REG_MCR 0x04U
#define SC16IS752_REG_LSR 0x05U
#define SC16IS752_REG_TXLVL 0x08U
#define SC16IS752_REG_RXLVL 0x09U
#define SC16IS752_REG_IOCONTROL 0x0EU

#define SC16IS752_LCR_DLAB 0x80U
#define SC16IS752_LCR_8N1 0x03U
#define SC16IS752_FCR_FIFO_EN 0x01U
#define SC16IS752_FCR_RX_RST 0x02U
#define SC16IS752_FCR_TX_RST 0x04U
#define SC16IS752_IER_RX 0x01U
#define SC16IS752_LSR_DR 0x01U
#define SC16IS752_TX_FIFO_DEPTH 64U

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_dev;
static bool s_own_bus;
static bool s_ready;
static SemaphoreHandle_t s_rx_sem;

static uint8_t sc16is752_subaddr(uint8_t reg, sc16is752_channel_t ch)
{
    return (uint8_t)(((reg & 0x0FU) << 3) | (((uint8_t)ch & 0x03U) << 1));
}

static esp_err_t sc16is752_reg_write(sc16is752_channel_t ch, uint8_t reg, uint8_t val)
{
    const uint8_t buf[2] = { sc16is752_subaddr(reg, ch), val };
    return i2c_master_transmit(s_dev, buf, sizeof(buf), SC16IS752_XFER_TIMEOUT_MS);
}

static esp_err_t sc16is752_reg_read(sc16is752_channel_t ch, uint8_t reg, uint8_t *val)
{
    const uint8_t sub = sc16is752_subaddr(reg, ch);
    return i2c_master_transmit_receive(s_dev, &sub, 1, val, 1, SC16IS752_XFER_TIMEOUT_MS);
}

static void sc16is752_hw_reset(void)
{
#if CONFIG_SC16IS752_RESET_GPIO >= 0
    const gpio_num_t nrst = (gpio_num_t)CONFIG_SC16IS752_RESET_GPIO;
    const gpio_config_t io = {
        .pin_bit_mask = 1ULL << (unsigned)nrst,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io));
    gpio_set_level(nrst, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    ESP_LOGI(TAG, "RESET pulse GPIO%d (%ums low)", CONFIG_SC16IS752_RESET_GPIO,
             CONFIG_SC16IS752_RESET_PULSE_MS);
    gpio_set_level(nrst, 0);
    vTaskDelay(pdMS_TO_TICKS(CONFIG_SC16IS752_RESET_PULSE_MS));
    gpio_set_level(nrst, 1);
    vTaskDelay(pdMS_TO_TICKS(5));
#endif
}

static esp_err_t sc16is752_set_baud(sc16is752_channel_t ch, int baud)
{
    if (baud <= 0) {
        return ESP_ERR_INVALID_ARG;
    }

    const int64_t crystal = CONFIG_SC16IS752_CRYSTAL_HZ;
    const int64_t divisor_num = crystal;
    const int64_t divisor_den = (int64_t)baud * 16;
    int64_t divisor = (divisor_num + divisor_den - 1) / divisor_den;
    if (divisor < 1) {
        divisor = 1;
    }
    if (divisor > 0xFFFF) {
        divisor = 0xFFFF;
    }

    uint8_t mcr = 0;
    ESP_RETURN_ON_ERROR(sc16is752_reg_read(ch, SC16IS752_REG_MCR, &mcr), TAG, "MCR read");
    mcr &= (uint8_t) ~0x80U;
    ESP_RETURN_ON_ERROR(sc16is752_reg_write(ch, SC16IS752_REG_MCR, mcr), TAG, "MCR write");

    ESP_RETURN_ON_ERROR(sc16is752_reg_write(ch, SC16IS752_REG_LCR, SC16IS752_LCR_DLAB), TAG, "LCR DLAB");
    ESP_RETURN_ON_ERROR(sc16is752_reg_write(ch, SC16IS752_REG_RHR, (uint8_t)(divisor & 0xFF)), TAG, "DLL");
    ESP_RETURN_ON_ERROR(sc16is752_reg_write(ch, SC16IS752_REG_IER, (uint8_t)((divisor >> 8) & 0xFF)), TAG, "DLH");
    ESP_RETURN_ON_ERROR(sc16is752_reg_write(ch, SC16IS752_REG_LCR, SC16IS752_LCR_8N1), TAG, "LCR 8N1");

    ESP_LOGI(TAG, "ch %c: %d baud divisor=%lld crystal=%lld Hz", (ch == SC16IS752_CH_A) ? 'A' : 'B', baud,
             (long long)divisor, (long long)crystal);
    return ESP_OK;
}

static esp_err_t sc16is752_channel_init(sc16is752_channel_t ch, int baud)
{
    ESP_RETURN_ON_ERROR(sc16is752_reg_write(ch, SC16IS752_REG_FCR,
                                            SC16IS752_FCR_FIFO_EN | SC16IS752_FCR_RX_RST |
                                                SC16IS752_FCR_TX_RST),
                        TAG, "FCR reset");
    vTaskDelay(pdMS_TO_TICKS(2));

    ESP_RETURN_ON_ERROR(sc16is752_set_baud(ch, baud), TAG, "baud");

    ESP_RETURN_ON_ERROR(sc16is752_reg_write(ch, SC16IS752_REG_IER, SC16IS752_IER_RX), TAG, "IER");
    return ESP_OK;
}

static void sc16is752_irq_isr(void *arg)
{
    (void)arg;
    BaseType_t woken = pdFALSE;
    if (s_rx_sem != NULL) {
        xSemaphoreGiveFromISR(s_rx_sem, &woken);
        if (woken) {
            portYIELD_FROM_ISR();
        }
    }
}

static esp_err_t sc16is752_irq_init(void)
{
#if CONFIG_SC16IS752_IRQ_GPIO >= 0
    s_rx_sem = xSemaphoreCreateBinary();
    if (s_rx_sem == NULL) {
        return ESP_ERR_NO_MEM;
    }

    const gpio_num_t irq = (gpio_num_t)CONFIG_SC16IS752_IRQ_GPIO;
    const gpio_config_t io = {
        .pin_bit_mask = 1ULL << (unsigned)irq,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "IRQ gpio");
    const esp_err_t isr_err = gpio_install_isr_service(0);
    if (isr_err != ESP_OK && isr_err != ESP_ERR_INVALID_STATE) {
        return isr_err;
    }
    ESP_RETURN_ON_ERROR(gpio_isr_handler_add(irq, sc16is752_irq_isr, NULL), TAG, "isr add");
    ESP_LOGI(TAG, "IRQ on GPIO%d (active low)", CONFIG_SC16IS752_IRQ_GPIO);
#endif
    return ESP_OK;
}

static esp_err_t sc16is752_bus_attach(void)
{
#if CONFIG_SC16IS752_USE_SEN0140_I2C_PINS && CONFIG_REGATTAONE_SEN0140_ENABLE
    s_bus = (i2c_master_bus_handle_t)sen0140_i2c_bus_handle();
    if (s_bus == NULL) {
        ESP_LOGE(TAG, "SEN0140 I2C bus not ready — init IMU first or disable shared bus");
        return ESP_ERR_INVALID_STATE;
    }
    s_own_bus = false;
    ESP_LOGI(TAG, "I2C shared with SEN0140 SDA=GPIO%d SCL=GPIO%d", SEN0140_I2C_SDA_GPIO,
             SEN0140_I2C_SCL_GPIO);
#else
    const int sda =
#if CONFIG_SC16IS752_USE_SEN0140_I2C_PINS
        SEN0140_I2C_SDA_GPIO;
    const int scl = SEN0140_I2C_SCL_GPIO;
#else
        CONFIG_SC16IS752_I2C_SDA_GPIO;
    const int scl = CONFIG_SC16IS752_I2C_SCL_GPIO;
#endif
    i2c_master_bus_config_t bus_cfg = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = I2C_NUM_0,
        .scl_io_num = scl,
        .sda_io_num = sda,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_cfg, &s_bus), TAG, "i2c bus");
    s_own_bus = true;
    vTaskDelay(pdMS_TO_TICKS(50));
    ESP_LOGI(TAG, "I2C bus new: SDA=GPIO%d SCL=GPIO%d", sda, scl);
#endif

    const i2c_device_config_t dev_cfg = {
        .device_address = CONFIG_SC16IS752_I2C_ADDR,
        .scl_speed_hz = SC16IS752_I2C_FREQ_HZ,
    };
    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(s_bus, &dev_cfg, &s_dev), TAG, "add dev");

    esp_err_t probe = i2c_master_probe(s_bus, CONFIG_SC16IS752_I2C_ADDR, SC16IS752_XFER_TIMEOUT_MS);
    ESP_LOGI(TAG, "I2C probe 0x%02x → %s", CONFIG_SC16IS752_I2C_ADDR, esp_err_to_name(probe));
    if (probe != ESP_OK) {
        return probe;
    }
    return ESP_OK;
}

esp_err_t sc16is752_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    ESP_RETURN_ON_ERROR(sc16is752_bus_attach(), TAG, "bus");

    sc16is752_hw_reset();

    ESP_RETURN_ON_ERROR(sc16is752_irq_init(), TAG, "irq");

    i2c_bus_mux_lock();
    esp_err_t err = sc16is752_channel_init(SC16IS752_CH_A, CONFIG_SC16IS752_CH_A_BAUD);
#if defined(CONFIG_SC16IS752_CH_B_ENABLE) && CONFIG_SC16IS752_CH_B_ENABLE
    if (err == ESP_OK) {
        err = sc16is752_channel_init(SC16IS752_CH_B, CONFIG_SC16IS752_CH_B_BAUD);
    }
#endif
    i2c_bus_mux_unlock();

    if (err != ESP_OK) {
        return err;
    }

    s_ready = true;
#if defined(CONFIG_SC16IS752_CH_B_ENABLE) && CONFIG_SC16IS752_CH_B_ENABLE
    ESP_LOGI(TAG, "ready @ I2C 0x%02x crystal=%d Hz chA=%d chB=%d baud", CONFIG_SC16IS752_I2C_ADDR,
             CONFIG_SC16IS752_CRYSTAL_HZ, CONFIG_SC16IS752_CH_A_BAUD, CONFIG_SC16IS752_CH_B_BAUD);
#else
    ESP_LOGI(TAG, "ready @ I2C 0x%02x crystal=%d Hz chA=%d baud (ch B disabled)",
             CONFIG_SC16IS752_I2C_ADDR, CONFIG_SC16IS752_CRYSTAL_HZ, CONFIG_SC16IS752_CH_A_BAUD);
#endif
    return ESP_OK;
}

void sc16is752_wait_rx(TickType_t timeout)
{
#if CONFIG_SC16IS752_IRQ_GPIO >= 0
    if (s_rx_sem != NULL) {
        (void)xSemaphoreTake(s_rx_sem, timeout);
        return;
    }
#endif
    vTaskDelay(timeout);
}

size_t sc16is752_read(sc16is752_channel_t ch, uint8_t *buf, size_t max)
{
    if (!s_ready || buf == NULL || max == 0U) {
        return 0U;
    }

    uint8_t rxlvl = 0;
    if (sc16is752_reg_read(ch, SC16IS752_REG_RXLVL, &rxlvl) != ESP_OK || rxlvl == 0U) {
        return 0U;
    }

    size_t n = rxlvl;
    if (n > max) {
        n = max;
    }
    if (n > SC16IS752_TX_FIFO_DEPTH) {
        n = SC16IS752_TX_FIFO_DEPTH;
    }

    size_t got = 0;
    for (size_t i = 0; i < n; i++) {
        uint8_t b = 0;
        if (sc16is752_reg_read(ch, SC16IS752_REG_RHR, &b) != ESP_OK) {
            break;
        }
        buf[got++] = b;
    }
    return got;
}

esp_err_t sc16is752_write(sc16is752_channel_t ch, const uint8_t *data, size_t len)
{
    if (!s_ready || data == NULL || len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    for (size_t i = 0; i < len; i++) {
        uint8_t txlvl = 0;
        int spins = 0;
        while (sc16is752_reg_read(ch, SC16IS752_REG_TXLVL, &txlvl) == ESP_OK && txlvl == 0U &&
               spins < 200) {
            vTaskDelay(pdMS_TO_TICKS(1));
            spins++;
        }
        if (txlvl == 0U) {
            ESP_LOGW(TAG, "ch %c TX FIFO full", (ch == SC16IS752_CH_A) ? 'A' : 'B');
            return ESP_ERR_TIMEOUT;
        }
        ESP_RETURN_ON_ERROR(sc16is752_reg_write(ch, SC16IS752_REG_THR, data[i]), TAG, "THR");
    }
    return ESP_OK;
}

bool sc16is752_ready(void)
{
    return s_ready;
}

#else

esp_err_t sc16is752_init(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

void sc16is752_wait_rx(TickType_t timeout)
{
    (void)timeout;
}

size_t sc16is752_read(sc16is752_channel_t ch, uint8_t *buf, size_t max)
{
    (void)ch;
    (void)buf;
    (void)max;
    return 0U;
}

esp_err_t sc16is752_write(sc16is752_channel_t ch, const uint8_t *data, size_t len)
{
    (void)ch;
    (void)data;
    (void)len;
    return ESP_ERR_NOT_SUPPORTED;
}

bool sc16is752_ready(void)
{
    return false;
}

#endif
