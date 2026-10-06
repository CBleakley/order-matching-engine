#include <gtest/gtest.h>

#include <cstddef>
#include <variant>

#include "DifferentialHarness.h"
#include "RandomOrderFlow.h"

namespace engine {
namespace {

bool sameOp(const flow::Operation& a, const flow::Operation& b) {
    if (a.index() != b.index()) return false;
    if (const auto* s = std::get_if<flow::SubmitOp>(&a)) {
        const auto& t = std::get<flow::SubmitOp>(b);
        return s->id == t.id && s->trader == t.trader && s->side == t.side &&
               s->price == t.price && s->qty == t.qty;
    }
    return std::get<flow::CancelOp>(a).id == std::get<flow::CancelOp>(b).id;
}

// Generates `n` operations from `seed`, applied to a real book so the
// generator sees resting orders, and counts how they turn out.
struct FlowStats {
    std::size_t submits = 0, cancels = 0, rejectedSubmits = 0, rejectedCancels = 0, trades = 0;
};

class CountingSink : public EventSink {
public:
    void onRejected(const OrderRejected&) override { ++rejected; }
    void onTrade(const TradeEvent&) override { ++trades; }
    std::size_t rejected = 0, trades = 0;
};

FlowStats runFlow(std::uint64_t seed, const flow::OrderFlowConfig& config, std::size_t n) {
    flow::RandomOrderFlow gen(seed, config);
    CountingSink counts;
    TeeSink      sink(counts, gen);
    OrderBook    book(sink);

    FlowStats stats;
    for (std::size_t i = 0; i < n; ++i) {
        const flow::Operation op = gen.next();
        const std::size_t rejectedBefore = counts.rejected;
        flow::RandomOrderFlow::apply(book, op);
        const bool rejected = counts.rejected != rejectedBefore;
        if (std::holds_alternative<flow::SubmitOp>(op)) {
            ++stats.submits;
            stats.rejectedSubmits += rejected;
        } else {
            ++stats.cancels;
            stats.rejectedCancels += rejected;
        }
    }
    stats.trades = counts.trades;
    return stats;
}

TEST(RandomOrderFlow, SameSeedGivesSameOperations) {
    // Without feedback the stream is purely a function of the seed.
    flow::RandomOrderFlow a(7, {});
    flow::RandomOrderFlow b(7, {});
    for (int i = 0; i < 1000; ++i) ASSERT_TRUE(sameOp(a.next(), b.next())) << "op " << i;
}

TEST(RandomOrderFlow, DifferentSeedsGiveDifferentOperations) {
    flow::RandomOrderFlow a(7, {});
    flow::RandomOrderFlow b(8, {});
    int differing = 0;
    for (int i = 0; i < 100; ++i) differing += !sameOp(a.next(), b.next());
    EXPECT_GT(differing, 50);
}

TEST(RandomOrderFlow, ProducesAMixOfOutcomes) {
    const FlowStats stats = runFlow(3, {}, 20'000);

    // Roughly 30% cancels once the book has orders in it.
    EXPECT_GT(stats.cancels, 4'000u);
    EXPECT_GT(stats.submits, 12'000u);
    EXPECT_GT(stats.trades, 1'000u);

    // About 1% of submits are invalid, and about 5% of cancels target unknown
    // IDs; the rest of the cancels hit resting orders.
    EXPECT_GT(stats.rejectedSubmits, 0u);
    EXPECT_LT(stats.rejectedSubmits, stats.submits / 20);
    EXPECT_GT(stats.rejectedCancels, 0u);
    EXPECT_LT(stats.rejectedCancels, stats.cancels / 10);
}

}  // namespace
}  // namespace engine
