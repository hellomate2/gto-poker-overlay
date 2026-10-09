# Blueprint trainer. No dependencies beyond a C++17 compiler and pthreads.
#   make            build bin/bp
#   make test       build and run the C++ test binary
#   make clean
CXX      ?= clang++
ARCH     ?= -march=native
CXXFLAGS ?= -O3 $(ARCH) -std=c++17 -Wall -Wextra -pthread
LIB_SRC  := src/eval.cpp src/abstraction.cpp src/tree.cpp src/export.cpp src/subgame.cpp src/search.cpp
HEADERS  := $(wildcard src/*.h)

all: bin/bp

bin/bp: $(LIB_SRC) src/main.cpp $(HEADERS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) src/main.cpp -o $@

bin/bp_tests: $(LIB_SRC) tests/test_main.cpp $(HEADERS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) tests/test_main.cpp -o $@

test: bin/bp_tests
	./bin/bp_tests

# Real-time search tests (PLAN.md M4/M5): toy closed forms, brute-force
# showdowns, Leduc against ExactEval. `make test-rt`
bin/rt_tests: $(LIB_SRC) tests/test_rt.cpp $(HEADERS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) tests/test_rt.cpp -o $@

test-rt: bin/rt_tests
	./bin/rt_tests

clean:
	rm -rf bin

.PHONY: all test test-rt clean
