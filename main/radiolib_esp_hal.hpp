#pragma once

#include "Hal.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal/gpio_hal.h"

#define RADIOLIB_ESP_NOP() asm volatile("nop")

static void IRAM_ATTR radiolib_isr_trampoline(void *radiolib_func)
{
    auto callback = reinterpret_cast<void (*)(void)>(radiolib_func);
    if (callback != nullptr) {
        callback();
    }
}

/** ESP-IDF SPI master HAL for RadioLib (ESP32 / ESP32-S3 / ESP32-C3). */
class EspHal : public RadioLibHal {
 public:
    EspHal(int8_t sck, int8_t miso, int8_t mosi, spi_host_device_t host, uint32_t spi_clock_hz)
        : RadioLibHal(GPIO_MODE_INPUT, GPIO_MODE_OUTPUT, 0, 1, GPIO_INTR_POSEDGE, GPIO_INTR_NEGEDGE),
          spi_sck_(sck),
          spi_miso_(miso),
          spi_mosi_(mosi),
          host_(host),
          spi_clock_hz_(spi_clock_hz)
    {
    }

    void init() override { spiBegin(); }

    void term() override { spiEnd(); }

    void pinMode(uint32_t pin, uint32_t mode) override
    {
        if (pin == RADIOLIB_NC) {
            return;
        }

        gpio_hal_context_t gpiohal;
        gpiohal.dev = GPIO_LL_GET_HW(GPIO_PORT_0);

        gpio_config_t conf = {
            .pin_bit_mask = (1ULL << pin),
            .mode = (gpio_mode_t)mode,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = (gpio_int_type_t)gpiohal.dev->pin[pin].int_type,
        };
        gpio_config(&conf);
    }

    void digitalWrite(uint32_t pin, uint32_t value) override
    {
        if (pin == RADIOLIB_NC) {
            return;
        }
        gpio_set_level((gpio_num_t)pin, value);
    }

    uint32_t digitalRead(uint32_t pin) override
    {
        if (pin == RADIOLIB_NC) {
            return 0;
        }
        return gpio_get_level((gpio_num_t)pin);
    }

    void attachInterrupt(uint32_t interrupt_num, void (*interrupt_cb)(void), uint32_t mode) override
    {
        if (interrupt_num == RADIOLIB_NC) {
            return;
        }

        if (!isr_service_installed_) {
            gpio_install_isr_service((int)ESP_INTR_FLAG_IRAM);
            isr_service_installed_ = true;
        }

        gpio_set_intr_type((gpio_num_t)interrupt_num, (gpio_int_type_t)(mode & 0x7));
        gpio_isr_handler_add((gpio_num_t)interrupt_num, radiolib_isr_trampoline,
                             reinterpret_cast<void *>(interrupt_cb));
    }

    void detachInterrupt(uint32_t interrupt_num) override
    {
        if (interrupt_num == RADIOLIB_NC) {
            return;
        }
        gpio_isr_handler_remove((gpio_num_t)interrupt_num);
        gpio_wakeup_disable((gpio_num_t)interrupt_num);
        gpio_set_intr_type((gpio_num_t)interrupt_num, GPIO_INTR_DISABLE);
    }

    void delay(unsigned long ms) override { vTaskDelay(pdMS_TO_TICKS(ms)); }

    void delayMicroseconds(unsigned long us) override
    {
        const uint64_t start = esp_timer_get_time();
        const uint64_t end = start + us;
        if (us == 0) {
            return;
        }
        if (start > end) {
            while ((uint64_t)esp_timer_get_time() > end) {
                RADIOLIB_ESP_NOP();
            }
        }
        while ((uint64_t)esp_timer_get_time() < end) {
            RADIOLIB_ESP_NOP();
        }
    }

    unsigned long millis() override { return (unsigned long)(esp_timer_get_time() / 1000ULL); }

    unsigned long micros() override { return (unsigned long)esp_timer_get_time(); }

    long pulseIn(uint32_t pin, uint32_t state, unsigned long timeout) override
    {
        if (pin == RADIOLIB_NC) {
            return 0;
        }

        pinMode(pin, GPIO_MODE_INPUT);
        const uint32_t start = micros();
        const uint32_t deadline = start + timeout;

        while (digitalRead(pin) == state) {
            if ((micros() - start) > timeout) {
                return 0;
            }
            (void)deadline;
        }
        return (long)(micros() - start);
    }

    void spiBegin() override
    {
        if (spi_initialized_) {
            return;
        }

        spi_bus_config_t buscfg = {};
        buscfg.mosi_io_num = spi_mosi_;
        buscfg.miso_io_num = spi_miso_;
        buscfg.sclk_io_num = spi_sck_;
        buscfg.quadwp_io_num = -1;
        buscfg.quadhd_io_num = -1;
        buscfg.max_transfer_sz = 0;

        spi_device_interface_config_t devcfg = {};
        devcfg.mode = 0;
        devcfg.clock_speed_hz = (int)spi_clock_hz_;
        devcfg.spics_io_num = -1;
        devcfg.queue_size = 1;

        ESP_ERROR_CHECK(spi_bus_initialize(host_, &buscfg, SPI_DMA_CH_AUTO));
        ESP_ERROR_CHECK(spi_bus_add_device(host_, &devcfg, &spi_dev_));
        spi_initialized_ = true;
    }

    void spiBeginTransaction() override {}

    void spiTransfer(uint8_t *out, size_t len, uint8_t *in) override
    {
        spi_transaction_t trans = {};
        trans.length = 8 * len;
        trans.tx_buffer = out;
        trans.rx_buffer = in;
        ESP_ERROR_CHECK(spi_device_transmit(spi_dev_, &trans));
    }

    void spiEndTransaction() override {}

    void spiEnd() override
    {
        if (!spi_initialized_) {
            return;
        }
        spi_bus_remove_device(spi_dev_);
        spi_bus_free(host_);
        spi_initialized_ = false;
    }

 private:
    int8_t spi_sck_;
    int8_t spi_miso_;
    int8_t spi_mosi_;
    spi_host_device_t host_;
    uint32_t spi_clock_hz_;
    spi_device_handle_t spi_dev_ = nullptr;
    bool spi_initialized_ = false;
    static inline bool isr_service_installed_ = false;
};
