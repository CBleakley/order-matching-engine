#include <gtest/gtest.h>

#include <sstream>
#include <vector>

#include "ConsoleSink.h"

namespace {

engine::TradeEvent tradeWithSeq(engine::SeqNum seq) {
    return engine::TradeEvent{1, 2, 0, 0, 100, 1, engine::Side::Buy, seq};
}

std::vector<engine::SeqNum> seqs(const TradeHistory& history) {
    std::vector<engine::SeqNum> out;
    history.forEach([&out](const engine::TradeEvent& t) { out.push_back(t.seq); });
    return out;
}

TEST(TradeHistory, StartsEmpty) {
    const TradeHistory history(3);
    EXPECT_EQ(history.size(), 0u);
    EXPECT_EQ(history.capacity(), 3u);
    EXPECT_TRUE(seqs(history).empty());
}

TEST(TradeHistory, KeepsTradesOldestFirstBeforeFull) {
    TradeHistory history(3);
    history.push(tradeWithSeq(1));
    history.push(tradeWithSeq(2));
    EXPECT_EQ(seqs(history), (std::vector<engine::SeqNum>{1, 2}));
}

TEST(TradeHistory, ExactlyFull) {
    TradeHistory history(3);
    for (engine::SeqNum s = 1; s <= 3; ++s) history.push(tradeWithSeq(s));
    EXPECT_EQ(history.size(), 3u);
    EXPECT_EQ(seqs(history), (std::vector<engine::SeqNum>{1, 2, 3}));
}

TEST(TradeHistory, WrapsAndDropsOldest) {
    TradeHistory history(3);
    for (engine::SeqNum s = 1; s <= 7; ++s) history.push(tradeWithSeq(s));
    EXPECT_EQ(history.size(), 3u);
    EXPECT_EQ(seqs(history), (std::vector<engine::SeqNum>{5, 6, 7}));
}

TEST(TradeHistory, ZeroCapacityKeepsNothing) {
    TradeHistory history(0);
    history.push(tradeWithSeq(1));
    EXPECT_EQ(history.size(), 0u);
    EXPECT_TRUE(seqs(history).empty());
}

TEST(ConsoleSink, RecordsTradesItPrints) {
    TraderRegistry traders;
    traders.idFor("alice");
    std::ostringstream out;
    ConsoleSink sink(out, traders, 2);

    sink.onTrade(tradeWithSeq(1));
    sink.onTrade(tradeWithSeq(2));
    sink.onTrade(tradeWithSeq(3));

    EXPECT_EQ(seqs(sink.history()), (std::vector<engine::SeqNum>{2, 3}));
    EXPECT_EQ(out.str(),
              "Trade: 1 @ 100, buyer=alice, seller=alice (maker #1, taker #2)\n"
              "Trade: 1 @ 100, buyer=alice, seller=alice (maker #1, taker #2)\n"
              "Trade: 1 @ 100, buyer=alice, seller=alice (maker #1, taker #2)\n");
}

}  // namespace
