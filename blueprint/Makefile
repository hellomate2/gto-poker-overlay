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

test: bin/bp_tests
	./bin/bp_tests

# ---- AIVAT tests (tests/test_aivat.cpp) ----
bin/aivat_tests: $(LIB_SRC) tests/test_aivat.cpp $(HEADERS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) tests/test_aivat.cpp -o $@

test-aivat: bin/aivat_tests
	./bin/aivat_tests
# ---- end AIVAT tests ----

clean:
	rm -rf bin

.PHONY: all test test-aivat clean
