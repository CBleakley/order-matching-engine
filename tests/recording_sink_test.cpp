#include "RecordingSink.h"

#include <sstream>
#include <string>

#include <gtest/gtest.h>

using namespace engine;

namespace {

const OrderAccepted  kAccepted{.id = 1, .seq = 10};
const OrderRejected  kRejected{.id = 2, .reason = RejectReason::InvalidPrice};
const TradeEvent     kTrade{.makerId = 1,
                            .takerId = 3,
                            .buyer = 7,
                            .seller = 8,
                            .price = 10'050,
                            .qty = 5,
                            .aggressorSide = Side::Sell,
                            .seq = 12};
const OrderRested    kRested{.id = 3, .side = Side::Sell, .price = 10'040, .qty = 20};
const OrderCancelled kCancelled{.id = 1, .cancelledQty = 15};

// Feeds one of each event through the EventSink interface, as the engine will.
void emitAll(EventSink& sink) {
    sink.onAccepted(kAccepted);
    sink.onRejected(kRejected);
    sink.onTrade(kTrade);
    sink.onRested(kRested);
    sink.onCancelled(kCancelled);
}

template <typename T>
std::string print(const T& value) {
    std::ostringstream os;
    os << value;
    return os.str();
}

}  // namespace

TEST(RecordingSink, StartsEmpty) {
    RecordingSink sink;
    EXPECT_TRUE(sink.empty());
    EXPECT_EQ(sink.size(), 0u);
}

TEST(RecordingSink, RecordsEventsInOrder) {
    RecordingSink sink;
    emitAll(sink);

    const std::vector<Event> expected{kAccepted, kRejected, kTrade, kRested, kCancelled};
    EXPECT_EQ(sink.events(), expected);
}

TEST(RecordingSink, PreservesOrderOfRepeatedEventTypes) {
    RecordingSink sink;
    TradeEvent second = kTrade;
    second.qty = 2;
    second.seq = 13;
    sink.onTrade(kTrade);
    sink.onRested(kRested);
    sink.onTrade(second);

    const std::vector<Event> expected{kTrade, kRested, second};
    EXPECT_EQ(sink.events(), expected);
}

TEST(RecordingSink, ClearDiscardsEvents) {
    RecordingSink sink;
    emitAll(sink);
    sink.clear();
    EXPECT_TRUE(sink.empty());
}

TEST(RecordingSink, IdenticalRecordingsCompareEqual) {
    RecordingSink a;
    RecordingSink b;
    EXPECT_EQ(a, b);

    emitAll(a);
    emitAll(b);
    EXPECT_EQ(a, b);
}

TEST(RecordingSink, DifferentOrderComparesUnequal) {
    RecordingSink a;
    RecordingSink b;
    a.onAccepted(kAccepted);
    a.onRested(kRested);
    b.onRested(kRested);
    b.onAccepted(kAccepted);
    EXPECT_NE(a, b);
}

TEST(RecordingSink, DifferentLengthComparesUnequal) {
    RecordingSink a;
    RecordingSink b;
    emitAll(a);
    emitAll(b);
    b.onAccepted(kAccepted);
    EXPECT_NE(a, b);
}

TEST(RecordingSink, DifferentFieldValueComparesUnequal) {
    RecordingSink a;
    RecordingSink b;
    a.onTrade(kTrade);
    TradeEvent changed = kTrade;
    changed.aggressorSide = Side::Buy;
    b.onTrade(changed);
    EXPECT_NE(a, b);
}

TEST(RecordingSink, DifferentEventTypeWithSameIdComparesUnequal) {
    RecordingSink a;
    RecordingSink b;
    a.onAccepted(OrderAccepted{.id = 1, .seq = 15});
    b.onCancelled(OrderCancelled{.id = 1, .cancelledQty = 15});
    EXPECT_NE(a, b);
}

TEST(EventPrinting, EachEventPrintsReadably) {
    EXPECT_EQ(print(kAccepted), "Accepted{id=1, seq=10}");
    EXPECT_EQ(print(kRejected), "Rejected{id=2, reason=InvalidPrice}");
    EXPECT_EQ(print(kTrade),
              "Trade{maker=1, taker=3, buyer=7, seller=8, price=10050, qty=5, "
              "aggressor=Sell, seq=12}");
    EXPECT_EQ(print(kRested), "Rested{id=3, side=Sell, price=10040, qty=20}");
    EXPECT_EQ(print(kCancelled), "Cancelled{id=1, cancelledQty=15}");
}

TEST(EventPrinting, SinkPrintsOneEventPerLine) {
    RecordingSink sink;
    sink.onAccepted(kAccepted);
    sink.onCancelled(kCancelled);
    EXPECT_EQ(print(sink),
              "RecordingSink[2 event(s)]\n"
              "  [0] Accepted{id=1, seq=10}\n"
              "  [1] Cancelled{id=1, cancelledQty=15}");
}

TEST(EventPrinting, GoogleTestUsesEventPrinters) {
    const Event event = kRested;
    EXPECT_NE(::testing::PrintToString(event).find("Rested{id=3"), std::string::npos);
}
