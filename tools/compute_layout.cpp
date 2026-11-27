/**
 * compute_layout.cpp - High-Performance C++17 + OpenMP D3 v7 Force-Directed Layout Engine
 *
 * Exact port of Rice2Net's d3.forceSimulation pipeline (app/sim.js + d3.v7):
 *   - mulberry32(seed) PRNG
 *   - forceManyBody (Barnes-Hut quadtree, theta = 0.9, strength = -50 / -1 for deg <= 1)
 *   - forceLink     (distance = 5, strength = 1/min(deg_u, deg_v) or optional z-score weighted)
 *   - forceCollide  (quadtree spatial collision, radius = r * 0.8)
 *   - forceRadial   (center = (width/2, height/2), strength = 0.05)
 *   - Streaming Z-score-first TSV parser capable of filtering 224M+ edges (15 GB) in seconds.
 *
 * Compile:
 *   g++ -O3 -march=native -fopenmp -std=c++17 tools/compute_layout.cpp -o tools/compute_layout
 *
 * Usage:
 *   ./tools/compute_layout --input /path/to/network_main_edges.tsv --min-z 0.75 \
 *       --out-nodes layout_nodes.tsv --out-edges layout_edges.tsv --out-json layout.json
 */

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#ifdef _OPENMP
#include <omp.h>
#endif

namespace {

// Exact port of Rice2Net mulberry32 PRNG (app/globals.js)
struct Mulberry32 {
    uint32_t a;
    explicit Mulberry32(uint32_t seed = 42) : a(seed) {}
    inline double next() {
        uint32_t t = (a += 0x6D2B79F5u);
        t = (t ^ (t >> 15)) * (t | 1u);
        t ^= t + ((t ^ (t >> 7)) * (t | 61u));
        return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
    }
};

// Deterministic thread-safe jiggle for coincident nodes in parallel loops
static inline double det_jiggle(uint64_t seed) {
    seed ^= seed >> 33;
    seed *= 0xff51afd7ed558ccdULL;
    seed ^= seed >> 33;
    seed *= 0xc4ceb9fe1a85ec53ULL;
    seed ^= seed >> 33;
    double u = static_cast<double>(seed >> 11) * (1.0 / 9007199254740992.0);
    return (u - 0.5) * 1e-6;
}

// Fast ASCII floating-point parser (falls back to strtod on exponent notation)
static inline bool fast_parse_double(const char* s, size_t len, double& out) {
    if (len == 0) return false;
    const char* p = s;
    const char* end = s + len;
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p;
    if (p >= end) return false;

    bool neg = false;
    if (*p == '-') { neg = true; ++p; }
    else if (*p == '+') { ++p; }
    if (p >= end) return false;

    uint64_t int_part = 0;
    int digits = 0;
    while (p < end && *p >= '0' && *p <= '9') {
        if (digits < 18) int_part = int_part * 10 + static_cast<uint64_t>(*p - '0');
        else {
            // Fall back for very long integer parts
            char tmp[128];
            size_t n = std::min(len, sizeof(tmp) - 1);
            std::memcpy(tmp, s, n);
            tmp[n] = '\0';
            char* ep = nullptr;
            out = std::strtod(tmp, &ep);
            return ep != tmp;
        }
        ++digits;
        ++p;
    }

    double val = static_cast<double>(int_part);
    if (p < end && *p == '.') {
        ++p;
        uint64_t frac_part = 0;
        double scale = 1.0;
        int fdigits = 0;
        while (p < end && *p >= '0' && *p <= '9') {
            if (fdigits < 18) {
                frac_part = frac_part * 10 + static_cast<uint64_t>(*p - '0');
                scale *= 10.0;
                ++fdigits;
            }
            ++digits;
            ++p;
        }
        val += static_cast<double>(frac_part) / scale;
    }

    if (digits == 0) return false;

    if (p < end && (*p == 'e' || *p == 'E')) {
        char tmp[128];
        size_t n = std::min(len, sizeof(tmp) - 1);
        std::memcpy(tmp, s, n);
        tmp[n] = '\0';
        char* ep = nullptr;
        out = std::strtod(tmp, &ep);
        return ep != tmp;
    }

    out = neg ? -val : val;
    return true;
}

static inline std::string to_lower_ascii(std::string_view sv) {
    std::string out(sv.size(), '\0');
    for (size_t i = 0; i < sv.size(); ++i) {
        char c = sv[i];
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        out[i] = c;
    }
    return out;
}

static inline std::string_view trim_sv(std::string_view sv) {
    while (!sv.empty() && (sv.front() == ' ' || sv.front() == '\t' || sv.front() == '\r' || sv.front() == '\n' || sv.front() == '"')) sv.remove_prefix(1);
    while (!sv.empty() && (sv.back() == ' ' || sv.back() == '\t' || sv.back() == '\r' || sv.back() == '\n' || sv.back() == '"')) sv.remove_suffix(1);
    return sv;
}

struct Edge {
    uint32_t u;
    uint32_t v;
    float weight;
    float z_score;
    int8_t sign; // +1, -1, 0
};

struct Config {
    std::string input_path;
    std::string out_nodes;
    std::string out_edges;
    std::string out_json;

    double min_z = 0.75;
    bool has_min_z = true;

    int ticks = 400;
    uint32_t seed = 42;
    double width = 1600.0;
    double height = 900.0;

    // Physics overrides (-1 = auto Rice2Net heavy/small defaults)
    double repulsion = -1.0;
    double link_dist = 5.0;
    double collision_mult = 0.8;
    double radial_strength = -1.0;
    double base_size = -1.0;
    double size_mult = -1.0;
    double theta = 0.9;

    std::string weight_mode = "d3"; // "d3" (exact Rice2Net unweighted) or "zscore"
    bool exact_serial_links = false;
    int threads = 0; // 0 = OpenMP default
};

// Flat Arena Quadtree matching D3 v7 quadtree semantics
struct QTNode {
    int32_t child[4]; // -1 = empty
    int32_t leaf_idx; // >= 0 means leaf head (index into node array); -1 means internal
    double cx;
    double cy;
    double value;     // sum of charge (many-body)
    double max_r;     // max collision radius (collide)
};

class FlatQuadtree {
public:
    std::vector<QTNode> tree;
    std::vector<int32_t> next_leaf; // linked list of coincident points
    double x0 = 0.0, y0 = 0.0, size = 1.0;
    int32_t root = -1;

    void reserve(size_t n) {
        tree.reserve(n * 4 + 64);
        next_leaf.resize(n, -1);
    }

    inline int32_t alloc_leaf(int32_t idx, double px, double py) {
        int32_t id = static_cast<int32_t>(tree.size());
        QTNode q;
        q.child[0] = q.child[1] = q.child[2] = q.child[3] = -1;
        q.leaf_idx = idx;
        q.cx = px;
        q.cy = py;
        q.value = 0.0;
        q.max_r = 0.0;
        tree.push_back(q);
        return id;
    }

    inline int32_t alloc_internal() {
        int32_t id = static_cast<int32_t>(tree.size());
        QTNode q;
        q.child[0] = q.child[1] = q.child[2] = q.child[3] = -1;
        q.leaf_idx = -1;
        q.cx = 0.0;
        q.cy = 0.0;
        q.value = 0.0;
        q.max_r = 0.0;
        tree.push_back(q);
        return id;
    }

    void build(size_t n, const double* px, const double* py) {
        tree.clear();
        if (next_leaf.size() < n) next_leaf.resize(n, -1);
        std::fill(next_leaf.begin(), next_leaf.begin() + n, -1);
        root = -1;
        if (n == 0) return;

        double minX = std::numeric_limits<double>::infinity();
        double minY = std::numeric_limits<double>::infinity();
        double maxX = -std::numeric_limits<double>::infinity();
        double maxY = -std::numeric_limits<double>::infinity();

        for (size_t i = 0; i < n; ++i) {
            double x = px[i], y = py[i];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }

        // Exact D3 quadtree binary-power square extent
        x0 = std::floor(minX);
        y0 = std::floor(minY);
        double span = std::max(maxX - x0, maxY - y0);
        size = 1.0;
        while (size <= span) size *= 2.0;

        for (size_t i = 0; i < n; ++i) {
            insert(static_cast<int32_t>(i), px[i], py[i], px, py);
        }
    }

    void insert(int32_t idx, double x, double y, const double* px, const double* py) {
        if (root == -1) {
            root = alloc_leaf(idx, x, y);
            return;
        }

        double bx0 = x0, by0 = y0, bx1 = x0 + size, by1 = y0 + size;
        int32_t curr = root;
        int32_t parent = -1;
        int parent_q = 0;

        while (tree[curr].leaf_idx == -1) {
            double xm = 0.5 * (bx0 + bx1);
            double ym = 0.5 * (by0 + by1);
            int right = (x >= xm) ? 1 : 0;
            int bottom = (y >= ym) ? 1 : 0;
            int q = (bottom << 1) | right;
            if (right) bx0 = xm; else bx1 = xm;
            if (bottom) by0 = ym; else by1 = ym;

            int32_t nxt = tree[curr].child[q];
            if (nxt == -1) {
                int32_t leaf = alloc_leaf(idx, x, y);
                tree[curr].child[q] = leaf;
                return;
            }
            parent = curr;
            parent_q = q;
            curr = nxt;
        }

        // Hit an existing leaf
        int32_t existing = tree[curr].leaf_idx;
        double ex = px[existing];
        double ey = py[existing];

        // Coincident point (or subdivision limit reached)
        if ((ex == x && ey == y) || (bx1 - bx0) <= 1e-9) {
            next_leaf[idx] = existing;
            tree[curr].leaf_idx = idx;
            return;
        }

        // Split until existing and new point separate
        int32_t existing_leaf_node = curr;
        int32_t first_internal = alloc_internal();
        if (parent == -1) root = first_internal;
        else tree[parent].child[parent_q] = first_internal;

        int32_t node = first_internal;
        for (int depth = 0; depth < 60; ++depth) {
            double xm = 0.5 * (bx0 + bx1);
            double ym = 0.5 * (by0 + by1);
            int r1 = (ex >= xm) ? 1 : 0;
            int b1 = (ey >= ym) ? 1 : 0;
            int q1 = (b1 << 1) | r1;

            int r2 = (x >= xm) ? 1 : 0;
            int b2 = (y >= ym) ? 1 : 0;
            int q2 = (b2 << 1) | r2;

            if (q1 != q2) {
                tree[node].child[q1] = existing_leaf_node;
                int32_t new_leaf = alloc_leaf(idx, x, y);
                tree[node].child[q2] = new_leaf;
                return;
            }

            if (r1) bx0 = xm; else bx1 = xm;
            if (b1) by0 = ym; else by1 = ym;

            if ((bx1 - bx0) <= 1e-9) {
                tree[node].child[q1] = existing_leaf_node;
                next_leaf[idx] = tree[existing_leaf_node].leaf_idx;
                tree[existing_leaf_node].leaf_idx = idx;
                return;
            }

            int32_t sub = alloc_internal();
            tree[node].child[q1] = sub;
            node = sub;
        }
        // Fallback if depth exhausted
        next_leaf[idx] = tree[existing_leaf_node].leaf_idx;
        tree[existing_leaf_node].leaf_idx = idx;
        tree[node].child[0] = existing_leaf_node;
    }

    // Iterative post-order accumulation for forceManyBody (exact D3 l(t))
    void accumulate_charge(const double* charge, const double* px, const double* py) {
        if (root == -1) return;
        std::vector<int32_t> order;
        order.reserve(tree.size());
        order.push_back(root);
        for (size_t i = 0; i < order.size(); ++i) {
            int32_t u = order[i];
            if (tree[u].leaf_idx == -1) {
                for (int c = 0; c < 4; ++c) {
                    int32_t ch = tree[u].child[c];
                    if (ch != -1) order.push_back(ch);
                }
            }
        }
        for (size_t i = order.size(); i-- > 0;) {
            QTNode& q = tree[order[i]];
            if (q.leaf_idx != -1) {
                double sum = 0.0;
                int32_t k = q.leaf_idx;
                q.cx = px[k];
                q.cy = py[k];
                while (k != -1) {
                    sum += charge[k];
                    k = next_leaf[k];
                }
                q.value = sum;
            } else {
                double sum_v = 0.0, sum_abs = 0.0, sx = 0.0, sy = 0.0;
                for (int c = 0; c < 4; ++c) {
                    int32_t ch = q.child[c];
                    if (ch != -1) {
                        const QTNode& cn = tree[ch];
                        double av = std::abs(cn.value);
                        if (av > 0.0) {
                            sum_v += cn.value;
                            sum_abs += av;
                            sx += av * cn.cx;
                            sy += av * cn.cy;
                        }
                    }
                }
                q.value = sum_v;
                if (sum_abs > 0.0) {
                    q.cx = sx / sum_abs;
                    q.cy = sy / sum_abs;
                }
            }
        }
    }

    // Iterative post-order accumulation for forceCollide (exact D3 u(t))
    void accumulate_radius(const double* radii) {
        if (root == -1) return;
        std::vector<int32_t> order;
        order.reserve(tree.size());
        order.push_back(root);
        for (size_t i = 0; i < order.size(); ++i) {
            int32_t u = order[i];
            if (tree[u].leaf_idx == -1) {
                for (int c = 0; c < 4; ++c) {
                    int32_t ch = tree[u].child[c];
                    if (ch != -1) order.push_back(ch);
                }
            }
        }
        for (size_t i = order.size(); i-- > 0;) {
            QTNode& q = tree[order[i]];
            if (q.leaf_idx != -1) {
                double mr = 0.0;
                int32_t k = q.leaf_idx;
                while (k != -1) {
                    if (radii[k] > mr) mr = radii[k];
                    k = next_leaf[k];
                }
                q.max_r = mr;
            } else {
                double mr = 0.0;
                for (int c = 0; c < 4; ++c) {
                    int32_t ch = q.child[c];
                    if (ch != -1 && tree[ch].max_r > mr) mr = tree[ch].max_r;
                }
                q.max_r = mr;
            }
        }
    }
};

void print_usage(const char* prog) {
    std::fprintf(stderr,
        "Usage: %s --input <edges.tsv> [options]\n"
        "Options:\n"
        "  --input <path>          Input edge TSV/CSV file (required)\n"
        "  --min-z <float>         Minimum Z-score filter (default: 0.75; pass 'none' for all)\n"
        "  --out-nodes <path>      Output node coordinates TSV (id, x, y, deg, r)\n"
        "  --out-edges <path>      Output filtered edges TSV (Source, Target, Weight, Z_score, sign)\n"
        "  --out-json <path>       Output Rice2Net-compatible layout JSON\n"
        "  --ticks <int>           Simulation ticks (default: 400)\n"
        "  --seed <uint>           Mulberry32 RNG seed (default: 42)\n"
        "  --width <float>         Initial canvas width (default: 1600)\n"
        "  --height <float>        Initial canvas height (default: 900)\n"
        "  --repulsion <float>     Many-body repulsion magnitude (default: 50 heavy / 300 small)\n"
        "  --link-dist <float>     Target link distance (default: 5)\n"
        "  --collision <float>     Collision radius multiplier (default: 0.8)\n"
        "  --radial <float>        Radial gravity strength (default: 0.05 heavy / 0.1 small)\n"
        "  --theta <float>         Barnes-Hut opening angle (default: 0.9)\n"
        "  --weight-mode <mode>    'd3' (default exact Rice2Net) or 'zscore' (z-weighted springs)\n"
        "  --exact-serial-links    Run forceLink sequentially (exact D3 Gauss-Seidel order)\n"
        "  --threads <int>         OpenMP thread count (default: all available)\n",
        prog);
}

static inline void escape_json_str(FILE* f, const std::string& s) {
    fputc('"', f);
    for (char c : s) {
        if (c == '"' || c == '\\') { fputc('\\', f); fputc(c, f); }
        else fputc(c, f);
    }
    fputc('"', f);
}

} // namespace

int main(int argc, char** argv) {
    Config cfg;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        auto need_val = [&](const char* opt) -> const char* {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "Missing value for %s\n", opt);
                std::exit(1);
            }
            return argv[++i];
        };
        if (arg == "--input" || arg == "-i") cfg.input_path = need_val("--input");
        else if (arg == "--min-z") {
            std::string v = need_val("--min-z");
            if (v == "none" || v == "NONE" || v == "all") cfg.has_min_z = false;
            else { cfg.min_z = std::stod(v); cfg.has_min_z = true; }
        }
        else if (arg == "--out-nodes") cfg.out_nodes = need_val("--out-nodes");
        else if (arg == "--out-edges") cfg.out_edges = need_val("--out-edges");
        else if (arg == "--out-json") cfg.out_json = need_val("--out-json");
        else if (arg == "--ticks") cfg.ticks = std::stoi(need_val("--ticks"));
        else if (arg == "--seed") cfg.seed = static_cast<uint32_t>(std::stoul(need_val("--seed")));
        else if (arg == "--width") cfg.width = std::stod(need_val("--width"));
        else if (arg == "--height") cfg.height = std::stod(need_val("--height"));
        else if (arg == "--repulsion") cfg.repulsion = std::stod(need_val("--repulsion"));
        else if (arg == "--link-dist") cfg.link_dist = std::stod(need_val("--link-dist"));
        else if (arg == "--collision") cfg.collision_mult = std::stod(need_val("--collision"));
        else if (arg == "--radial") cfg.radial_strength = std::stod(need_val("--radial"));
        else if (arg == "--base-size") cfg.base_size = std::stod(need_val("--base-size"));
        else if (arg == "--size-mult") cfg.size_mult = std::stod(need_val("--size-mult"));
        else if (arg == "--theta") cfg.theta = std::stod(need_val("--theta"));
        else if (arg == "--weight-mode") cfg.weight_mode = need_val("--weight-mode");
        else if (arg == "--exact-serial-links") cfg.exact_serial_links = true;
        else if (arg == "--threads" || arg == "-t") cfg.threads = std::stoi(need_val("--threads"));
        else if (arg == "--help" || arg == "-h") { print_usage(argv[0]); return 0; }
        else {
            std::fprintf(stderr, "Unknown argument: %s\n", arg.c_str());
            print_usage(argv[0]);
            return 1;
        }
    }

    if (cfg.input_path.empty()) {
        print_usage(argv[0]);
        return 1;
    }

#ifdef _OPENMP
    if (cfg.threads > 0) omp_set_num_threads(cfg.threads);
    int num_threads = omp_get_max_threads();
#else
    int num_threads = 1;
#endif

    auto t_start = std::chrono::steady_clock::now();
    std::fprintf(stderr, "[1/4] Streaming input %s (min_z=%s, threads=%d)...\n",
                 cfg.input_path.c_str(),
                 cfg.has_min_z ? std::to_string(cfg.min_z).c_str() : "none",
                 num_threads);

    FILE* f = std::fopen(cfg.input_path.c_str(), "rb");
    if (!f) {
        std::perror("fopen input");
        return 1;
    }
    static std::vector<char> io_buf(1 << 23); // 8 MB buffer
    std::setvbuf(f, io_buf.data(), _IOFBF, io_buf.size());

    char line[8192];
    if (!std::fgets(line, sizeof(line), f)) {
        std::fprintf(stderr, "Empty input file.\n");
        std::fclose(f);
        return 1;
    }

    // Detect delimiter & header columns
    char delim = '\t';
    if (!std::strchr(line, '\t') && std::strchr(line, ',')) delim = ',';

    int col_src = 0, col_tgt = 1, col_w = 2, col_z = -1, col_sign = -1;
    bool has_header = false;
    {
        std::vector<std::string> cols;
        const char* p = line;
        while (*p) {
            const char* q = std::strchr(p, delim);
            std::string_view sv = q ? std::string_view(p, q - p) : std::string_view(p);
            cols.push_back(to_lower_ascii(trim_sv(sv)));
            if (!q) break;
            p = q + 1;
        }
        for (const auto& h : cols) {
            if (h == "source" || h == "from" || h == "target" || h == "to") {
                has_header = true;
                break;
            }
        }
        if (has_header) {
            col_w = -1;
            for (int c = 0; c < static_cast<int>(cols.size()); ++c) {
                const auto& h = cols[c];
                if (h == "source" || h == "from") col_src = c;
                else if (h == "target" || h == "to") col_tgt = c;
                else if (h == "weight" || h == "w" || h == "value" || h == "val") col_w = c;
                else if (h == "z_score" || h == "zscore" || h == "z-score" || h == "z") col_z = c;
                else if (h == "sign") col_sign = c;
            }
        } else {
            // Rewind if no header
            std::rewind(f);
        }
    }

    const int max_needed_col = std::max({col_src, col_tgt, col_w, col_z, col_sign});
    std::fprintf(stderr, "      Columns: src=%d tgt=%d weight=%d z_score=%d sign=%d (delim='%s')\n",
                 col_src, col_tgt, col_w, col_z, col_sign, delim == '\t' ? "\\t" : ",");

    std::deque<std::string> node_names;
    std::unordered_map<std::string_view, uint32_t> id_map;
    id_map.reserve(131072);

    auto get_node_id = [&](std::string_view sv) -> uint32_t {
        auto it = id_map.find(sv);
        if (it != id_map.end()) return it->second;
        uint32_t id = static_cast<uint32_t>(node_names.size());
        node_names.emplace_back(sv);
        id_map.emplace(std::string_view(node_names.back()), id);
        return id;
    };

    std::vector<Edge> edges;
    edges.reserve(4000000);

    uint64_t total_rows = 0;
    uint64_t kept_rows = 0;
    double min_z_seen = std::numeric_limits<double>::infinity();
    double max_z_seen = -std::numeric_limits<double>::infinity();

    const char* fstart[16];
    size_t flen[16];

    while (std::fgets(line, sizeof(line), f)) {
        if (line[0] == '#' || line[0] == '\n' || line[0] == '\r') continue;
        ++total_rows;

        // Split fields without allocating
        int ncol = 0;
        const char* p = line;
        while (ncol < 16) {
            const char* q = std::strchr(p, delim);
            if (!q) {
                const char* e = p + std::strlen(p);
                while (e > p && (e[-1] == '\n' || e[-1] == '\r')) --e;
                fstart[ncol] = p;
                flen[ncol] = static_cast<size_t>(e - p);
                ++ncol;
                break;
            }
            fstart[ncol] = p;
            flen[ncol] = static_cast<size_t>(q - p);
            ++ncol;
            p = q + 1;
            if (ncol > max_needed_col + 1) break;
        }
        if (ncol <= std::max(col_src, col_tgt)) continue;

        // Filter on z_score FIRST before touching hash maps (skips ~98.7% of 224M rows!)
        double z_val = std::numeric_limits<double>::quiet_NaN();
        if (col_z >= 0 && col_z < ncol) {
            if (fast_parse_double(fstart[col_z], flen[col_z], z_val)) {
                if (cfg.has_min_z && z_val < cfg.min_z) continue;
            } else if (cfg.has_min_z) {
                continue;
            }
        }

        std::string_view s_sv = trim_sv(std::string_view(fstart[col_src], flen[col_src]));
        std::string_view t_sv = trim_sv(std::string_view(fstart[col_tgt], flen[col_tgt]));
        if (s_sv.empty() || t_sv.empty() || s_sv == t_sv) continue;

        double w_val = 1.0;
        if (col_w >= 0 && col_w < ncol) {
            double parsed_w = 1.0;
            if (fast_parse_double(fstart[col_w], flen[col_w], parsed_w)) w_val = parsed_w;
        }

        int8_t sgn = 0;
        if (col_sign >= 0 && col_sign < ncol && flen[col_sign] > 0) {
            char c = fstart[col_sign][0];
            if (c == '+') sgn = 1;
            else if (c == '-') sgn = -1;
        }

        if (std::isfinite(z_val)) {
            if (z_val < min_z_seen) min_z_seen = z_val;
            if (z_val > max_z_seen) max_z_seen = z_val;
        }

        uint32_t u = get_node_id(s_sv);
        uint32_t v = get_node_id(t_sv);
        edges.push_back(Edge{u, v, static_cast<float>(w_val), static_cast<float>(z_val), sgn});
        ++kept_rows;
    }
    std::fclose(f);

    const size_t N = node_names.size();
    const size_t E = edges.size();
    auto t_read = std::chrono::steady_clock::now();
    double sec_read = std::chrono::duration<double>(t_read - t_start).count();

    std::fprintf(stderr, "      Scanned %llu rows -> kept %zu edges across %zu nodes in %.2fs",
                 static_cast<unsigned long long>(total_rows), E, N, sec_read);
    if (std::isfinite(min_z_seen)) {
        std::fprintf(stderr, " (z in [%.4f, %.4f])", min_z_seen, max_z_seen);
    }
    std::fprintf(stderr, "\n");

    if (N == 0) {
        std::fprintf(stderr, "No nodes passed filter. Exiting.\n");
        return 1;
    }

    // Resolve heavy vs small graph defaults (exact match to app/sim.js)
    const bool is_heavy = (N > 5000 || E > 40000);
    const double base_size = (cfg.base_size >= 0.0) ? cfg.base_size : (is_heavy ? 0.5 : 2.0);
    const double size_mult = (cfg.size_mult >= 0.0) ? cfg.size_mult : (is_heavy ? 0.8 : 2.5);
    const double repulsion = (cfg.repulsion >= 0.0) ? cfg.repulsion : (is_heavy ? 50.0 : 300.0);
    const double radial_str = (cfg.radial_strength >= 0.0) ? cfg.radial_strength : (is_heavy ? 0.05 : 0.1);
    const double link_dist = cfg.link_dist;
    const double coll_mult = cfg.collision_mult;
    const double theta2 = cfg.theta * cfg.theta;
    const double dist_min2 = 1.0;

    std::fprintf(stderr, "[2/4] Initializing physics (%s defaults: rep=-%.1f, linkDist=%.1f, col=%.2f, radial=%.3f, ticks=%d, mode=%s)...\n",
                 is_heavy ? "heavy" : "small", repulsion, link_dist, coll_mult, radial_str, cfg.ticks,
                 cfg.exact_serial_links ? "exact-serial-links" : "parallel-links");

    // Node arrays (SoA for cache locality)
    std::vector<uint32_t> deg(N, 0);
    for (size_t e = 0; e < E; ++e) {
        deg[edges[e].u]++;
        deg[edges[e].v]++;
    }

    std::vector<double> x(N), y(N), vx(N, 0.0), vy(N, 0.0);
    std::vector<double> r_node(N), r_coll(N), charge(N);

    Mulberry32 rng(cfg.seed);
    for (size_t i = 0; i < N; ++i) {
        x[i] = rng.next() * cfg.width;
        y[i] = rng.next() * cfg.height;
        r_node[i] = base_size + std::sqrt(static_cast<double>(deg[i])) * size_mult;
        r_coll[i] = r_node[i] * coll_mult;
        charge[i] = (deg[i] <= 1) ? -1.0 : -repulsion;
    }

    // Precompute link bias & strength
    std::vector<float> link_bias(E);
    std::vector<float> link_str(E);
    const bool use_z_weight = (cfg.weight_mode == "zscore");

    if (!use_z_weight) {
        for (size_t e = 0; e < E; ++e) {
            double du = static_cast<double>(deg[edges[e].u]);
            double dv = static_cast<double>(deg[edges[e].v]);
            link_bias[e] = static_cast<float>(du / (du + dv));
            link_str[e] = static_cast<float>(1.0 / std::min(du, dv));
        }
    } else {
        // Optional Z-score weighted springs normalized so per-node sum <= 1
        std::vector<double> z_sum(N, 0.0);
        const double z_floor = std::isfinite(min_z_seen) ? std::max(0.0, min_z_seen - 0.1) : 0.0;
        for (size_t e = 0; e < E; ++e) {
            double zw = std::isfinite(edges[e].z_score) ? std::max(0.05, static_cast<double>(edges[e].z_score) - z_floor) : 1.0;
            z_sum[edges[e].u] += zw;
            z_sum[edges[e].v] += zw;
        }
        for (size_t e = 0; e < E; ++e) {
            double zw = std::isfinite(edges[e].z_score) ? std::max(0.05, static_cast<double>(edges[e].z_score) - z_floor) : 1.0;
            double su = z_sum[edges[e].u];
            double sv = z_sum[edges[e].v];
            link_bias[e] = static_cast<float>(su / (su + sv));
            link_str[e] = static_cast<float>(zw / std::min(su, sv));
        }
    }

    // Simulation buffers
    FlatQuadtree qt;
    qt.reserve(N);

    std::vector<double> px_pred(N), py_pred(N);
    std::vector<std::vector<double>> tl_dvx(num_threads, std::vector<double>(N, 0.0));
    std::vector<std::vector<double>> tl_dvy(num_threads, std::vector<double>(N, 0.0));

    // Exact D3 v7 alpha & velocity constants
    double alpha = 1.0;
    const double alpha_min = 0.001;
    const double alpha_decay = 1.0 - std::pow(alpha_min, 1.0 / 300.0);
    const double alpha_target = 0.0;
    const double velocity_factor = 0.6; // 1 - 0.4
    const double center_x = cfg.width * 0.5;
    const double center_y = cfg.height * 0.5;

    std::fprintf(stderr, "[3/4] Running D3 v7 force simulation (%d ticks)...\n", cfg.ticks);
    auto t_sim_start = std::chrono::steady_clock::now();

    for (int tick = 0; tick < cfg.ticks; ++tick) {
        alpha += (alpha_target - alpha) * alpha_decay;

        // 1. forceManyBody (Barnes-Hut quadtree repulsion)
        qt.build(N, x.data(), y.data());
        qt.accumulate_charge(charge.data(), x.data(), y.data());

        if (qt.root != -1) {
            const QTNode* qnodes = qt.tree.data();
            const int32_t* next_l = qt.next_leaf.data();
            const double qx0 = qt.x0;
            const double qy0 = qt.y0;
            const double qsize = qt.size;
            const int32_t qroot = qt.root;

            #pragma omp parallel for schedule(guided, 64)
            for (size_t i = 0; i < N; ++i) {
                const double ni_x = x[i];
                const double ni_y = y[i];
                double acc_vx = 0.0;
                double acc_vy = 0.0;

                struct Frame { int32_t node; double x0, y0, size; };
                Frame stack[128];
                int sp = 0;
                stack[sp++] = {qroot, qx0, qy0, qsize};

                while (sp > 0) {
                    const Frame fr = stack[--sp];
                    const QTNode& q = qnodes[fr.node];
                    if (q.value == 0.0) continue;

                    double dx = q.cx - ni_x;
                    double dy = q.cy - ni_y;
                    double l2 = dx * dx + dy * dy;

                    // Barnes-Hut criterion (exact D3: w*w / theta2 < l2)
                    if (fr.size * fr.size / theta2 < l2) {
                        if (dx == 0.0) { dx = det_jiggle((uint64_t(tick) << 32) ^ (i * 1315423911ULL) ^ fr.node); l2 += dx * dx; }
                        if (dy == 0.0) { dy = det_jiggle((uint64_t(tick) << 32) ^ (i * 2654435761ULL) ^ (fr.node + 7)); l2 += dy * dy; }
                        if (l2 < dist_min2) l2 = std::sqrt(dist_min2 * l2);
                        const double f = q.value * alpha / l2;
                        acc_vx += dx * f;
                        acc_vy += dy * f;
                        continue;
                    }

                    if (q.leaf_idx != -1) {
                        int32_t k = q.leaf_idx;
                        if (k != static_cast<int32_t>(i) || next_l[k] != -1) {
                            if (dx == 0.0) { dx = det_jiggle((uint64_t(tick) << 32) ^ (i * 1315423911ULL) ^ k); l2 += dx * dx; }
                            if (dy == 0.0) { dy = det_jiggle((uint64_t(tick) << 32) ^ (i * 2654435761ULL) ^ (k + 13)); l2 += dy * dy; }
                            if (l2 < dist_min2) l2 = std::sqrt(dist_min2 * l2);
                        }
                        while (k != -1) {
                            if (k != static_cast<int32_t>(i)) {
                                const double f = charge[k] * alpha / l2;
                                acc_vx += dx * f;
                                acc_vy += dy * f;
                            }
                            k = next_l[k];
                        }
                    } else {
                        const double half = fr.size * 0.5;
                        for (int c = 3; c >= 0; --c) {
                            int32_t ch = q.child[c];
                            if (ch != -1) {
                                const double cx0 = (c & 1) ? (fr.x0 + half) : fr.x0;
                                const double cy0 = (c & 2) ? (fr.y0 + half) : fr.y0;
                                stack[sp++] = {ch, cx0, cy0, half};
                            }
                        }
                    }
                }

                vx[i] += acc_vx;
                vy[i] += acc_vy;
            }
        }

        // 2. forceLink
        if (cfg.exact_serial_links || num_threads == 1) {
            for (size_t e = 0; e < E; ++e) {
                const uint32_t u = edges[e].u;
                const uint32_t v = edges[e].v;
                double dx = x[v] + vx[v] - x[u] - vx[u];
                if (dx == 0.0) dx = (rng.next() - 0.5) * 1e-6;
                double dy = y[v] + vy[v] - y[u] - vy[u];
                if (dy == 0.0) dy = (rng.next() - 0.5) * 1e-6;
                double l = std::sqrt(dx * dx + dy * dy);
                l = (l - link_dist) / l * alpha * static_cast<double>(link_str[e]);
                dx *= l;
                dy *= l;
                const double b = static_cast<double>(link_bias[e]);
                vx[v] -= dx * b;
                vy[v] -= dy * b;
                const double mb = 1.0 - b;
                vx[u] += dx * mb;
                vy[u] += dy * mb;
            }
        } else {
            #pragma omp parallel
            {
                int tid = 0;
#ifdef _OPENMP
                tid = omp_get_thread_num();
#endif
                double* dvx = tl_dvx[tid].data();
                double* dvy = tl_dvy[tid].data();
                std::memset(dvx, 0, N * sizeof(double));
                std::memset(dvy, 0, N * sizeof(double));

                #pragma omp for schedule(static)
                for (size_t e = 0; e < E; ++e) {
                    const uint32_t u = edges[e].u;
                    const uint32_t v = edges[e].v;
                    double dx = (x[v] + vx[v]) - (x[u] + vx[u]);
                    if (dx == 0.0) dx = det_jiggle((uint64_t(tick) << 32) ^ e);
                    double dy = (y[v] + vy[v]) - (y[u] + vy[u]);
                    if (dy == 0.0) dy = det_jiggle((uint64_t(tick) << 32) ^ (e + 0x9e3779b9ULL));
                    double l = std::sqrt(dx * dx + dy * dy);
                    l = (l - link_dist) / l * alpha * static_cast<double>(link_str[e]);
                    dx *= l;
                    dy *= l;
                    const double b = static_cast<double>(link_bias[e]);
                    dvx[v] -= dx * b;
                    dvy[v] -= dy * b;
                    const double mb = 1.0 - b;
                    dvx[u] += dx * mb;
                    dvy[u] += dy * mb;
                }
            }

            #pragma omp parallel for schedule(static)
            for (size_t i = 0; i < N; ++i) {
                double sx = 0.0, sy = 0.0;
                for (int t = 0; t < num_threads; ++t) {
                    sx += tl_dvx[t][i];
                    sy += tl_dvy[t][i];
                }
                vx[i] += sx;
                vy[i] += sy;
            }
        }

        // 3. forceCollide (quadtree on predicted positions x+vx, y+vy)
        #pragma omp parallel for schedule(static)
        for (size_t i = 0; i < N; ++i) {
            px_pred[i] = x[i] + vx[i];
            py_pred[i] = y[i] + vy[i];
        }

        qt.build(N, px_pred.data(), py_pred.data());
        qt.accumulate_radius(r_coll.data());

        if (qt.root != -1) {
            const QTNode* qnodes = qt.tree.data();
            const int32_t* next_l = qt.next_leaf.data();
            const double qx0 = qt.x0;
            const double qy0 = qt.y0;
            const double qsize = qt.size;
            const int32_t qroot = qt.root;

            if (cfg.exact_serial_links || num_threads == 1) {
                for (size_t i = 0; i < N; ++i) {
                    const double ri = r_coll[i];
                    const double ri2 = ri * ri;
                    const double xi = x[i] + vx[i];
                    const double yi = y[i] + vy[i];

                    struct Frame { int32_t node; double x0, y0, size; };
                    Frame stack[128];
                    int sp = 0;
                    stack[sp++] = {qroot, qx0, qy0, qsize};

                    while (sp > 0) {
                        const Frame fr = stack[--sp];
                        const QTNode& q = qnodes[fr.node];
                        const double rsum = ri + q.max_r;
                        if (fr.x0 > xi + rsum || (fr.x0 + fr.size) < xi - rsum ||
                            fr.y0 > yi + rsum || (fr.y0 + fr.size) < yi - rsum) {
                            continue;
                        }
                        if (q.leaf_idx != -1) {
                            int32_t k = q.leaf_idx;
                            while (k != -1) {
                                if (k > static_cast<int32_t>(i)) {
                                    const double rk = r_coll[k];
                                    const double r = ri + rk;
                                    double dx = xi - (x[k] + vx[k]);
                                    double dy = yi - (y[k] + vy[k]);
                                    double l2 = dx * dx + dy * dy;
                                    if (l2 < r * r) {
                                        if (dx == 0.0) { dx = (rng.next() - 0.5) * 1e-6; l2 += dx * dx; }
                                        if (dy == 0.0) { dy = (rng.next() - 0.5) * 1e-6; l2 += dy * dy; }
                                        double l = (r - std::sqrt(l2)) / std::sqrt(l2);
                                        dx *= l;
                                        dy *= l;
                                        double rk2 = rk * rk;
                                        double w_r = rk2 / (ri2 + rk2);
                                        vx[i] += dx * w_r;
                                        vy[i] += dy * w_r;
                                        vx[k] -= dx * (1.0 - w_r);
                                        vy[k] -= dy * (1.0 - w_r);
                                    }
                                }
                                k = next_l[k];
                            }
                        } else {
                            const double half = fr.size * 0.5;
                            for (int c = 3; c >= 0; --c) {
                                int32_t ch = q.child[c];
                                if (ch != -1) {
                                    const double cx0 = (c & 1) ? (fr.x0 + half) : fr.x0;
                                    const double cy0 = (c & 2) ? (fr.y0 + half) : fr.y0;
                                    stack[sp++] = {ch, cx0, cy0, half};
                                }
                            }
                        }
                    }
                }
            } else {
                #pragma omp parallel
                {
                    int tid = 0;
#ifdef _OPENMP
                    tid = omp_get_thread_num();
#endif
                    double* dvx = tl_dvx[tid].data();
                    double* dvy = tl_dvy[tid].data();
                    std::memset(dvx, 0, N * sizeof(double));
                    std::memset(dvy, 0, N * sizeof(double));

                    #pragma omp for schedule(guided, 64)
                    for (size_t i = 0; i < N; ++i) {
                        const double ri = r_coll[i];
                        const double ri2 = ri * ri;
                        const double xi = px_pred[i];
                        const double yi = py_pred[i];

                        struct Frame { int32_t node; double x0, y0, size; };
                        Frame stack[128];
                        int sp = 0;
                        stack[sp++] = {qroot, qx0, qy0, qsize};

                        while (sp > 0) {
                            const Frame fr = stack[--sp];
                            const QTNode& q = qnodes[fr.node];
                            const double rsum = ri + q.max_r;
                            if (fr.x0 > xi + rsum || (fr.x0 + fr.size) < xi - rsum ||
                                fr.y0 > yi + rsum || (fr.y0 + fr.size) < yi - rsum) {
                                continue;
                            }
                            if (q.leaf_idx != -1) {
                                int32_t k = q.leaf_idx;
                                while (k != -1) {
                                    if (k > static_cast<int32_t>(i)) {
                                        const double rk = r_coll[k];
                                        const double r = ri + rk;
                                        double dx = xi - px_pred[k];
                                        double dy = yi - py_pred[k];
                                        double l2 = dx * dx + dy * dy;
                                        if (l2 < r * r) {
                                            if (dx == 0.0) { dx = det_jiggle((uint64_t(tick) << 32) ^ (i * 31 + k)); l2 += dx * dx; }
                                            if (dy == 0.0) { dy = det_jiggle((uint64_t(tick) << 32) ^ (k * 31 + i + 17)); l2 += dy * dy; }
                                            double dist = std::sqrt(l2);
                                            double l = (r - dist) / dist;
                                            dx *= l;
                                            dy *= l;
                                            double rk2 = rk * rk;
                                            double w_r = rk2 / (ri2 + rk2);
                                            dvx[i] += dx * w_r;
                                            dvy[i] += dy * w_r;
                                            dvx[k] -= dx * (1.0 - w_r);
                                            dvy[k] -= dy * (1.0 - w_r);
                                        }
                                    }
                                    k = next_l[k];
                                }
                            } else {
                                const double half = fr.size * 0.5;
                                for (int c = 3; c >= 0; --c) {
                                    int32_t ch = q.child[c];
                                    if (ch != -1) {
                                        const double cx0 = (c & 1) ? (fr.x0 + half) : fr.x0;
                                        const double cy0 = (c & 2) ? (fr.y0 + half) : fr.y0;
                                        stack[sp++] = {ch, cx0, cy0, half};
                                    }
                                }
                            }
                        }
                    }
                }

                #pragma omp parallel for schedule(static)
                for (size_t i = 0; i < N; ++i) {
                    double sx = 0.0, sy = 0.0;
                    for (int t = 0; t < num_threads; ++t) {
                        sx += tl_dvx[t][i];
                        sy += tl_dvy[t][i];
                    }
                    vx[i] += sx;
                    vy[i] += sy;
                }
            }
        }

        // 4. forceRadial + Velocity Decay & Position Integration
        const double rad_k = -radial_str * alpha;
        #pragma omp parallel for schedule(static)
        for (size_t i = 0; i < N; ++i) {
            double dx = x[i] - center_x;
            if (dx == 0.0) dx = 1e-6;
            double dy = y[i] - center_y;
            if (dy == 0.0) dy = 1e-6;
            vx[i] += dx * rad_k;
            vy[i] += dy * rad_k;

            vx[i] *= velocity_factor;
            vy[i] *= velocity_factor;
            x[i] += vx[i];
            y[i] += vy[i];
        }

        if ((tick + 1) % 50 == 0 || tick + 1 == cfg.ticks) {
            double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - t_sim_start).count();
            std::fprintf(stderr, "      Tick %3d/%d (alpha=%.5f, elapsed=%.2fs)\n", tick + 1, cfg.ticks, alpha, elapsed);
        }
    }

    auto t_sim_end = std::chrono::steady_clock::now();
    double sec_sim = std::chrono::duration<double>(t_sim_end - t_sim_start).count();

    // Compute coordinate summary
    double minX = x[0], maxX = x[0], minY = y[0], maxY = y[0];
    for (size_t i = 1; i < N; ++i) {
        if (x[i] < minX) minX = x[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] < minY) minY = y[i];
        if (y[i] > maxY) maxY = y[i];
    }
    std::fprintf(stderr, "      Layout finished in %.2fs | bounds x=[%.2f, %.2f], y=[%.2f, %.2f]\n",
                 sec_sim, minX, maxX, minY, maxY);

    std::fprintf(stderr, "[4/4] Writing outputs...\n");

    if (!cfg.out_nodes.empty()) {
        FILE* fn = std::fopen(cfg.out_nodes.c_str(), "wb");
        if (!fn) { std::perror("fopen out-nodes"); return 1; }
        std::setvbuf(fn, io_buf.data(), _IOFBF, io_buf.size());
        std::fprintf(fn, "id\tx\ty\tdeg\tr\n");
        for (size_t i = 0; i < N; ++i) {
            std::fprintf(fn, "%s\t%.2f\t%.2f\t%u\t%.2f\n",
                         node_names[i].c_str(), x[i], y[i], deg[i], r_node[i]);
        }
        std::fclose(fn);
        std::fprintf(stderr, "      Wrote nodes TSV: %s (%zu rows)\n", cfg.out_nodes.c_str(), N);
    }

    if (!cfg.out_edges.empty()) {
        FILE* fe = std::fopen(cfg.out_edges.c_str(), "wb");
        if (!fe) { std::perror("fopen out-edges"); return 1; }
        std::setvbuf(fe, io_buf.data(), _IOFBF, io_buf.size());
        std::fprintf(fe, "Source\tTarget\tWeight\tZ_score\tsign\n");
        for (size_t e = 0; e < E; ++e) {
            const Edge& ed = edges[e];
            const char* sgn_str = ed.sign > 0 ? "+" : (ed.sign < 0 ? "-" : "");
            if (std::isfinite(ed.z_score)) {
                std::fprintf(fe, "%s\t%s\t%.6g\t%.6g\t%s\n",
                             node_names[ed.u].c_str(), node_names[ed.v].c_str(),
                             static_cast<double>(ed.weight), static_cast<double>(ed.z_score), sgn_str);
            } else {
                std::fprintf(fe, "%s\t%s\t%.6g\t\t%s\n",
                             node_names[ed.u].c_str(), node_names[ed.v].c_str(),
                             static_cast<double>(ed.weight), sgn_str);
            }
        }
        std::fclose(fe);
        std::fprintf(stderr, "      Wrote edges TSV: %s (%zu rows)\n", cfg.out_edges.c_str(), E);
    }

    if (!cfg.out_json.empty()) {
        FILE* fj = std::fopen(cfg.out_json.c_str(), "wb");
        if (!fj) { std::perror("fopen out-json"); return 1; }
        std::setvbuf(fj, io_buf.data(), _IOFBF, io_buf.size());
        std::fputs("{\"nodes\":[\n", fj);
        for (size_t i = 0; i < N; ++i) {
            if (i > 0) std::fputs(",\n", fj);
            std::fputs("{\"id\":", fj);
            escape_json_str(fj, node_names[i]);
            std::fprintf(fj, ",\"x\":%.2f,\"y\":%.2f,\"r\":%.2f,\"deg\":%u,\"originalType\":\"Gene\",\"isRogue\":false}",
                         x[i], y[i], r_node[i], deg[i]);
        }
        std::fputs("\n],\"edges\":[\n", fj);
        for (size_t e = 0; e < E; ++e) {
            if (e > 0) std::fputs(",\n", fj);
            const Edge& ed = edges[e];
            std::fputs("{\"source\":", fj);
            escape_json_str(fj, node_names[ed.u]);
            std::fputs(",\"target\":", fj);
            escape_json_str(fj, node_names[ed.v]);
            std::fprintf(fj, ",\"weight\":%.6g", static_cast<double>(ed.weight));
            if (std::isfinite(ed.z_score)) {
                std::fprintf(fj, ",\"z_score\":%.6g", static_cast<double>(ed.z_score));
            } else {
                std::fputs(",\"z_score\":null", fj);
            }
            if (ed.sign > 0) std::fputs(",\"sign\":\"+\"", fj);
            else if (ed.sign < 0) std::fputs(",\"sign\":\"-\"", fj);
            else std::fputs(",\"sign\":null", fj);
            std::fputs(",\"has_interacts\":true}", fj);
        }
        std::fputs("\n]}\n", fj);
        std::fclose(fj);
        std::fprintf(stderr, "      Wrote layout JSON: %s\n", cfg.out_json.c_str());
    }

    double sec_total = std::chrono::duration<double>(std::chrono::steady_clock::now() - t_start).count();
    std::fprintf(stderr, "Done! Total wall time: %.2fs\n", sec_total);
    return 0;
}
