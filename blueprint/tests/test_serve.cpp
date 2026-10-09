// ============================================================
// test_serve.cpp: tests for `bp serve` (src/serve.{h,cpp}), run by `make test`.
//
// Oracles: the tree itself (BettingTree::history / find / token), the
// preflop class function, and a synthetic policy vector whose value at every
// slot is a known function of the slot index, so a wrong node, bucket or
// action offset shows up as a wrong number. Bucket parity on flop, turn and
// river against the trainer's sampling path needs the real abstraction
// tables; that check is `bp serve --parity-dump` plus
// sim/blueprint-parity.ts (see blueprint/README.md, "Serving the blueprint").
// ============================================================
#include <cmath>
#include <map>

#include "abstraction.h"
#include "serve.h"
#include "tree.h"

using namespace bp;

static int g_fail = 0, g_checks = 0;
#define CHECK(cond)                                                 \
  do {                                                              \
    g_checks++;                                                     \
    if (!(cond)) {                                                  \
      g_fail++;                                                     \
      std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
    }                                                               \
  } while (0)

static bool has(const std::string& s, const std::string& sub) { return s.find(sub) != std::string::npos; }

static void test_json_parser() {
  std::map<std::string, std::string> m;
  CHECK(parse_flat_json("{\"cmd\":\"policy\",\"id\":17,\"history\":\"r0.5 c\"}", m));
  CHECK(m["cmd"] == "policy" && m["id"] == "17" && m["history"] == "r0.5 c");
  CHECK(parse_flat_json("  { \"a\" : \"x\\\"y\" , \"b\" : -2.5e3 , \"c\": true }  ", m));
  CHECK(m["a"] == "x\"y" && m["b"] == "-2.5e3" && m["c"] == "true");
  CHECK(parse_flat_json("{}", m) && m.empty());
  CHECK(!parse_flat_json("", m));
  CHECK(!parse_flat_json("{\"a\":}", m));
  CHECK(!parse_flat_json("{\"a\":\"x\"", m));
  CHECK(!parse_flat_json("{\"a\":[1,2]}", m));
  CHECK(!parse_flat_json("{\"a\":\"x\"} junk", m));
  CHECK(!parse_flat_json("{a:1}", m));
}

static void test_node_queries() {
  BettingTree tree;
  int b[4] = {169, 3, 3, 3};
  tree.build(holdem_config("small"), b);
  ServeCtx ctx;
  ctx.tree = &tree;
  std::string r = serve_handle(ctx, "{\"cmd\":\"info\",\"id\":3}");
  CHECK(has(r, "\"ok\":true") && has(r, "\"id\":3") && has(r, "\"stack\":10000") && has(r, "\"blinds\":[50,100]"));
  CHECK(has(r, "\"nodes\":" + std::to_string(tree.nodes.size())));
  // Root: SB acts first preflop facing the 50-chip completion.
  r = serve_handle(ctx, "{\"cmd\":\"node\",\"history\":\"\"}");
  CHECK(has(r, "\"node\":0,") && has(r, "\"player\":0") && has(r, "\"street\":0") && has(r, "\"contrib\":[50,100]"));
  CHECK(has(r, "{\"tok\":\"f\",\"contrib\":[50,100]}") && has(r, "{\"tok\":\"c\",\"contrib\":[100,100]}"));
  // r0.5 = raise by max(100, 0.5 * (150 + 50)) = 100 to 200; r1 = to 300.
  CHECK(has(r, "{\"tok\":\"r0.5\",\"contrib\":[200,100]}") && has(r, "{\"tok\":\"r1\",\"contrib\":[300,100]}"));
  CHECK(has(r, "{\"tok\":\"a\",\"contrib\":[10000,100]}"));
  // Every decision node answers with its own index through its own history.
  int checked = 0;
  for (uint32_t i = 0; i < tree.nodes.size(); i += 97) {
    std::string h = tree.history(i);
    r = serve_handle(ctx, "{\"cmd\":\"node\",\"history\":\"" + h + "\"}");
    CHECK(has(r, "\"node\":" + std::to_string(i) + ","));
    checked++;
  }
  CHECK(checked > 100);
  r = serve_handle(ctx, "{\"cmd\":\"node\",\"history\":\"r0.7\"}");
  CHECK(has(r, "\"ok\":false") && has(r, "not in tree"));
  r = serve_handle(ctx, "{\"cmd\":\"bogus\"}");
  CHECK(has(r, "\"ok\":false"));
  r = serve_handle(ctx, "not json");
  CHECK(has(r, "\"ok\":false"));
  // Policy without a loaded policy is refused, not crashed.
  r = serve_handle(ctx, "{\"cmd\":\"policy\",\"history\":\"\",\"hole\":\"AhKd\",\"board\":\"\"}");
  CHECK(has(r, "\"ok\":false"));
}

static void test_preflop_policy_lookup() {
  BettingTree tree;
  int b[4] = {169, 3, 3, 3};
  tree.build(holdem_config("small"), b);
  // Synthetic policy: slot value = (slot % 1000) / 1000, so the reply exposes
  // exactly which slot was read.
  std::vector<float> pol(tree.num_slots);
  for (uint64_t i = 0; i < pol.size(); i++) pol[i] = float(i % 1000) / 1000.f;
  Abstraction abs;  // preflop needs no tables
  ServeCtx ctx;
  ctx.tree = &tree;
  ctx.abs = &abs;
  ctx.pol = &pol;
  const char* holes[] = {"AhKd", "AsKs", "7c2d", "QhQd", "5d4d"};
  for (const char* h : holes) {
    int hc[2] = {parse_card(h), parse_card(h + 2)};
    int cls = preflop_class(hc[0], hc[1]);
    for (const char* hist : {"", "r0.5", "c", "r1 r1"}) {
      std::vector<std::string> toks;
      std::string hs = hist;
      size_t p = 0;
      while (p < hs.size()) {
        size_t q = hs.find(' ', p);
        if (q == std::string::npos) q = hs.size();
        toks.push_back(hs.substr(p, q - p));
        p = q + 1;
      }
      int64_t ni = tree.find(toks);
      CHECK(ni >= 0);
      if (ni < 0) continue;
      const Node& n = tree.nodes[ni];
      std::string r = serve_handle(ctx, std::string("{\"cmd\":\"policy\",\"history\":\"") + hist +
                                            "\",\"hole\":\"" + h + "\",\"board\":\"\"}");
      CHECK(has(r, "\"bucket\":" + std::to_string(cls) + ","));
      std::string probs = "\"probs\":[";
      for (int a = 0; a < n.nact; a++) {
        char buf[32];
        std::snprintf(buf, sizeof buf, "%.9g", double(pol[n.slot + uint64_t(cls) * n.nact + a]));
        probs += (a ? "," : "") + std::string(buf);
      }
      CHECK(has(r, probs + "]"));
    }
  }
  // Card validation.
  CHECK(has(serve_handle(ctx, "{\"cmd\":\"policy\",\"history\":\"\",\"hole\":\"AhAh\",\"board\":\"\"}"), "\"ok\":false"));
  CHECK(has(serve_handle(ctx, "{\"cmd\":\"policy\",\"history\":\"\",\"hole\":\"Ah\",\"board\":\"\"}"), "\"ok\":false"));
  CHECK(has(serve_handle(ctx, "{\"cmd\":\"policy\",\"history\":\"\",\"hole\":\"AhKd\",\"board\":\"2c3c4c\"}"),
            "\"ok\":false"));
  CHECK(has(serve_handle(ctx, "{\"cmd\":\"policy\",\"history\":\"c k\",\"hole\":\"AhKd\",\"board\":\"\"}"),
            "\"ok\":false"));  // a flop node needs 3 board cards
  CHECK(has(serve_handle(ctx, "{\"cmd\":\"policy\",\"history\":\"f\",\"hole\":\"AhKd\",\"board\":\"\"}"),
            "terminal"));
}

// "search" dispatch: without a hook it is an error reply; a hook that calls
// die() (as the search code does on a bad request) yields an error reply
// instead of exiting, the loop keeps serving, and die() exits again outside
// a request; a working hook's fields are spliced after "ok" and "id".
static void test_search_dispatch() {
  BettingTree tree;
  int b[4] = {169, 3, 3, 3};
  tree.build(holdem_config("tiny"), b);
  ServeCtx ctx;
  ctx.tree = &tree;
  CHECK(has(serve_handle(ctx, "{\"cmd\":\"search\",\"id\":4}"), "\"ok\":false"));
  ctx.search = [](const std::map<std::string, std::string>& req) -> std::string {
    if (req.count("history") && req.at("history") == "bad") die("search: token 'bad' is not legal");
    return ",\"labels\":[\"k\"],\"probs\":[1]";
  };
  std::string r = serve_handle(ctx, "{\"cmd\":\"search\",\"id\":5,\"history\":\"bad\"}");
  CHECK(has(r, "\"ok\":false") && has(r, "\"id\":5") && has(r, "not legal"));
  CHECK(!die_throws());
  r = serve_handle(ctx, "{\"cmd\":\"search\",\"id\":6,\"history\":\"r1 c\"}");
  CHECK(r == "{\"ok\":true,\"id\":6,\"labels\":[\"k\"],\"probs\":[1]}");
  r = serve_handle(ctx, "{\"cmd\":\"info\"}");
  CHECK(has(r, "\"ok\":true"));
}

int main() {
  struct T {
    const char* name;
    void (*fn)();
  } tests[] = {
      {"serve json parser", test_json_parser},
      {"serve node queries", test_node_queries},
      {"serve preflop policy lookup", test_preflop_policy_lookup},
      {"serve search dispatch and error replies", test_search_dispatch},
  };
  for (auto& t : tests) {
    int before = g_fail;
    t.fn();
    std::printf("%s %s\n", g_fail == before ? "ok  " : "FAIL", t.name);
  }
  std::printf("%d checks, %d failures\n", g_checks, g_fail);
  return g_fail ? 1 : 0;
}
