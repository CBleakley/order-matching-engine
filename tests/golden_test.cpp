#include <gtest/gtest.h>

#include <algorithm>
#include <cstddef>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

#include "Repl.h"

// Golden tests for the CLI. Each tests/golden/<name>.in is a script of
// commands; it is run through the REPL (with input echoed) and the transcript
// must match <name>.expected exactly.
//
// To regenerate the expected files after an intended output change, run the
// tests with GOLDEN_UPDATE=1 and review the diff before committing.

namespace {

namespace fs = std::filesystem;

const fs::path kGoldenDir = GOLDEN_DIR;

// Reads a file as text with '\n' line endings, whatever the checkout uses.
std::string readFile(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    std::ostringstream contents;
    contents << in.rdbuf();
    std::string text = contents.str();
    std::erase(text, '\r');
    return text;
}

void writeFile(const fs::path& path, const std::string& text) {
    std::ofstream out(path, std::ios::binary);
    out << text;
}

std::vector<std::string> splitLines(const std::string& text) {
    std::vector<std::string> lines;
    std::istringstream in(text);
    for (std::string line; std::getline(in, line);) lines.push_back(line);
    return lines;
}

// Line diff of expected vs actual, from a longest-common-subsequence
// alignment. Shows changed lines with two lines of context around them.
std::string diffLines(const std::string& expectedText, const std::string& actualText) {
    const std::vector<std::string> a = splitLines(expectedText);
    const std::vector<std::string> b = splitLines(actualText);

    // lcs[i][j] = LCS length of a[i..] and b[j..].
    std::vector<std::vector<std::size_t>> lcs(a.size() + 1, std::vector<std::size_t>(b.size() + 1));
    for (std::size_t i = a.size(); i-- > 0;) {
        for (std::size_t j = b.size(); j-- > 0;) {
            lcs[i][j] = a[i] == b[j] ? lcs[i + 1][j + 1] + 1 : std::max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    struct Row {
        char        tag;  // ' ', '-' (expected only) or '+' (actual only)
        std::size_t line;  // 1-based line number in its own file
        std::string text;
    };
    std::vector<Row> rows;
    std::size_t i = 0, j = 0;
    while (i < a.size() || j < b.size()) {
        if (i < a.size() && j < b.size() && a[i] == b[j]) {
            rows.push_back({' ', j + 1, a[i]});
            ++i, ++j;
        } else if (i < a.size() && (j == b.size() || lcs[i + 1][j] >= lcs[i][j + 1])) {
            rows.push_back({'-', i + 1, a[i]});
            ++i;
        } else {
            rows.push_back({'+', j + 1, b[j]});
            ++j;
        }
    }

    constexpr std::size_t kContext = 2;
    std::vector<bool> show(rows.size(), false);
    for (std::size_t r = 0; r < rows.size(); ++r) {
        if (rows[r].tag == ' ') continue;
        const std::size_t from = r >= kContext ? r - kContext : 0;
        const std::size_t to   = std::min(rows.size(), r + kContext + 1);
        std::fill(show.begin() + static_cast<std::ptrdiff_t>(from),
                  show.begin() + static_cast<std::ptrdiff_t>(to), true);
    }

    std::ostringstream out;
    out << "--- expected\n+++ actual\n";
    bool skipped = false;
    for (std::size_t r = 0; r < rows.size(); ++r) {
        if (!show[r]) {
            skipped = true;
            continue;
        }
        if (skipped) out << "  ...\n";
        skipped = false;
        out << rows[r].tag << ' ' << std::setw(4) << rows[r].line << " | " << rows[r].text << '\n';
    }
    return out.str();
}

bool updateRequested() {
    const char* value = std::getenv("GOLDEN_UPDATE");
    return value != nullptr && std::string(value) == "1";
}

std::vector<std::string> goldenCases() {
    std::vector<std::string> names;
    for (const auto& entry : fs::directory_iterator(kGoldenDir)) {
        if (entry.path().extension() == ".in") names.push_back(entry.path().stem().string());
    }
    std::sort(names.begin(), names.end());
    return names;
}

class GoldenTest : public ::testing::TestWithParam<std::string> {};

TEST_P(GoldenTest, MatchesExpectedTranscript) {
    const fs::path input    = kGoldenDir / (GetParam() + ".in");
    const fs::path expected = kGoldenDir / (GetParam() + ".expected");

    std::istringstream in(readFile(input));
    std::ostringstream out;
    runRepl(in, out, {.echo = true});
    const std::string actual = out.str();

    if (updateRequested()) {
        writeFile(expected, actual);
        GTEST_SKIP() << "updated " << expected.string();
    }

    ASSERT_TRUE(fs::exists(expected))
        << expected.string() << " is missing; run with GOLDEN_UPDATE=1 to create it";
    const std::string want = readFile(expected);
    if (actual != want) {
        ADD_FAILURE() << "CLI output differs from " << expected.string() << ":\n"
                      << diffLines(want, actual);
    }
}

INSTANTIATE_TEST_SUITE_P(Cli, GoldenTest, ::testing::ValuesIn(goldenCases()),
                         [](const ::testing::TestParamInfo<std::string>& info) {
                             return info.param;
                         });

}  // namespace
