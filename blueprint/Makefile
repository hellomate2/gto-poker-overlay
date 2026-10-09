# Blueprint trainer. No dependencies beyond a C++17 compiler and pthreads.
#   make            build bin/bp
#   make test       build and run the C++ test binary
#   make clean
CXX      ?= clang++
ARCH     ?= -march=native
CXXFLAGS ?= -O3 $(ARCH) -std=c++17 -Wall -Wextra -pthread
LIB_SRC  := src/eval.cpp src/abstraction.cpp src/tree.cpp src/export.cpp
HEADERS  := $(wildcard src/*.h)
# ---- abstraction v2 (PLAN.md M2): Waugh hand isomorphism (vendored C, BSD-style
# license in third_party/hand-isomorphism/LICENSE.txt), potential-aware flop, OCHS river
LIB_SRC  += src/hand_iso.cpp src/abs_v2.cpp
HI_DIR   := third_party/hand-isomorphism
C_OBJ    := bin/obj/hand_index.o bin/obj/deck.o
CFLAGS_C ?= -O3 $(ARCH) -std=c99 -DNDEBUG -w


all: bin/bp

# ---- abstraction v2 rules
bin/obj/%.o: $(HI_DIR)/%.c $(HI_DIR)/hand_index.h $(HI_DIR)/hand_index-impl.h $(HI_DIR)/deck.h
	@mkdir -p bin/obj
	$(CC) $(CFLAGS_C) -c $< -o $@

bin/bp_tests_v2: $(LIB_SRC) tests/test_abs_v2.cpp $(HEADERS) $(C_OBJ)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) tests/test_abs_v2.cpp $(C_OBJ) -o $@

test-v2: bin/bp_tests_v2
	./bin/bp_tests_v2
# ---- end abstraction v2

bin/bp: $(LIB_SRC) src/main.cpp $(HEADERS) $(C_OBJ)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) src/main.cpp $(C_OBJ) -o $@

bin/bp_tests: $(LIB_SRC) tests/test_main.cpp $(HEADERS) $(C_OBJ)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -Isrc $(LIB_SRC) tests/test_main.cpp $(C_OBJ) -o $@

test: bin/bp_tests bin/bp_tests_v2
	./bin/bp_tests
	./bin/bp_tests_v2

clean:
	rm -rf bin

.PHONY: all test test-v2 clean
