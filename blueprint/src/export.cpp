// ============================================================
// export.cpp: see export.h for the file format.
// ============================================================
#include "export.h"

#include <algorithm>
#include <functional>
#include <sstream>

namespace bp {

void quantize255(const double* p, int n, uint8_t* out) {
  double s = 0;
  for (int a = 0; a < n; a++) s += std::max(0.0, p[a]);
  if (s <= 0) {
    for (int a = 0; a < n; a++) out[a] = 0;
    return;
  }
  int total = 0;
  double rem[MAX_ACTIONS];
  for (int a = 0; a < n; a++) {
    double x = std::max(0.0, p[a]) / s * 255.0;
    int f = int(std::floor(x));
    out[a] = uint8_t(f);
    rem[a] = x - f;
    total += f;
  }
  // hand the leftover units to the largest remainders
  while (total < 255) {
    int best = 0;
    for (int a = 1; a < n; a++)
      if (rem[a] > rem[best]) best = a;
    out[best]++;
    rem[best] = -1;
    total++;
  }
}

static std::string json_escape(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') o += '\\';
    o += c;
  }
  return o;
}

bool export_policy(const BettingTree& tree, const std::function<void(uint64_t, int, double*)>& policy,
                   const std::function<bool(uint64_t, int)>& visited, const std::string& extra_json,
                   const std::string& path) {
  if (tree.num_slots >= 0xFFFFFFFFull) die("export: more than 2^32 slots; widen the offset field");
  // header with placeholder offsets, sized twice so the offsets are exact
  auto make_header = [&](uint64_t nodes_off, uint64_t strat_off) {
    std::ostringstream h;
    h << "{\"format\":\"gpo-blueprint\",\"version\":1"
      << ",\"game\":\"" << json_escape(tree.cfg.name) << "\""
      << ",\"tree_config\":\"" << json_escape(tree.cfg.describe()) << "\""
      << ",\"streets\":" << tree.cfg.nstreets << ",\"buckets\":[";
    for (int s = 0; s < tree.cfg.nstreets; s++) h << (s ? "," : "") << tree.buckets[s];
    h << "],\"stack\":" << tree.cfg.stack << ",\"blinds\":[" << tree.cfg.blind[0] << ","
      << tree.cfg.blind[1] << "],\"min_bet\":" << tree.cfg.min_bet
      << ",\"num_nodes\":" << tree.nodes.size() << ",\"num_slots\":" << tree.num_slots
      << ",\"node_record_bytes\":" << NODE_RECORD_BYTES << ",\"nodes_offset\":" << nodes_off
      << ",\"strategy_offset\":" << strat_off
      << ",\"action_kinds\":[\"root\",\"fold\",\"check\",\"call\",\"bet\",\"raise\",\"allin\"]"
      << ",\"players\":\""
      << (tree.cfg.name.rfind("holdem", 0) == 0 ? "0 = small blind / button (first to act preflop), 1 = big blind"
                                                 : "0 = first to act, 1 = second to act")
      << "\"";
    if (!extra_json.empty()) h << "," << extra_json;
    h << "}";
    return h.str();
  };
  std::string hdr = make_header(0, 0);
  uint64_t nodes_off = 0, strat_off = 0;
  for (int pass = 0; pass < 3; pass++) {
    nodes_off = (12 + hdr.size() + 7) / 8 * 8;  // 8-byte aligned sections
    strat_off = nodes_off + uint64_t(tree.nodes.size()) * NODE_RECORD_BYTES;
    hdr = make_header(nodes_off, strat_off);
  }
  std::string tmp = path + ".tmp";
  FILE* f = std::fopen(tmp.c_str(), "wb");
  if (!f) return false;
  std::fwrite("GPOBP001", 1, 8, f);
  uint32_t hl = uint32_t(hdr.size());
  std::fwrite(&hl, 4, 1, f);
  std::fwrite(hdr.data(), 1, hdr.size(), f);
  for (uint64_t pos = 12 + hdr.size(); pos < nodes_off; pos++) std::fputc(' ', f);
  for (const Node& n : tree.nodes) {
    uint8_t rec[NODE_RECORD_BYTES];
    rec[0] = n.type;
    rec[1] = n.player;
    rec[2] = n.street;
    rec[3] = n.nact;
    rec[4] = n.act_kind;
    rec[5] = n.raises;
    std::memcpy(rec + 6, &n.frac_milli, 2);
    uint32_t child = n.child, parent = n.parent;
    uint32_t off = n.type == DECISION ? uint32_t(n.slot) : 0xFFFFFFFFu;
    std::memcpy(rec + 8, &child, 4);
    std::memcpy(rec + 12, &parent, 4);
    std::memcpy(rec + 16, &off, 4);
    std::memcpy(rec + 20, &n.contrib[0], 4);
    std::memcpy(rec + 24, &n.contrib[1], 4);
    std::fwrite(rec, 1, NODE_RECORD_BYTES, f);
  }
  std::vector<uint8_t> buf(tree.num_slots, 0);
  for (const Node& n : tree.nodes) {
    if (n.type != DECISION) continue;
    for (int b = 0; b < tree.buckets[n.street]; b++) {
      uint64_t base = n.slot + uint64_t(b) * n.nact;
      if (!visited(base, n.nact)) continue;
      double p[MAX_ACTIONS];
      policy(base, n.nact, p);
      quantize255(p, n.nact, &buf[base]);
    }
  }
  std::fwrite(buf.data(), 1, buf.size(), f);
  bool ok = std::fclose(f) == 0;
  return ok && std::rename(tmp.c_str(), path.c_str()) == 0;
}

}  // namespace bp
