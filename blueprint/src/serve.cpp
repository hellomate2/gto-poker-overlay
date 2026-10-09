// ============================================================
// serve.cpp: `bp serve` request handling (see serve.h for the protocol).
// ============================================================
#include "serve.h"

#include <sstream>

#include "games.h"

namespace bp {

namespace {

void skip_ws(const std::string& s, size_t& i) {
  while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
}

bool read_string(const std::string& s, size_t& i, std::string& out) {
  if (i >= s.size() || s[i] != '"') return false;
  i++;
  out.clear();
  while (i < s.size() && s[i] != '"') {
    char c = s[i++];
    if (c == '\\') {
      if (i >= s.size()) return false;
      char e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        default: return false;  // \b \f \u are never needed by the protocol
      }
    } else {
      out += c;
    }
  }
  if (i >= s.size()) return false;
  i++;  // closing quote
  return true;
}

std::string esc(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') o += '\\';
    if (c == '\n') { o += "\\n"; continue; }
    o += c;
  }
  return o;
}

const char* type_name(uint8_t t) { return t == DECISION ? "decision" : t == FOLD ? "fold" : "showdown"; }

// Parse "AhKd" style card runs. Returns false on a bad card or a duplicate.
bool parse_cards(const std::string& s, std::vector<int>& out, uint64_t& used) {
  out.clear();
  if (s.size() % 2) return false;
  for (size_t i = 0; i < s.size(); i += 2) {
    char buf[3] = {s[i], s[i + 1], 0};
    int c = parse_card(buf);
    if (c < 0 || (used >> c & 1)) return false;
    used |= 1ull << c;
    out.push_back(c);
  }
  return true;
}

std::vector<std::string> split_ws(const std::string& s) {
  std::vector<std::string> t;
  std::stringstream ss(s);
  std::string x;
  while (ss >> x) t.push_back(x);
  return t;
}

void node_fields(const BettingTree& tree, uint32_t ni, std::ostringstream& o) {
  const Node& n = tree.nodes[ni];
  o << ",\"node\":" << ni << ",\"type\":\"" << type_name(n.type) << "\",\"player\":" << int(n.player)
    << ",\"street\":" << int(n.street) << ",\"contrib\":[" << n.contrib[0] << "," << n.contrib[1]
    << "],\"raises\":" << int(n.raises);
  if (n.type != DECISION) return;
  o << ",\"actions\":[";
  for (int a = 0; a < n.nact; a++) {
    const Node& c = tree.nodes[n.child + a];
    o << (a ? "," : "") << "{\"tok\":\"" << tree.token(n.child + a) << "\",\"contrib\":[" << c.contrib[0] << ","
      << c.contrib[1] << "]}";
  }
  o << "]";
}

std::string error_reply(const std::string& id, const std::string& msg) {
  std::ostringstream o;
  o << "{\"ok\":false";
  if (!id.empty()) o << ",\"id\":" << id;
  o << ",\"error\":\"" << esc(msg) << "\"}";
  return o.str();
}

}  // namespace

bool parse_flat_json(const std::string& s, std::map<std::string, std::string>& out, std::string* err) {
  auto fail = [&](const char* m) {
    if (err) *err = m;
    return false;
  };
  out.clear();
  size_t i = 0;
  skip_ws(s, i);
  if (i >= s.size() || s[i] != '{') return fail("expected {");
  i++;
  skip_ws(s, i);
  if (i < s.size() && s[i] == '}') {
    i++;
    skip_ws(s, i);
    return i == s.size() ? true : fail("trailing characters");
  }
  while (true) {
    skip_ws(s, i);
    std::string key, val;
    if (!read_string(s, i, key)) return fail("expected a string key");
    skip_ws(s, i);
    if (i >= s.size() || s[i] != ':') return fail("expected :");
    i++;
    skip_ws(s, i);
    if (i >= s.size()) return fail("missing value");
    if (s[i] == '"') {
      if (!read_string(s, i, val)) return fail("bad string value");
    } else {
      size_t j = i;
      while (j < s.size() && s[j] != ',' && s[j] != '}' && s[j] != ' ' && s[j] != '\t') j++;
      val = s.substr(i, j - i);
      if (val.empty()) return fail("empty value");
      bool num = true;
      for (char c : val)
        if (!(std::isdigit(static_cast<unsigned char>(c)) || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E'))
          num = false;
      if (!num && val != "true" && val != "false" && val != "null") return fail("unsupported value");
      i = j;
    }
    out[key] = val;
    skip_ws(s, i);
    if (i >= s.size()) return fail("unterminated object");
    if (s[i] == ',') {
      i++;
      continue;
    }
    if (s[i] == '}') {
      i++;
      skip_ws(s, i);
      return i == s.size() ? true : fail("trailing characters");
    }
    return fail("expected , or }");
  }
}

int serve_bucket(const Abstraction& abs, int street, const int hole[2], const int* board) {
  switch (street) {
    case 0: return preflop_class(hole[0], hole[1]);
    case 1: return abs.flop(hole, board);
    case 2: return abs.turn(hole, board);
    default:
      if (abs.has_river_table()) return abs.river(hole, board);
      // Same EHS as river_ehs_pair (card removal: board and own hole only).
      {
        std::vector<float> e(NUM_COMBOS);
        river_ehs_all(board, e.data());
        return abs.river_from_ehs(e[combo_index(hole[0], hole[1])]);
      }
  }
}

std::string serve_handle(const ServeCtx& ctx, const std::string& line) {
  std::map<std::string, std::string> req;
  std::string err;
  if (!parse_flat_json(line, req, &err)) return error_reply("", "bad request: " + err);
  std::string id;
  if (req.count("id")) {
    id = req["id"];
    for (char c : id)
      if (!(std::isdigit(static_cast<unsigned char>(c)) || c == '-')) return error_reply("", "id must be an integer");
  }
  const std::string cmd = req.count("cmd") ? req["cmd"] : "";
  const BettingTree& tree = *ctx.tree;
  std::ostringstream o;
  o << "{\"ok\":true";
  if (!id.empty()) o << ",\"id\":" << id;

  if (cmd == "info") {
    o << ",\"tree\":\"" << esc(tree.cfg.describe()) << "\",\"abs\":\"" << esc(ctx.abs_id)
      << "\",\"iterations\":" << ctx.iterations << ",\"stack\":" << tree.cfg.stack << ",\"blinds\":["
      << tree.cfg.blind[0] << "," << tree.cfg.blind[1] << "],\"min_bet\":" << tree.cfg.min_bet << ",\"buckets\":["
      << tree.buckets[0] << "," << tree.buckets[1] << "," << tree.buckets[2] << "," << tree.buckets[3]
      << "],\"nodes\":" << tree.nodes.size() << "}";
    return o.str();
  }
  if (cmd != "node" && cmd != "policy") return error_reply(id, "unknown cmd '" + cmd + "'");

  int64_t ni = tree.find(split_ws(req.count("history") ? req["history"] : ""));
  if (ni < 0) return error_reply(id, "history not in tree");
  node_fields(tree, uint32_t(ni), o);
  if (cmd == "node") {
    o << "}";
    return o.str();
  }

  const Node& n = tree.nodes[ni];
  if (n.type != DECISION) return error_reply(id, "history ends at a terminal node");
  if (!ctx.abs || !ctx.pol) return error_reply(id, "policy not loaded");
  uint64_t used = 0;
  std::vector<int> hole, board;
  if (!parse_cards(req.count("hole") ? req["hole"] : "", hole, used) || hole.size() != 2)
    return error_reply(id, "hole must be two distinct cards like AhKd");
  if (!parse_cards(req.count("board") ? req["board"] : "", board, used))
    return error_reply(id, "bad or duplicate board card");
  static const size_t need[4] = {0, 3, 4, 5};
  if (board.size() != need[n.street])
    return error_reply(id, "board has " + std::to_string(board.size()) + " cards but the node is on street " +
                               std::to_string(n.street));
  int b = serve_bucket(*ctx.abs, n.street, hole.data(), board.data());
  if (b < 0 || b >= tree.buckets[n.street]) return error_reply(id, "bucket out of range");
  const float* p = &(*ctx.pol)[n.slot + uint64_t(b) * n.nact];
  char buf[32];
  o << ",\"bucket\":" << b << ",\"probs\":[";
  for (int a = 0; a < n.nact; a++) {
    std::snprintf(buf, sizeof buf, "%.9g", double(p[a]));
    o << (a ? "," : "") << buf;
  }
  o << "]}";
  return o.str();
}

int serve_loop(const ServeCtx& ctx, FILE* in, FILE* out) {
  std::string line;
  int ch;
  long long served = 0;
  while (true) {
    line.clear();
    while ((ch = std::fgetc(in)) != EOF && ch != '\n') line += char(ch);
    if (ch == EOF && line.empty()) break;
    bool blank = true;
    for (char c : line)
      if (!std::isspace(static_cast<unsigned char>(c))) blank = false;
    if (blank) {
      if (ch == EOF) break;
      continue;
    }
    std::string r = serve_handle(ctx, line);
    std::fputs(r.c_str(), out);
    std::fputc('\n', out);
    std::fflush(out);
    served++;
    if (ch == EOF) break;
  }
  std::fprintf(stderr, "serve: answered %lld requests\n", served);
  return 0;
}

int serve_parity_dump(const BettingTree& tree, const Abstraction& abs, const AvgFn& avg, int n, uint64_t seed,
                      FILE* out) {
  HoldemSampler smp{&abs};
  Rng rng(seed);
  Deal d;
  int written = 0;
  long long attempts = 0;
  while (written < n) {
    if (++attempts > 1000LL * n + 1000) die("parity dump: could not reach the target streets");
    int target = written % 4;
    smp.sample(rng, d);
    // Uniform random walk from the root until a decision node on `target`;
    // on that street, stop at each decision node with probability 1/2.
    uint32_t ni = 0;
    bool found = false;
    while (tree.nodes[ni].type == DECISION) {
      const Node& nd = tree.nodes[ni];
      if (nd.street == target) {
        // Stop here with probability 1/2, or when every child leaves the street.
        bool stop = rng.below(2) == 0;
        bool any_same = false;
        for (int a = 0; a < nd.nact; a++) {
          const Node& c = tree.nodes[nd.child + a];
          if (c.type == DECISION && c.street == target) any_same = true;
        }
        if (stop || !any_same) {
          found = true;
          break;
        }
      }
      if (nd.street > target) break;
      // Walk: avoid fold so the walk survives to later streets.
      int a;
      int tries = 0;
      do a = int(rng.below(nd.nact)); while (tree.nodes[nd.child + a].type == FOLD && ++tries < 16);
      ni = nd.child + a;
    }
    if (!found) continue;
    const Node& nd = tree.nodes[ni];
    int p = nd.player;
    std::string hole = card_str(d.hole[p][0]) + card_str(d.hole[p][1]);
    static const int need[4] = {0, 3, 4, 5};
    std::string board;
    for (int k = 0; k < need[nd.street]; k++) board += card_str(d.board[k]);
    int bucket = d.bucket[p][nd.street];
    std::vector<double> pr(nd.nact);
    avg(nd.slot + uint64_t(bucket) * nd.nact, nd.nact, pr.data());
    std::fprintf(out, "{\"history\":\"%s\",\"hole\":\"%s\",\"board\":\"%s\",\"node\":%u,\"street\":%d,\"player\":%d,"
                      "\"bucket\":%d,\"probs\":[",
                 tree.history(ni).c_str(), hole.c_str(), board.c_str(), ni, int(nd.street), p, bucket);
    for (int a = 0; a < nd.nact; a++) std::fprintf(out, "%s%.9g", a ? "," : "", pr[a]);
    std::fprintf(out, "],\"toks\":[");
    for (int a = 0; a < nd.nact; a++) std::fprintf(out, "%s\"%s\"", a ? "," : "", tree.token(nd.child + a).c_str());
    std::fprintf(out, "]}\n");
    written++;
  }
  return written;
}

}  // namespace bp
