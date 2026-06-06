# The following lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.22)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(regattaone-laser)

# RadioLib triggers -Werror=overloaded-virtual under ESP-IDF GCC 15 (SX126x/LR11x0 overloads).
idf_component_get_property(radiolib_lib RadioLib COMPONENT_LIB)
target_compile_options(${radiolib_lib} PRIVATE "-Wno-error=overloaded-virtual")
