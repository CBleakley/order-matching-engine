## Basic Requirements

- Accept buy/sell orders
- Maintain order book
- Match orders
- Execute trades
- Maintain trade history

## Matching Principle: Price-Time Priority
Higher-priced buys get priority, lower-priced sell get priority, and orders at the same price are filled in arrival order.

## Technical Requirements
When an order arrives we need to quickly check, is there a match? If so, which match was the first to arrive?

We need to be able to query the highest/lowest price in the book and maintain the order of arival of orders at the same price.

## First Proposal
We use a map from the C++ standard library where the keys are prices and the values are queues.
This provides O(1) finding the queue associated with the highest/lowest price and O(log n) to retrieve the order that was first to arrive.

