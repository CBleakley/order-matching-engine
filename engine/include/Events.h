#pragma once

#include "Types.h"

// Events emitted by the engine, and the interface for receiving them. The
// engine reports all of its behaviour through an EventSink rather than doing
// any I/O itself. Like Types.h, this header must stay free of I/O.

namespace engine {

struct OrderAccepted {
    OrderId id;
    SeqNum  seq;

    bool operator==(const OrderAccepted&) const = default;
};

struct OrderRejected {
    OrderId      id;
    RejectReason reason;

    bool operator==(const OrderRejected&) const = default;
};

struct TradeEvent {
    OrderId  makerId;
    OrderId  takerId;
    TraderId buyer;
    TraderId seller;
    Price    price;  // always the resting (maker) order's price
    Quantity qty;
    Side     aggressorSide;
    SeqNum   seq;

    bool operator==(const TradeEvent&) const = default;
};

struct OrderRested {
    OrderId  id;
    Side     side;
    Price    price;
    Quantity qty;

    bool operator==(const OrderRested&) const = default;
};

struct OrderCancelled {
    OrderId  id;
    Quantity cancelledQty;

    bool operator==(const OrderCancelled&) const = default;
};

// Receives engine events. All handlers default to no-ops so sinks only
// override the events they care about.
class EventSink {
public:
    virtual ~EventSink() = default;

    virtual void onAccepted(const OrderAccepted&) {}
    virtual void onRejected(const OrderRejected&) {}
    virtual void onTrade(const TradeEvent&) {}
    virtual void onRested(const OrderRested&) {}
    virtual void onCancelled(const OrderCancelled&) {}
};

}  // namespace engine
