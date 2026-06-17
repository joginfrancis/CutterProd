cmake_minimum_required(VERSION 3.13)

# Pull in Pico SDK
include($ENV{PICO_SDK_PATH}/pico_sdk_init.cmake)

project(urumicam_firmware C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

add_executable(urumicam_firmware
    main.c
    uart_protocol.c
    motion_planner.c
    quiescence.c
)

# Target RP2350 (Pico 2)
set(PICO_BOARD pico2)

target_link_libraries(urumicam_firmware
    pico_stdlib
    hardware_uart
    hardware_i2c
    hardware_gpio
)

# Enable USB output for debugging (optional)
pico_enable_stdio_usb(urumicam_firmware 0)
pico_enable_stdio_uart(urumicam_firmware 0)

# Generate UF2 file for flashing
pico_add_extra_outputs(urumicam_firmware)
