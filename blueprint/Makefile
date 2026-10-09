# Blueprint trainer. No dependencies beyond a C++17 compiler and pthreads.
#   make            build bin/bp
#   make test       build and run the C++ test binary
#   make clean
CXX      ?= clang++
ARCH     ?= -march=native
CXXFLAGS ?= -O3 $(ARCH) -std=c++17 -Wall -Wextra -pthread
LIB_SRC  := src/eval.cpp src/abstraction.cpp src/tree.cpp src/export.cpp
HEADERS  := $(wildcard src/*.h)

all: bin/bp

bin/bp: $(LIB_SRC) src/main.cpp $(HEADERS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) src/main.cpp -o $@

bin/bp_tests: $(LIB_SRC) tests/test_main.cpp $(HEADERS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) tests/test_main.cpp -o $@

# --- PLAN.md M3 (compact trainer, src/compact.h): tests/test_scale.cpp ---
bin/bp_scale_tests: $(LIB_SRC) tests/test_scale.cpp $(HEADERS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) tests/test_scale.cpp -o $@

test-scale: bin/bp_scale_tests
	./bin/bp_scale_tests
# --- end M3 ---

test: bin/bp_tests bin/bp_scale_tests
	./bin/bp_tests
	./bin/bp_scale_tests

clean:
	rm -rf bin

.PHONY: all test test-scale clean
